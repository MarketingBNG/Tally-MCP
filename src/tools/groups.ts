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
    build: buildGroupListRequest,
    normalize: normalizeGroups,
  });

  return { groups: data, warnings };
}
