import { buildGroupListRequest } from '../tally/requests.js';
import { normalizeGroups, type Group } from '../tally/normalize.js';
import { fetchCollection, type ToolDeps } from './toolResult.js';

/**
 * The chart-of-accounts group fetch.
 *
 * Exposed to callers as one of the four types behind `tally_get_masters`. A
 * ledger's `parent` names the group it is filed under, but not what that group
 * nests under in turn, nor whether it is a balance sheet or a P&L group — this
 * collection is what answers those.
 */

/** One full fetch of the group collection. Groups have no all-fields variant. */
export async function fetchGroups(
  deps: ToolDeps,
  company: string | undefined
): Promise<{ groups: Group[]; warnings: string[] }> {
  const { data, warnings } = await fetchCollection<Group>(deps, company, {
    kind: 'group',
    build: buildGroupListRequest,
    normalize: normalizeGroups,
  });

  return { groups: data, warnings };
}

/**
 * The group fetch for scoping a ledger filter, where failure must not be fatal.
 *
 * `ledgersUnderGroups` needs the group tree to see that a ledger under
 * "Sundry Debtors > Domestic" is a debtor. But the tools that ask — outstanding,
 * confirmations, GST, TDS, fixed assets — all answered without it before, using
 * a direct-parent match, and a tool that used to produce a slightly narrow
 * answer must not start producing NO answer because a second master fetch
 * failed. That would trade an understatement for an outage.
 *
 * So a failure here degrades instead of throwing. An empty group list makes
 * `isUnderAnyGroup` fall back to exactly the direct-parent match that was there
 * before — it tests the target set before it consults the tree — and the
 * warning says so, in the terms that matter to a reader: ledgers in sub-groups
 * may be missing from this result.
 */
export async function fetchGroupsForScoping(
  deps: ToolDeps,
  company: string | undefined
): Promise<{ groups: Group[]; warnings: string[] }> {
  try {
    return await fetchGroups(deps, company);
  } catch (error) {
    return {
      groups: [],
      warnings: [
        'The group hierarchy could not be read, so ledgers were matched on their immediate ' +
          'parent group only. Any ledger filed in a SUB-group of the groups requested is ' +
          `missing from this result. Cause: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
