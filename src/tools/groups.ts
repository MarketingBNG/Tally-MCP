import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { buildGroupListRequest } from '../tally/requests.js';
import { normalizeGroups, type Group } from '../tally/normalize.js';
import {
  companySchema,
  conditionsSchema,
  paginationSchema,
  querySchema,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import { matchesText } from '../utils/text.js';
import {
  applyConditions,
  assertResultSetFits,
  fetchCollection,
  fromPage,
  runTool,
  type DatasetSpec,
  type ToolDeps,
} from './toolResult.js';

/**
 * `tally_get_groups`: list, search and multi-condition filter over the
 * chart-of-accounts hierarchy — one tool, same fetch-whole-then-filter shape
 * as ledgers, since Tally has no server-side search over masters.
 *
 * A ledger's `parent` names the group it is filed under, but not what that
 * group nests under in turn, nor whether it is a balance sheet or P&L group.
 * This is the tool that answers those questions.
 */

const GROUP_FIELDS: DatasetSpec<Group> = {
  name: { type: 'string', get: (g) => g.name },
  parent: { type: 'string', get: (g) => g.parent },
  isRevenue: { type: 'boolean', get: (g) => g.isRevenue },
  isDeemedPositive: { type: 'boolean', get: (g) => g.isDeemedPositive },
};

const NARROW_HINT =
  'This company has more groups than the configured limit. Raise TALLY_MAX_RECORDS, or add a ' +
  'query/conditions filter to narrow instead of listing everything.';

const DESCRIPTION = [
  'Chart-of-accounts groups — e.g. "Sundry Debtors", "Direct Expenses", "Bank Accounts": list, ' +
    'search by name, or filter by combining conditions on name/parent/isRevenue/isDeemedPositive.',
  '',
  'WHEN TO USE: to see the account hierarchy itself, or to check whether a group is a balance ' +
    'sheet group or a P&L group before interpreting a ledger filed under it. For the ledgers ' +
    'inside a group, use tally_get_ledgers with the group name as `query`.',
  '',
  'MODES:',
  '- query given: case-insensitive substring against the group name only.',
  '- conditions given: combine more than one field at once. Fields: name (string), parent ' +
    '(string), isRevenue (boolean), isDeemedPositive (boolean). All conditions AND together.',
  '- neither given: list every group.',
  '',
  'RETURNS: group name, parent group (null for a primary/top-level group), isRevenue (true for ' +
    'P&L groups such as income and expenses, false for balance sheet groups), and ' +
    "isDeemedPositive (Tally's debit/credit classification).",
  '',
  'DOES NOT RETURN: the ledgers filed under each group, or balances — groups themselves carry no ' +
    'balance in Tally.',
  '',
  'COST: TallyPrime cannot filter server-side, so the full group list is fetched and filtered ' +
    'here regardless of mode.',
  '',
  'PAGINATION: client-side, for the same reason.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/** One full fetch of the group collection. Groups have no all-fields variant. */
export async function fetchGroups(
  deps: ToolDeps,
  company: string | undefined
): Promise<{ groups: Group[]; warnings: string[] }> {
  const { data, warnings } = await fetchCollection<Group>(deps, company, {
    build: buildGroupListRequest,
    normalize: normalizeGroups,
  });

  return { groups: data, warnings };
}

export function registerGroupTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_groups',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        query: querySchema,
        conditions: conditionsSchema,
        company: companySchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_groups', deps, async () => {
        const { groups, warnings } = await fetchGroups(deps, args.company);

        let matches = groups;
        if (args.query !== undefined) {
          matches = matches.filter((group) => matchesText(args.query as string, group.name));
        }
        if (args.conditions !== undefined && args.conditions.length > 0) {
          matches = applyConditions(matches, GROUP_FIELDS, args.conditions);
        }

        const pagination = resolvePagination(args.page, args.pageSize);
        assertResultSetFits(matches.length, deps.config, NARROW_HINT);

        return fromPage(paginate(matches, pagination, warnings), {
          ...(args.query === undefined ? {} : { query: args.query }),
        });
      })
  );
}
