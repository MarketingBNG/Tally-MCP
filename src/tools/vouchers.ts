import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildVoucherRegisterRequest } from '../tally/requests.js';
import { normalizeVouchers, type Voucher } from '../tally/normalize.js';
import { matchesVoucherFilters } from './voucherFilters.js';
import { TallyError } from '../tally/TallyError.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import {
  assertCompanyIsLoaded,
  assertResultSetFits,
  resolvePeriod,
  runTool,
  type ToolDeps,
} from './toolResult.js';

/**
 * Opt-in for every field on the voucher.
 *
 * Unlike the ledger equivalent this costs nothing extra on the wire: Tally
 * already sends every field on every voucher. The only cost is response size,
 * so it stays opt-in for list calls and defaults on for single-voucher lookups.
 */
const allFieldsSchema = z
  .boolean()
  .optional()
  .describe(
    'Include every field TallyPrime holds on each voucher and entry — reference numbers, due ' +
      'dates, GST fields, bank details, cost centres and whatever else this company records — ' +
      'under a "fields" map. Which fields exist depends on the company. No extra cost to ' +
      'retrieve; it only makes the response larger. Defaults to false.'
  );

/**
 * Voucher tools.
 *
 * These use Tally's `Voucher Register`, not `DayBook`. Verified against a live
 * install, DayBook ignores the requested date range and reports its own
 * current period — 3 vouchers for five years where the register returned 30
 * for one month inside it. A date filter that is silently ignored is worse
 * than one that fails, so the day book is not exposed as a tool.
 * See docs/known-limitations.md.
 *
 * Filtering is client-side over a full fetch, because Tally cannot filter
 * server-side. The only lever that genuinely reduces cost is the date range.
 */

const NARROW_HINT =
  'Narrow the date range. Tally cannot paginate or filter server-side, so the whole period is ' +
  'fetched in one go and a shorter period is the only way to make the query smaller.';

const PERIOD_NOTE =
  'PERIOD: if fromDate and toDate are both omitted, the Indian financial year containing today ' +
  'is used. The period actually used is echoed back. Supply both dates or neither. Date range ' +
  'is the only thing that makes a voucher query cheaper — a five-year range can time out.';

const AMOUNT_NOTE =
  'AMOUNTS AND SIDES: each entry carries the amount exactly as Tally reports it (debits arrive ' +
  'negative) plus the side Tally assigned it. Entries of a voucher sum to zero.';

const LIST_DESCRIPTION = [
  'List vouchers (transactions) recorded in a period, with their ledger entries.',
  '',
  'WHEN TO USE: to examine transactions over a period — the starting point for most audit ' +
    'questions about what actually happened in the books.',
  '',
  'RETURNS: per voucher — date, type, number, party ledger, narration, cancelled/optional flags, ' +
    'and every ledger entry with its amount and side.',
  '',
  AMOUNT_NOTE,
  '',
  PERIOD_NOTE,
  '',
  'PAGINATION: client-side over a full fetch. A small pageSize does NOT make the call cheap.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const SEARCH_DESCRIPTION = [
  'Find vouchers in a period matching a search term, a voucher type, or an amount range.',
  '',
  'WHEN TO USE: to narrow a period down to the transactions of interest — a particular party, ' +
    'a payment type, or entries above a threshold.',
  '',
  'RETURNS: the same fields as tally_list_vouchers, filtered to matches.',
  '',
  'MATCHING: all supplied filters must match (AND). All text matching is case-insensitive ' +
    'substring, not fuzzy.',
  '  - "query" is the broad one: voucher number, party, narration and entry ledger names.',
  '  - "ledger" matches any entry account; "party" matches only the counterparty.',
  '  - "narration" matches the narration alone.',
  '  - "fieldMatch" searches the VALUE of every field, including nested bank and tax ' +
    'structures. Use it for reference, cheque or UTR numbers, where the field name differs ' +
    'between companies.',
  '  - minAmount/maxAmount compare against the largest absolute entry amount on the voucher.',
  '',
  'NOTE ON THRESHOLDS: minAmount is whatever you decide it is. This server has no built-in ' +
    'notion of a large or suspicious transaction, and applies no threshold you did not supply.',
  '',
  AMOUNT_NOTE,
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const GET_DESCRIPTION = [
  'Fetch a single voucher by its voucher number within a period.',
  '',
  'WHEN TO USE: to inspect one transaction in full once its number is known, typically from ' +
    'tally_list_vouchers or tally_search_vouchers.',
  '',
  'RETURNS: the voucher with all of its ledger entries.',
  '',
  'AMBIGUITY: voucher numbers are only unique per voucher type and period in TallyPrime. If more ' +
    'than one voucher in the period carries the number, all matches are returned rather than an ' +
    'arbitrary one being picked.',
  '',
  PERIOD_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/**
 * One full fetch of the voucher register for a period.
 * Nothing is cached: the register is read at the moment it is asked for.
 */
async function fetchVouchers(
  deps: ToolDeps,
  company: string | undefined,
  period: { fromDate: string; toDate: string },
  allFields = false
): Promise<{ vouchers: Voucher[]; warnings: string[] }> {
  await assertCompanyIsLoaded(deps, company);

  const request = buildVoucherRegisterRequest({
    ...(company === undefined ? {} : { company }),
    fromDate: period.fromDate,
    toDate: period.toDate,
    format: deps.config.tallyPreferredFormat,
  });

  // Report-class: a wide voucher range is one of the slowest things Tally does.
  const response = await deps.client.send(request, 'report');
  const { data, warnings } = normalizeVouchers(response.body, allFields);

  return { vouchers: data, warnings: [...response.repairs, ...warnings] };
}

export function registerVoucherTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_list_vouchers',
    {
      description: LIST_DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        includeAllFields: allFieldsSchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_list_vouchers', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const period = resolvePeriod(args.fromDate, args.toDate);
        const { vouchers, warnings } = await fetchVouchers(
          deps,
          args.company,
          period,
          args.includeAllFields ?? false
        );
        assertResultSetFits(vouchers.length, deps.config, NARROW_HINT);

        return { period, ...paginate(vouchers, pagination, warnings) };
      })
  );

  server.registerTool(
    'tally_search_vouchers',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: z.object({
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
        company: companySchema,
        includeAllFields: allFieldsSchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_search_vouchers', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const period = resolvePeriod(args.fromDate, args.toDate);

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

        // fieldMatch searches field values, so the fields have to be parsed
        // even if the caller did not ask for them in the output.
        const needsFields = (args.includeAllFields ?? false) || args.fieldMatch !== undefined;

        const { vouchers, warnings } = await fetchVouchers(
          deps,
          args.company,
          period,
          needsFields
        );

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

        const matches = vouchers.filter((voucher) => matchesVoucherFilters(voucher, filters));

        return {
          period,
          // Echoing the applied filters back means Claude reports what was
          // actually searched rather than what it meant to search.
          filters,
          ...paginate(matches, pagination, warnings),
        };
      })
  );

  server.registerTool(
    'tally_get_voucher',
    {
      description: GET_DESCRIPTION,
      inputSchema: z.object({
        voucherNumber: z
          .string()
          .min(1)
          .describe('Voucher number as Tally shows it. May contain letters and slashes.'),
        company: companySchema,
        includeAllFields: z
          .boolean()
          .optional()
          .describe(
            'Include every field TallyPrime holds on the voucher and its entries. Defaults to ' +
              'TRUE here — fetching one specific voucher is normally an investigation, and the ' +
              'full record is what makes it answerable. Set false for just the common fields.'
          ),
        ...dateRangeSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_voucher', deps.logger, async () => {
        const period = resolvePeriod(args.fromDate, args.toDate);
        const { vouchers, warnings } = await fetchVouchers(
          deps,
          args.company,
          period,
          args.includeAllFields ?? true
        );

        const matches = vouchers.filter(
          (voucher) =>
            (voucher.voucherNumber ?? '').toLowerCase() === args.voucherNumber.toLowerCase()
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

        return {
          period,
          vouchers: matches,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      })
  );
}
