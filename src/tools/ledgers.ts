import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildLedgerListRequest } from '../tally/requests.js';
import { normalizeLedgers, type Ledger } from '../tally/normalize.js';
import { TallyError } from '../tally/TallyError.js';
import {
  companySchema,
  paginationSchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import {
  assertCompanyIsLoaded,
  assertResultSetFits,
  runTool,
  type ToolDeps,
} from './toolResult.js';

/** Opt-in switch for the expensive everything-Tally-holds fetch. */
const allFieldsSchema = z
  .boolean()
  .optional()
  .describe(
    'Return every field TallyPrime holds for each ledger, not just the common ones, under a ' +
      '"fields" map. Which fields exist depends on what this company has configured. Roughly ' +
      '37x the payload, so use it when investigating a specific ledger or auditing a company, ' +
      'not for browsing. Defaults to false.'
  );

/**
 * Ledger tools.
 *
 * Tally has no server-side filter or search for masters: the collection comes
 * back whole, every time. Searching and fetching a single ledger are therefore
 * client-side operations over one full fetch, and the tool descriptions say so
 * rather than implying a cheap targeted query exists.
 */

const BALANCE_NOTE =
  'BALANCES: signed exactly as TallyPrime reports them, where a negative closing balance ' +
  'denotes a debit balance. Signs are never adjusted. A null balance means Tally returned an ' +
  'empty value, which is NOT the same as a balance of zero — a real zero is reported as 0.';

const NARROW_HINT =
  'This company has more ledgers than the configured limit. Raise TALLY_MAX_RECORDS, or use ' +
  'tally_search_ledgers to narrow by name or group instead of listing everything.';

const LIST_DESCRIPTION = [
  'List ledger accounts with their parent group and opening/closing balances.',
  '',
  'WHEN TO USE: to survey the chart of accounts, or to find the exact ledger name needed by ' +
    'another tool. For a known name or a name fragment, tally_search_ledgers is more direct.',
  '',
  'RETURNS: ledger name, parent group, opening and closing balance, and party GSTIN where set.',
  '',
  'DOES NOT RETURN: transactions. This is master data only — use tally_list_vouchers for entries.',
  '',
  BALANCE_NOTE,
  '',
  'PAGINATION: client-side. TallyPrime does not paginate, so the entire ledger list is fetched ' +
    'on every call regardless of pageSize. A small pageSize does NOT make the call cheap.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const SEARCH_DESCRIPTION = [
  'Find ledger accounts whose name or parent group matches a search term.',
  '',
  'WHEN TO USE: to locate a party or account without knowing its exact spelling in Tally, ' +
    'or to list every ledger under a group such as "Sundry Creditors".',
  '',
  'RETURNS: the same fields as tally_list_ledgers, filtered to matches.',
  '',
  'MATCHING: case-insensitive substring, applied to the ledger name and its parent group. ' +
    'Not a fuzzy match — "Gupta" finds "Gupta Traders", "Gupt" does too, "Gupat" does not.',
  '',
  'COST: TallyPrime cannot filter server-side, so the full ledger list is fetched and filtered ' +
    'here. Searching is no cheaper than listing; it is only easier to read.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

const GET_DESCRIPTION = [
  'Fetch a single ledger account by its exact name.',
  '',
  'WHEN TO USE: when the ledger name is already known exactly — typically from ' +
    'tally_search_ledgers or from a voucher entry.',
  '',
  'RETURNS: name, parent group, opening and closing balance, and party GSTIN where set.',
  '',
  'NOT FOUND: fails with TALLY_COMPANY_NOT_FOUND naming the ledger, rather than returning null, ' +
    'so a typo is distinguishable from a ledger that genuinely has no data.',
  '',
  BALANCE_NOTE,
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/**
 * One full fetch of the ledger collection, shared by all three tools.
 * Nothing is cached between calls: data is read at the moment it is asked for.
 */
async function fetchLedgers(
  deps: ToolDeps,
  company: string | undefined,
  allFields = false
): Promise<{ ledgers: Ledger[]; warnings: string[] }> {
  await assertCompanyIsLoaded(deps, company);

  const request = buildLedgerListRequest(
    {
      ...(company === undefined ? {} : { company }),
      format: deps.config.tallyPreferredFormat,
    },
    allFields
  );

  // A full-field fetch is large enough to deserve the report timeout.
  const response = await deps.client.send(request, allFields ? 'report' : 'standard');
  const { data, warnings } = normalizeLedgers(response.body, allFields);

  return { ledgers: data, warnings: [...response.repairs, ...warnings] };
}

export function registerLedgerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_list_ledgers',
    {
      description: LIST_DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        includeAllFields: allFieldsSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_list_ledgers', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const { ledgers, warnings } = await fetchLedgers(
          deps,
          args.company,
          args.includeAllFields ?? false
        );
        assertResultSetFits(ledgers.length, deps.config, NARROW_HINT);

        return paginate(ledgers, pagination, warnings);
      })
  );

  server.registerTool(
    'tally_search_ledgers',
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Case-insensitive substring matched against the ledger name and its parent group.'
          ),
        company: companySchema,
        includeAllFields: allFieldsSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_search_ledgers', deps.logger, async () => {
        const pagination = resolvePagination(args.page, args.pageSize);
        const { ledgers, warnings } = await fetchLedgers(
          deps,
          args.company,
          args.includeAllFields ?? false
        );

        const needle = args.query.toLowerCase();
        const matches = ledgers.filter(
          (ledger) =>
            ledger.name.toLowerCase().includes(needle) ||
            (ledger.parent ?? '').toLowerCase().includes(needle)
        );

        // Matching on an empty result is a finding, not a failure — the caller
        // learns the term matches nothing in this chart of accounts.
        return { query: args.query, ...paginate(matches, pagination, warnings) };
      })
  );

  server.registerTool(
    'tally_get_ledger',
    {
      description: GET_DESCRIPTION,
      inputSchema: z.object({
        name: z.string().min(1).describe('Exact ledger name as it appears in TallyPrime.'),
        company: companySchema,
        includeAllFields: z
          .boolean()
          .optional()
          .describe(
            'Return every field TallyPrime holds for this ledger. Defaults to TRUE here — ' +
              'asking for one specific ledger is normally an investigation, and the whole record ' +
              'is what makes that answerable. Set false for just the common fields.'
          ),
      }),
    },
    async (args) =>
      runTool('tally_get_ledger', deps.logger, async () => {
        const { ledgers, warnings } = await fetchLedgers(
          deps,
          args.company,
          args.includeAllFields ?? true
        );

        // Exact match first; fall back to case-insensitive so a difference in
        // capitalisation is not reported as a missing ledger.
        const ledger =
          ledgers.find((candidate) => candidate.name === args.name) ??
          ledgers.find((candidate) => candidate.name.toLowerCase() === args.name.toLowerCase());

        if (ledger === undefined) {
          throw new TallyError(
            'TALLY_COMPANY_NOT_FOUND',
            `No ledger named "${args.name}" exists in the loaded company.`,
            {
              suggestion:
                'Check the spelling, or use tally_search_ledgers to find the ledger by a fragment of its name.',
            }
          );
        }

        return { ledger, ...(warnings.length > 0 ? { warnings } : {}) };
      })
  );
}
