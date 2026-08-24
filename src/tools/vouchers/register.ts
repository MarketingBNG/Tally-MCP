import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  buildVoucherTypeListRequest,
  UNSCOPED,
} from '../../tally/requests.js';
import { normalizeVoucherTypes, type Voucher } from '../../tally/normalize.js';
import { matchesVoucherFilters } from '../voucherFilters.js';
import { TallyError } from '../../tally/TallyError.js';
import {
  allFieldsSchema,
  companySchema,
  dateRangeSchema,
  paginationSchema,
  periodNote,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
  EMPTY_RESULT_CAVEAT,
} from '../../schemas/common.js';
import {
  DEFAULT_PAGE_SIZE,
  FIELD_HEAVY_PAGE_SIZE,
  paginate,
  resolvePagination,
} from '../../utils/pagination.js';
import { foldUniformFields, uniformFieldsNote } from '../../utils/uniformFields.js';
import {
  assertResultSetFits,
  fromPage,
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolvePeriodForCompany,
  runTool,
  whole,
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
import { fetchVouchers, } from './fetch.js';

/**
 * The `tally_get_vouchers` registration: schema, description, and the sales /
 * purchases family resolution.
 *
 * Split out of vouchers.ts at 989 lines. The family specs live here because they
 * are a naming convenience offered to the caller rather than anything the fetch
 * path knows about.
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
