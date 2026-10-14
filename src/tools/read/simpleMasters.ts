import { buildSimpleMasterRequest, type SimpleMasterType } from '../../tally/requests.js';
import { normalizeSimpleMasters, type SimpleMaster } from '../../tally/normalize.js';
import { fetchCollection, type ToolDeps } from '../shared/toolResult.js';

/**
 * The simple master lists: cost centres, cost categories, units, stock groups,
 * stock categories, godowns and budgets.
 *
 * Every one of these collection TYPEs was probed live on 2026-08-21 (see
 * SIMPLE_MASTER_TYPES in requests/masters.ts) and is safe to send. They were
 * read by the scheduled export from then on, but no interactive tool exposed
 * them until tally_get_masters gained them.
 */
export async function fetchSimpleMasters(
  deps: ToolDeps,
  company: string | undefined,
  type: SimpleMasterType
): Promise<{ data: SimpleMaster[]; warnings: string[] }> {
  return fetchCollection<SimpleMaster>(deps, company, {
    kind: `simpleMaster:${type}`,
    build: (options) => buildSimpleMasterRequest(type, options),
    normalize: (xml) => normalizeSimpleMasters(xml, type.toUpperCase(), 'group', `the ${type} masters`),
  });
}
