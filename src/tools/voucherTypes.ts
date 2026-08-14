import { buildVoucherTypeListRequest } from '../tally/requests.js';
import { normalizeVoucherTypes, type VoucherType } from '../tally/normalize.js';
import { fetchCollection, type ToolDeps } from './toolResult.js';

/**
 * The voucher-type fetch.
 *
 * Exposed as one of the four types behind `tally_get_masters`, and read
 * internally by `resolveFamilyTypes` in vouchers.ts to answer "which types
 * count as sales on THIS company?" — which is the reason the list matters at
 * all: type names are company-specific, so filtering vouchers on a guessed
 * name silently under-reports.
 */

/**
 * One full fetch of the voucher type collection, with every field.
 *
 * All-fields is not optional here: the numbering setup lives in a nested
 * structure the curated fetch cannot carry, and the curated fetch's top-level
 * numbering scalar reads `None` on every type regardless of the truth. Small
 * enough that there is no tradeoff to expose — 142 KB for 26 types live.
 */
export async function fetchVoucherTypes(
  deps: ToolDeps,
  company: string | undefined
): Promise<{ voucherTypes: VoucherType[]; warnings: string[] }> {
  const { data, warnings } = await fetchCollection<VoucherType>(deps, company, {
    build: (options) => buildVoucherTypeListRequest(options, true),
    normalize: normalizeVoucherTypes,
  });

  return { voucherTypes: data, warnings };
}
