import { buildLedgerListRequest } from '../tally/requests.js';
import { normalizeLedgers, type Ledger } from '../tally/normalize.js';
import { fetchCollection, type ToolDeps } from './toolResult.js';

/**
 * The ledger master fetch.
 *
 * This used to be a tool of its own. It is now one of the four types behind
 * `tally_get_masters` (see masters.ts) — but the fetch stays here, because it
 * is read internally by several tools that need the ledger list for their own
 * reasons: outstanding balances, the tie-out check, party statements and search
 * all resolve names or balances through it rather than through a tool call.
 */

/** One full fetch of the ledger collection, shared across every caller. */
export async function fetchLedgers(
  deps: ToolDeps,
  company: string | undefined,
  allFields = false
): Promise<{ ledgers: Ledger[]; warnings: string[] }> {
  const { data, warnings } = await fetchCollection<Ledger>(deps, company, {
    kind: 'ledger',
    build: (options) => buildLedgerListRequest(options, allFields),
    normalize: (xml, currency) => normalizeLedgers(xml, allFields, currency),
    timeoutClass: allFields ? 'report' : 'standard',
  });

  return { ledgers: data, warnings };
}
