import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildVoucherCollectionRequest,
  buildVoucherRegisterRequest,
  buildVoucherTypeListRequest,
  UNSCOPED,
} from '../tally/requests.js';
import { addDaysIso, bookYearFor, type DateRange } from '../utils/dates.js';
import { normalizeVouchers, normalizeVoucherTypes, type Voucher } from '../tally/normalize.js';
import { matchesVoucherFilters } from './voucherFilters.js';
import { TallyError } from '../tally/TallyError.js';
import {
  allFieldsSchema,
  companySchema,
  dateRangeSchema,
  paginationSchema,
  periodNote,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
  EMPTY_RESULT_CAVEAT,
} from '../schemas/common.js';
import {
  DEFAULT_PAGE_SIZE,
  FIELD_HEAVY_PAGE_SIZE,
  paginate,
  resolvePagination,
} from '../utils/pagination.js';
import { foldUniformFields, uniformFieldsNote } from '../utils/uniformFields.js';
import {
  assertCompanyIsLoaded,
  assertResultSetFits,
  companyNamed,
  fromPage,
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolveCompanyCurrency,
  resolvePeriodForCompany,
  runTool,
  whole,
  type ToolDeps,
} from './toolResult.js';

/**
 * `tally_get_vouchers`: list, search and exact-fetch-by-number over vouchers
 * — one tool, since a list is a search with no filters and a get-by-number is
 * a search that happens to be unambiguous.
 *
 * SOURCES, one per book year. The CURRENT financial year comes from a `Voucher`
 * COLLECTION; any earlier year comes from the `Voucher Register` REPORT. Never
 * `DayBook`, which returns 617 bytes and no vouchers at all.
 *
 * The split is forced by Tally: a collection cannot be moved off the current
 * financial year by any static variable, so prior years were entirely
 * unreachable through it, while the report honours a date range. It is safe to
 * mix them because they were verified to agree — over one common period both
 * returned 284 vouchers, 985 entries, identical GUIDs and the same total to the
 * paisa. See `fetchAcrossBookYears` and `buildVoucherRegisterRequest`.
 *
 * (An earlier note here said the register returns headers with no entries. That
 * was measured without a date range; with one it carries the full entry lists.)
 *
 * EVERYTHING is filtered client-side over a full fetch of each year, dates
 * included: Tally applies no filtering, and a collection applies no date scoping
 * either. So no parameter here makes the query cheaper within a year — though a
 * range confined to fewer book years does mean fewer, smaller fetches.
 */

const NARROW_HINT =
  'Add a filter, or ask for a smaller page. TallyPrime does not scope a voucher query by date or ' +
  'filter it server-side, so the whole book is fetched and narrowed here — a shorter date range ' +
  'reduces what is RETURNED, not what Tally has to send.';

const PERIOD_NOTE = periodNote(
  'The date range selects which vouchers are reported, but does NOT make the query cheaper: ' +
    'TallyPrime sends the whole book regardless and it is narrowed here.'
);

const AMOUNT_NOTE =
  'AMOUNTS AND SIDES: each entry carries the amount exactly as Tally reports it (debits arrive ' +
  'negative) plus the side Tally assigned it. Entries of a voucher sum to zero.';

/**
 * A voucher *family* — every type deriving from a built-in base type, not a
 * particular type name. A company can define its own voucher types ("GST
 * Sales", "Tax Invoice", "Export Sales"), each deriving from the built-in
 * `Sales` type. Filtering on the type name containing "sales" would silently
 * miss "Tax Invoice" and under-report, which in an audit is worse than
 * failing. So the type list is fetched from Tally and matched on `Parent`,
 * the base type, which is authoritative — and the resolved names are echoed
 * back in the response as `voucherTypesIncluded`.
 */
interface FamilySpec {
  /** Base voucher type in Tally, matched against VoucherType Parent. */
  family: string;
  meaning: string;
}

const FAMILIES: Record<'sales' | 'purchases', FamilySpec> = {
  sales: {
    family: 'Sales',
    meaning:
      'Vouchers in the Sales family — every voucher type deriving from the built-in Sales type, ' +
      'including company-specific types such as "GST Sales" or "Tax Invoice".',
  },
  purchases: {
    family: 'Purchase',
    meaning:
      'Vouchers in the Purchase family — every voucher type deriving from the built-in Purchase ' +
      'type, including company-specific ones.',
  },
};

const familySchema = z
  .enum(['sales', 'purchases'])
  .describe(
    'Restrict to a trading family instead of an exact voucherType: "sales" or "purchases" ' +
      'includes every company-specific type deriving from that built-in base type (e.g. "Tax ' +
      'Invoice" derives from Sales). Combine with other filters to narrow further.'
  );

const DESCRIPTION = [
  'Vouchers (transactions) in a period: list, search by filter, restrict to a trading family, or ' +
    'fetch by exact voucher number — one call, one mode, picked by which parameters are given.',
  '',
  'WHEN TO USE: to examine individual transactions. If the answer is a TOTAL or a trend rather ' +
    'than a list, use tally_summarise_movements instead — it is far smaller and does the ' +
    'arithmetic exactly.',
  '',
  'MODES:',
  '- voucherNumber: fetch vouchers with that exact number (case-insensitive) in the period. ' +
    'Numbers are only unique per type and period, so ALL matches are returned rather than an ' +
    'arbitrary one. Fails with TALLY_COMPANY_NOT_FOUND if none match.',
  // Each filter documents its own semantics on its own parameter, which is
  // where Claude reads them when filling the call in. What stays here is what
  // has no parameter to live on: which filter to REACH FOR, and the two
  // consequences that are not properties of any one of them.
  '- any of family/query/voucherType/ledger/party/narration/fieldMatch/minAmount/maxAmount: ' +
    'search, applying every filter as an AND. All text matching is case-insensitive substring.',
  '  - Breadth, widest first: "query" spans several fields, "ledger" any entry account, "party" ' +
    'the counterparty alone, "narration" the narration alone. Reach for "fieldMatch" when the ' +
    'field NAME differs between companies, and for "family" over "voucherType" wherever the ' +
    'company may have renamed a built-in type.',
  '  - No total is returned for a family search: which entry represents "the sale" — party side, ' +
    'revenue net of tax, or gross — is an interpretation, not a fact.',
  '  - A voucher whose amounts are all unreadable is KEPT rather than scored as zero, so the ' +
    'population stays complete.',
  '- none given: list every voucher in the period.',
  '',
  'RETURNS: per voucher — date, type, number, party ledger, narration, cancelled/optional flags, ' +
    'and every ledger entry with its amount and side. With "family", the resolved type names ' +
    'matched are echoed back as "voucherTypesIncluded" — check it if a count looks wrong.',
  '',
  AMOUNT_NOTE,
  '',
  'FIELDS ARE IN TWO PLACES. With includeAllFields on, any field holding the SAME value on every ' +
    'voucher in the page is reported once as `uniformFields` at the response level, and the same ' +
    'for entries via `uniformEntryFields`. So check there before concluding a field is absent — it ' +
    'was relocated, not dropped. Treat a value constant across every record as a TallyPrime ' +
    'default rather than something this company recorded.',
  '',
  PERIOD_NOTE,
  '',
  'PAGINATION: client-side over a full fetch, in every mode. A small pageSize does NOT make the ' +
    'call cheap.',
  '',
  'A family search returns nothing if the company records no vouchers of that family in the ' +
    'period. That is a real answer, not a failure. ' +
    EMPTY_RESULT_CAVEAT,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/**
 * Resolve which voucher type names belong to a family.
 *
 * Falls back to the family name itself if Tally reports no type list, so the
 * tool degrades to the built-in type rather than matching nothing at all.
 */
async function resolveFamilyTypes(
  deps: ToolDeps,
  company: string | undefined,
  family: string
): Promise<{ types: Set<string>; warnings: string[] }> {
  const response = await deps.client.send(
    buildVoucherTypeListRequest({ company: company ?? UNSCOPED }),
    'standard'
  );
  const { data, warnings } = normalizeVoucherTypes(response.body);

  const target = family.toLowerCase();
  const types = new Set<string>();

  for (const type of data) {
    if ((type.parent ?? '').toLowerCase() === target || type.name.toLowerCase() === target) {
      types.add(type.name.toLowerCase());
    }
  }

  if (types.size === 0) {
    types.add(target);
    warnings.push(
      `TallyPrime reported no voucher types deriving from "${family}", so only the built-in "${family}" type was matched. If this company uses a custom type name, check tally_get_company.`
    );
  }

  return { types, warnings: [...response.repairs, ...warnings] };
}

/**
 * Parsed vouchers, memoised per client for the configured cache TTL.
 *
 * TallyClient already caches the raw HTTP response, which removes the round trip
 * — measured live, a repeat register request goes from 5,787ms to 0ms. What it
 * does NOT remove is the cost of turning 21MB of XML into records again, and that
 * was measured at **1,205ms every single time**. On a real audit sequence the
 * register was parsed five times over for five different questions: bank
 * reconciliation, outstanding, GST, inventory movements and the voucher list
 * itself. Five seconds of CPU spent producing an answer already in memory.
 *
 * Keyed on the client instance rather than held module-wide, so two servers (or
 * two tests) in one process cannot see each other's vouchers. `allFields` is part
 * of the key because a lean parse omits the field maps and cannot serve a
 * full-detail request.
 */
const parsedVoucherCache = new WeakMap<
  object,
  Map<string, { at: number; value: { vouchers: Voucher[]; warnings: string[] } }>
>();

/**
 * Restrict the fetched book to the requested period.
 *
 * Tally applies no date scoping to a voucher collection — see
 * `buildVoucherCollectionRequest` — so this is the only thing that makes a
 * period mean anything. ISO dates compare correctly as strings, so no parsing
 * is needed.
 *
 * A voucher whose date Tally reported unreadably is KEPT, with a warning. It
 * cannot be placed in or out of the period, and dropping it would quietly
 * shrink the population a control is asserted over.
 */
function filterByPeriod(
  vouchers: readonly Voucher[],
  period: { fromDate: string; toDate: string },
  warnings: string[]
): Voucher[] {
  let undated = 0;

  const kept = vouchers.filter((voucher) => {
    if (voucher.date === null) {
      undated += 1;
      return true;
    }
    return voucher.date >= period.fromDate && voucher.date <= period.toDate;
  });

  if (undated > 0) {
    warnings.push(
      `${String(undated)} voucher(s) carry a date TallyPrime did not report readably. They are included because they cannot be placed inside or outside ${period.fromDate} to ${period.toDate}, so figures over this period may cover transactions outside it.`
    );
  }

  return kept;
}

/**
 * Fetch vouchers across however many book years the requested period spans.
 *
 * ## The problem
 *
 * A Voucher collection is pinned to the company's CURRENT financial year and
 * cannot be moved off it — `SVFROMDATE`/`SVTODATE`, `SVCURRENTDATE` and
 * `SVCURRENTPERIOD` were each measured live and every one returned the same
 * current-year vouchers. So asking for FY2023-24 returned FY2026-27's data, the
 * local period filter then discarded all of it, and the caller received an empty
 * list. For an auditor that reads as "this year had no transactions".
 *
 * ## The route
 *
 * `Voucher Register` is a report, and reports DO honour the range. It carries
 * full ledger entries and parses with the same normaliser, and over a common
 * period the two sources were verified identical — same vouchers, same entries,
 * same total to the paisa. See `buildVoucherRegisterRequest`.
 *
 * ## Why one request per book year
 *
 * The report is roughly 50x the payload of the collection. Measured on MUDALS:
 * 880KB for a sparse year, 39MB for the next, 79MB and 103 seconds for the one
 * after — and a single request for the whole five-year span TIMED OUT. So the
 * span is split on book-year boundaries and fetched a year at a time, which also
 * lets each year be cached, retried and reported on independently.
 *
 * The CURRENT year still comes from the collection: it is the cheaper source for
 * identical data, and it is the long-proven path.
 *
 * ## Partial failure is reported, never hidden
 *
 * A year that fails does not fail the call — the other years are real data and an
 * auditor should have them. But the answer then says exactly which years are
 * missing and that totals exclude them. Silently returning the years that
 * happened to load would be a complete-looking answer over an incomplete
 * population, which is the failure this connector treats as the serious one.
 */
async function fetchAcrossBookYears(
  deps: ToolDeps,
  input: {
    canonicalCompany: string | undefined;
    period: DateRange;
    allFields: boolean;
    nested: boolean;
    currency: string;
  }
): Promise<{ data: Voucher[]; warnings: string[]; repairs: string[] }> {
  const { canonicalCompany, period, allFields, nested, currency } = input;

  const company = await companyNamed(deps, canonicalCompany);
  const currentYear =
    company?.startingFrom == null
      ? null
      : bookYearFor(company.startingFrom, company.endingAt ?? company.startingFrom);

  const years = bookYearsSpanning(period, company?.startingFrom ?? null, currentYear);

  const warnings: string[] = [];
  const repairs: string[] = [];
  const collected: Voucher[] = [];
  const failed: string[] = [];
  let priorYearsFetched = 0;

  for (const year of years) {
    /*
     * The report is for years strictly BEFORE the current one, and nothing else.
     *
     * Deliberately not "the year that equals the current one". A period may sit
     * AFTER the company's last recorded date — a caller asking about the year in
     * progress on books that stop in July, or simply the defaulted period on a
     * dormant company. Tally serves those from the collection exactly as it
     * always has, and routing them to a 50x-larger report would be a large
     * regression to fix nothing.
     *
     * So the collection stays the default and the report is the exception, which
     * also keeps every existing path byte-identical to what it was.
     */
    const usesCollection = currentYear === null || year.toDate >= currentYear.fromDate;

    const request = usesCollection
      ? buildVoucherCollectionRequest(
          {
            company: canonicalCompany ?? UNSCOPED,
            fromDate: year.fromDate,
            toDate: year.toDate,
            format: deps.config.tallyPreferredFormat,
          },
          allFields
        )
      : buildVoucherRegisterRequest({
          company: canonicalCompany ?? UNSCOPED,
          fromDate: year.fromDate,
          toDate: year.toDate,
          // XML only. The report path has never been observed under the JSON
          // export switch, and a wire format whose shape has not been seen is
          // not something to discover on a prior-year audit fetch.
          format: 'xml',
        });

    try {
      const response = await deps.client.send(request, 'report');
      const parsed = normalizeVouchers(response.body, allFields, currency, nested);
      collected.push(...parsed.data);
      warnings.push(...parsed.warnings);
      repairs.push(...response.repairs);
      if (!usesCollection) priorYearsFetched += 1;
    } catch (error) {
      // One year failing must not lose the others, but it must not be silent.
      failed.push(`${year.fromDate}..${year.toDate}`);
      deps.logger.warn('a book year could not be fetched', {
        year: year.fromDate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failed.length > 0) {
    warnings.unshift(
      `INCOMPLETE POPULATION: ${String(failed.length)} of the ${String(years.length)} book year(s) ` +
        `your period covers could not be fetched (${failed.join(', ')}). Every figure here ` +
        'EXCLUDES those years, so totals, counts and any test run over this population are ' +
        'understated by an unknown amount — do not present them as covering the period you ' +
        'asked for. A prior year is read from a large report (tens of megabytes) and a timeout ' +
        'is the usual cause; retry that year on its own, or raise TALLY_REPORT_TIMEOUT_MS.'
    );
  }

  if (priorYearsFetched > 0) {
    const scope =
      years.length === 1
        ? 'this period lies in a book year outside the one TallyPrime serves directly'
        : `this period spans ${String(years.length)} book years, ` +
          `${String(priorYearsFetched)} of them outside the year TallyPrime serves directly`;

    warnings.push(
      `PRIOR YEARS INCLUDED: ${scope}. ` +
        "Those were read from TallyPrime's Voucher Register report, one year per request, " +
        'because a voucher collection cannot leave the current financial year. The two sources ' +
        'were verified to return identical vouchers, entries and totals over a common period, ' +
        'so the figures are comparable across years.'
    );
  }

  return { data: dedupeVouchers(collected), warnings, repairs };
}

/**
 * The book years a period touches, oldest first.
 *
 * Anchored on the company's own book-year start, so a calendar-year company
 * splits on 1 January and an Indian one on 1 April. Falls back to the current
 * year alone when the anchor is unknown, which keeps the previous behaviour
 * rather than inventing a split.
 */
function bookYearsSpanning(
  period: DateRange,
  startingFrom: string | null,
  currentYear: DateRange | null
): DateRange[] {
  if (startingFrom === null || currentYear === null) {
    return [currentYear ?? period];
  }

  const years: DateRange[] = [];
  let cursor = bookYearFor(startingFrom, period.fromDate);

  // Bounded rather than `while (true)`: a malformed period must not spin. Fifty
  // years is far past any real set of books and still terminates immediately.
  for (let guard = 0; guard < 50; guard++) {
    years.push(cursor);
    if (cursor.toDate >= period.toDate) break;
    // One day past this year's end lands in the next year.
    const next = bookYearFor(startingFrom, addDaysIso(cursor.toDate, 1));
    if (next.fromDate <= cursor.fromDate) break;
    cursor = next;
    // Never fetch beyond the year Tally itself is sitting in.
    if (cursor.fromDate > currentYear.fromDate) break;
  }

  return years;
}

/**
 * Drop vouchers seen twice, keeping the first.
 *
 * Book-year windows do not overlap, so in principle nothing repeats. This is
 * here because the consequence of being wrong is a DOUBLE-COUNTED voucher in a
 * total, which is both plausible-looking and exactly the sort of error an
 * auditor would carry into a file. Keyed on GUID, which Tally supplies per
 * voucher; anything without one is kept as-is rather than merged on a weaker key.
 */
function dedupeVouchers(vouchers: readonly Voucher[]): Voucher[] {
  const seen = new Set<string>();
  const out: Voucher[] = [];

  for (const voucher of vouchers) {
    const guid = voucher.guid;
    if (guid === null || guid === undefined || guid === '') {
      out.push(voucher);
      continue;
    }
    if (seen.has(guid)) continue;
    seen.add(guid);
    out.push(voucher);
  }

  return out;
}

/**
 * Warn when TallyPrime did not send vouchers for the period that was asked for.
 *
 * ## Why this exists
 *
 * A voucher collection is scoped by TallyPrime to the **current financial year**,
 * whatever `SVFROMDATE`/`SVTODATE` are set to. Verified live on 2026-08-14
 * against a company whose books run 2021-04-01 to 2026-07-28: a request for
 * 2021-04-01 to 2026-07-28 returned 284 vouchers dated 2026-04 to 2026-07, and a
 * request for FY 2023-24 returned the same current-year vouchers. The history is
 * real — `Profit and Loss` reports actual FY 2023-24 expenses — so those five
 * years are unreachable by this route, not absent.
 *
 * Without this warning the failure is silent and total: the local period filter
 * then discards every returned voucher as out of range, and the caller receives
 * an empty list carrying `hasMore: false` and `truncated: false`. Every
 * completeness signal the server has says "there is nothing there", when the
 * truth is "this period could not be read". Those are opposite answers, and an
 * auditor acting on the first one would conclude a year had no transactions.
 *
 * ## What it does and does not claim
 *
 * It reports a **measurement**, not a rule: the span Tally actually sent against
 * the span requested. That distinction matters, because "Tally truncated" and
 * "this company genuinely has no transactions that early" are indistinguishable
 * from a single response. So the wording states what came back, names the
 * verified cause as the likely explanation, and explicitly refuses to let a zero
 * be read as "none exist".
 *
 * ## When it stays silent, and why that is deliberate
 *
 * It warns on exactly two evidenced conditions:
 *
 *  1. **The returned span does not overlap the request at all.** Unambiguous, and
 *     the dangerous one: the caller's list is empty for a reason unrelated to
 *     their question.
 *  2. **Tally returned vouchers OUTSIDE the requested window**, and the window
 *     also extends beyond what came back. Sending data nobody asked for is proof
 *     that the date range was ignored, so the span is Tally's choice rather than
 *     ours — and anything earlier than it is therefore unreachable rather than
 *     absent.
 *
 * It stays silent when the first returned voucher merely falls a few days after
 * `fromDate`. Asking 1 April to 31 July and finding the first transaction on
 * 5 April is ordinary sparse data, and warning about it would fire on nearly
 * every query. A warning that fires constantly is worse than none, because it
 * trains the reader to skip the one that matters.
 *
 * **Known residual gap, stated rather than hidden.** A request wholly containing
 * the returned span — asking 2025-04-01 to 2026-07-31 and receiving only
 * 2026-04-01 onwards — satisfies neither condition, because nothing arrived
 * outside the window to prove the range was ignored. That case is genuinely
 * indistinguishable from a company with no transactions in the earlier year. It
 * becomes detectable once the company's own financial-year start is available
 * (the A1 fix), since the truncation always begins the span exactly on a
 * financial-year boundary; until then this function under-reports rather than
 * guesses.
 */
export function describeVoucherReachShortfall(
  /** Every voucher Tally sent, BEFORE the local period filter. */
  all: readonly Voucher[],
  period: { fromDate: string; toDate: string }
): string | null {
  const dated = all.map((voucher) => voucher.date).filter((date): date is string => date !== null);

  // Nothing dated came back at all: there is no span to compare, and an empty
  // company is a perfectly ordinary reason for that. Silence is correct here —
  // claiming a shortfall on no evidence would be its own inaccuracy.
  if (dated.length === 0) return null;

  const earliest = dated.reduce((a, b) => (a < b ? a : b));
  const latest = dated.reduce((a, b) => (a > b ? a : b));

  // Does what came back overlap the request at all? An empty overlap is the
  // dangerous case, because the caller's list will be empty for a reason that
  // has nothing to do with their question.
  const overlaps = earliest <= period.toDate && latest >= period.fromDate;

  // The requested window reaches past what arrived, in either direction.
  const windowExceedsData = period.fromDate < earliest || period.toDate > latest;

  // Tally sent data nobody asked for, which PROVES the date range was ignored.
  // Without this proof, a late first voucher is just sparse data — see the note
  // on silence above.
  const tallyIgnoredTheRange = dated.some(
    (date) => date < period.fromDate || date > period.toDate
  );

  if (overlaps && !(tallyIgnoredTheRange && windowExceedsData)) return null;

  return [
    `INCOMPLETE PERIOD: you asked about ${period.fromDate} to ${period.toDate}, but TallyPrime`,
    `returned vouchers dated only ${earliest} to ${latest}.`,
    overlaps
      ? 'Only the overlapping part of your period could be read; figures here cover that overlap and not the whole period you asked for.'
      : 'NONE of the period you asked about was returned, so any total here is zero because the data could not be read — NOT because no such transactions exist. Do not report this as "no transactions in that period".',
    'TallyPrime scopes a voucher collection to the current financial year regardless of the',
    'dates requested (verified live 2026-08-14), which is the usual cause. A company that',
    'genuinely has no earlier transactions would look identical from this response alone, so',
    'confirm against a statement report — Profit and Loss and Trial Balance do reach prior',
    'years — before concluding either way.',
  ].join(' ');
}

/**
 * One full fetch of the voucher register for a period, shared by every tool that
 * reads vouchers.
 *
 * The returned arrays are shared between callers, so a caller that reshapes
 * records must copy them rather than mutate in place. Every current caller
 * either reads them or maps to new objects.
 */
export async function fetchVouchers(
  deps: ToolDeps,
  company: string | undefined,
  period: { fromDate: string; toDate: string },
  allFields = false,
  /**
   * Keep nested structures without paying for every scalar field.
   *
   * This is the cheap option and it is the one most callers want. A tool needing
   * bank instruments, bill allocations or inventory lines used to pass
   * `allFields: true`, which switched the request to `FETCH *` — 18.3MB and ~5.4s
   * — even though the nested structures it wanted are already in the 8.6MB
   * curated response, in identical numbers (verified live 2026-08-13). Passing
   * `{allFields: false, nested: true}` reads the same data from the cheap request,
   * and shares one Tally fetch with every other lean caller instead of forcing a
   * second one.
   */
  nested = allFields
): Promise<{ vouchers: Voucher[]; warnings: string[] }> {
  // Tally's own spelling, not the caller's — see assertCompanyIsLoaded. This
  // also has to flow into the cache key below, or two spellings of one company
  // would occupy two entries and each pay a full fetch.
  const canonicalCompany = await assertCompanyIsLoaded(deps, company);

  const ttl = deps.config.tallyCacheTtlMs;
  // `nested` is part of the key but NOT part of the request: a lean parse cannot
  // serve a nested request, yet both come from the same bytes on the wire.
  const key = [
    // Canonical, so two spellings of one company share one cached parse instead
    // of each paying a full fetch.
    canonicalCompany ?? '(loaded)',
    period.fromDate,
    period.toDate,
    String(allFields),
    String(nested),
  ].join('|');

  let perClient = parsedVoucherCache.get(deps.client);
  if (perClient === undefined) {
    perClient = new Map();
    parsedVoucherCache.set(deps.client, perClient);
  }

  if (ttl > 0) {
    const hit = perClient.get(key);
    if (hit !== undefined && Date.now() - hit.at < ttl) {
      deps.logger.debug('voucher parse served from cache', { key });
      // Re-insert to move this key to the end. Map iterates in insertion order,
      // so deleting the FIRST key then evicts the least recently USED rather
      // than the least recently fetched — which is the difference between
      // keeping the period a conversation keeps returning to and dropping it.
      perClient.delete(key);
      perClient.set(key, hit);
      return hit.value;
    }
  }

  // Report-class: a wide voucher range is one of the slowest things Tally does.
  const currencyWarnings: string[] = [];
  const currency = await resolveCompanyCurrency(deps, canonicalCompany, currencyWarnings);

  const { data, warnings, repairs } = await fetchAcrossBookYears(deps, {
    canonicalCompany,
    period,
    allFields,
    nested,
    currency,
  });

  // Measured against `data` — everything Tally sent — and therefore BEFORE the
  // local period filter below, which is what would otherwise turn a truncated
  // fetch into a confident empty list. Placed here, in the one shared fetch, so
  // no voucher-reading tool can be added later that forgets to check.
  const shortfall = describeVoucherReachShortfall(data, period);
  if (shortfall !== null) warnings.unshift(shortfall);

  const inPeriod = filterByPeriod(data, period, warnings);
  const value = {
    vouchers: inPeriod,
    warnings: [...repairs, ...currencyWarnings, ...warnings],
  };

  if (ttl > 0) {
    // A small number of entries, not one. Holding only the latest meant that
    // alternating between two periods — comparing a quarter with the previous
    // one, or checking a prior year — evicted each to load the other and paid
    // the parse every single time.
    //
    // Six, not three: there are now THREE parse shapes per period (lean,
    // nested-only, all-fields) since nested structures stopped being tied to the
    // full-field flag. Three entries would therefore thrash inside a single
    // period — a tie-out then a bank reconciliation then a detailed voucher
    // lookup would evict the first before it was reused. Six covers two periods
    // in all three shapes, which is the realistic ceiling for one conversation.
    // It is still a bound rather than a cache policy: these are parses of an
    // 8.6–18.3MB payload, so it cannot grow freely.
    const MAX_PARSED_PERIODS = 6;
    const now = Date.now();

    // Expired entries first. Nothing used to remove these: an entry that could
    // no longer be served still occupied one of the six slots until the exact
    // same key was requested again, so a cache nominally holding six periods
    // could be holding one live entry and five parses of a payload it would
    // refuse to hand back. Each is an 8.6-18.3MB parse, so the slots are worth
    // reclaiming even though the correctness of a hit never depended on it.
    for (const [entryKey, entry] of perClient) {
      if (now - entry.at >= ttl) perClient.delete(entryKey);
    }

    if (perClient.size >= MAX_PARSED_PERIODS) {
      // The least recently USED key — see the re-insert on the hit path above.
      const evictable = perClient.keys().next().value;
      if (evictable !== undefined) perClient.delete(evictable);
    }
    perClient.set(key, { at: now, value });
  }

  return value;
}

/**
 * Fold constants out of a page of vouchers, at both levels that carry a field map.
 *
 * Done on the PAGE rather than the whole result set, deliberately: the claim
 * being made is "identical on every record in this response", and it must be
 * checkable against what the response contains. Folding across records the
 * caller cannot see would state something they have no way to verify.
 *
 * Voucher-level and entry-level fields are folded separately because they are
 * different populations — a field constant across 25 vouchers need not be
 * constant across their 80 entries.
 */
function foldVoucherPage(vouchers: readonly Voucher[]): {
  vouchers: Voucher[];
  extra: Record<string, unknown>;
  notes: string[];
} {
  const notes: string[] = [];
  const extra: Record<string, unknown> = {};

  const atVoucherLevel = foldUniformFields(
    vouchers,
    (voucher) => voucher.fields,
    (voucher, fields) => ({ ...voucher, fields })
  );

  // Every entry across the page, flattened, so the comparison population is all
  // entries rather than each voucher's own handful.
  const entries = atVoucherLevel.records.flatMap((voucher) => voucher.entries);
  const atEntryLevel = foldUniformFields(
    entries,
    (entry) => entry.fields,
    (entry, fields) => ({ ...entry, fields })
  );

  let cursor = 0;
  const rebuilt = atVoucherLevel.records.map((voucher) => {
    const slice = atEntryLevel.records.slice(cursor, cursor + voucher.entries.length);
    cursor += voucher.entries.length;
    return { ...voucher, entries: slice };
  });

  if (Object.keys(atVoucherLevel.uniformFields).length > 0) {
    extra.uniformFields = atVoucherLevel.uniformFields;
    notes.push(
      uniformFieldsNote(
        Object.keys(atVoucherLevel.uniformFields).length,
        atVoucherLevel.foldedOccurrences,
        'voucher'
      )
    );
  }
  if (Object.keys(atEntryLevel.uniformFields).length > 0) {
    extra.uniformEntryFields = atEntryLevel.uniformFields;
    notes.push(
      uniformFieldsNote(
        Object.keys(atEntryLevel.uniformFields).length,
        atEntryLevel.foldedOccurrences,
        'ledger entry'
      ).replace('"uniformFields"', '"uniformEntryFields"')
    );
  }

  return { vouchers: rebuilt, extra, notes };
}

export function registerVoucherTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_vouchers',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        voucherNumber: z
          .string()
          .min(1)
          .optional()
          .describe('Voucher number as Tally shows it. May contain letters and slashes.'),
        query: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Case-insensitive substring matched against voucher number, party ledger name, ' +
              'narration and entry ledger names.'
          ),
        voucherType: z
          .string()
          .min(1)
          .optional()
          .describe('Exact voucher type, case-insensitive, e.g. "Payment", "Sales", "Journal".'),
        ledger: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Match vouchers having a ledger entry whose name contains this text. Use to find ' +
              'every transaction touching a particular account.'
          ),
        party: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Match vouchers whose party ledger name contains this text. Narrower than "ledger": ' +
              'the party is the counterparty on the voucher, not any account it touches.'
          ),
        narration: z
          .string()
          .min(1)
          .optional()
          .describe('Match vouchers whose narration contains this text.'),
        fieldMatch: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Match this text against the value of ANY field on the voucher or its entries — ' +
              'reference numbers, cheque or UTR numbers, order references, GST fields, bank ' +
              'details. Use this when the field name is unknown or varies: which fields a ' +
              'company populates differs per company, so searching values is more reliable than ' +
              'guessing a field name. Case-insensitive substring.'
          ),
        minAmount: z
          .number()
          .optional()
          .describe(
            'Minimum size, compared against the largest absolute entry amount on the voucher. ' +
              'Your threshold — the server supplies none.'
          ),
        maxAmount: z
          .number()
          .optional()
          .describe('Maximum size, compared the same way as minAmount.'),
        family: familySchema.optional(),
        company: companySchema,
        includeAllFields: allFieldsSchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_vouchers', deps, async () => {
        const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);

        if (args.voucherNumber !== undefined) {
          // Full detail by default: fetching one specific voucher is
          // normally an investigation, and the full record is what makes it
          // answerable.
          const { vouchers, warnings } = await fetchVouchers(
            deps,
            args.company,
            period,
            args.includeAllFields ?? true
          );

          const matches = vouchers.filter(
            (voucher) =>
              (voucher.voucherNumber ?? '').toLowerCase() === args.voucherNumber?.toLowerCase()
          );

          if (matches.length === 0) {
            throw new TallyError(
              'TALLY_COMPANY_NOT_FOUND',
              `No voucher numbered "${args.voucherNumber}" exists between ${period.fromDate} and ${period.toDate}.`,
              {
                suggestion:
                  'Check the number, or widen the date range — voucher numbers are only unique within a period and type.',
              }
            );
          }

          // Every voucher carrying that number in the period, uncapped.
          return whole(
            {
              period,
              vouchers: matches,
              ...(warnings.length > 0 ? { warnings } : {}),
            },
            matches.length
          );
        }

        const filters = {
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.voucherType === undefined ? {} : { voucherType: args.voucherType }),
          ...(args.ledger === undefined ? {} : { ledger: args.ledger }),
          ...(args.party === undefined ? {} : { party: args.party }),
          ...(args.narration === undefined ? {} : { narration: args.narration }),
          ...(args.fieldMatch === undefined ? {} : { fieldMatch: args.fieldMatch }),
          ...(args.minAmount === undefined ? {} : { minAmount: args.minAmount }),
          ...(args.maxAmount === undefined ? {} : { maxAmount: args.maxAmount }),
        };
        const hasFilters = Object.keys(filters).length > 0;

        // fieldMatch searches field values, so the fields have to be parsed
        // even if the caller did not ask for them in the output.
        const needsFields = (args.includeAllFields ?? false) || args.fieldMatch !== undefined;

        const pagination = resolvePagination(
          args.page,
          args.pageSize,
          needsFields ? FIELD_HEAVY_PAGE_SIZE : DEFAULT_PAGE_SIZE
        );

        if (
          args.minAmount !== undefined &&
          args.maxAmount !== undefined &&
          args.minAmount > args.maxAmount
        ) {
          throw new TallyError(
            'INVALID_PARAMETERS',
            `minAmount (${String(args.minAmount)}) must not exceed maxAmount (${String(args.maxAmount)}).`
          );
        }

        let typeNames: string[] | undefined;
        let familyWarnings: string[] = [];
        if (args.family !== undefined) {
          const resolved = await resolveFamilyTypes(
            deps,
            args.company,
            FAMILIES[args.family].family
          );
          typeNames = [...resolved.types];
          familyWarnings = resolved.warnings;
        }

        const { vouchers, warnings } = await fetchVouchers(deps, args.company, period, needsFields);

        const familyMatched =
          typeNames === undefined
            ? vouchers
            : vouchers.filter((voucher) =>
                typeNames.includes((voucher.voucherType ?? '').toLowerCase())
              );

        const matches = hasFilters
          ? familyMatched.filter((voucher) => matchesVoucherFilters(voucher, filters))
          : familyMatched;

        assertResultSetFits(matches.length, deps.config, NARROW_HINT);

        // Applied after pagination so the "identical on every record here" claim
        // is about the page actually returned. See foldVoucherPage.
        const pageSlice = paginate(matches, pagination, []);
        const folded = foldVoucherPage(pageSlice.items);

        // Only when the whole period came back empty — a filter matching
        // nothing is a normal answer and needs no period explanation.
        const periodNote = await noteEmptyDefaultedPeriod(deps, period, periodWasDefaulted(args.fromDate, args.toDate), vouchers.length, args.company);

        return fromPage(
          {
            ...pageSlice,
            items: folded.vouchers,
            warnings: [...periodNote, ...familyWarnings, ...warnings, ...folded.notes],
          },
          {
            period,
            ...(args.family === undefined
              ? {}
              : { family: args.family, voucherTypesIncluded: typeNames }),
            // Echoing the applied filters back means Claude reports what was
            // actually searched rather than what it meant to search.
            ...(hasFilters ? { filters } : {}),
            ...folded.extra,
          }
        );
      })
  );
}
