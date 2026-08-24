import {
  buildVoucherCollectionRequest,
  buildVoucherRegisterRequest,
  UNSCOPED,
} from '../../tally/requests.js';
import { addDaysIso, bookYearFor, type DateRange } from '../../utils/dates.js';
import { normalizeVouchers, type Voucher } from '../../tally/normalize.js';
import {
  assertCompanyIsLoaded,
  companyNamed,
  resolveCompanyCurrency,
  type ToolDeps,
} from '../toolResult.js';

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

/**
 * Fetching vouchers: across book years, deduped, cached, and honest about what
 * it could not reach.
 *
 * Split out of vouchers.ts at 989 lines. This is the part every other tool goes
 * through — bank reconciliation, outstanding, GST, TDS, inventory movements and
 * the voucher list itself all read the register from here, which is why the
 * parsed-voucher cache lives with it.
 */

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
export function filterByPeriod(
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
/**
 * Every book year a period touches, oldest first.
 *
 * Exported so the workbook export can ask for a statement PER YEAR using the
 * same year boundaries the voucher fetch uses. Two different ideas of where a
 * book year starts would put a trial balance and the vouchers behind it on
 * different periods, which is the kind of disagreement nobody would spot.
 */
export function bookYearsSpanning(
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
