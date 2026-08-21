import { createHash } from 'node:crypto';
import {
  buildLedgerAlterIdRequest,
  buildVoucherAlterIdRequest,
  UNSCOPED,
  type CompanyScope,
  type TallyRequestOptions,
} from '../tally/requests.js';
import type { ToolDeps } from '../tools/toolResult.js';

/**
 * "Has anything changed?" — asked cheaply, every minute.
 *
 * ## Why the export does not simply run
 *
 * A full export at "everything reachable" is roughly 20MB and 10-20 seconds of
 * TallyPrime's attention; the full-field voucher fetch alone is 18.3MB and
 * 5.6-7.7s. Run every minute that is ~1,440 runs and ~30GB a day per company,
 * with Tally noticeably slower for whoever is using it, ~1,440 Drive uploads,
 * and a toast every minute for as long as somebody leaves the workbook open.
 *
 * A collection fetching only `AlterId,MasterId` costs **537KB in ~200ms**,
 * measured live — roughly 40x smaller and 10x faster than the full fetch. So
 * the minute-by-minute question is this one, and the export happens only when
 * the answer is yes.
 *
 * ## The SET, not the maximum
 *
 * A maximum cannot see a deletion: remove any record other than the highest and
 * the maximum is unchanged, so a workbook validated on a maximum would keep
 * serving a voucher that no longer exists. The set of `(MasterId, AlterId)`
 * pairs can — the pair simply disappears. This is the reasoning already written
 * into scripts/probe-alterid.mjs, and it is why the fingerprint is a hash of a
 * sorted pair list rather than a number.
 *
 * ## The prerequisite, which is not optional
 *
 * All of this rests on `ALTERID` moving on EVERY edit, including deletions.
 * That needs a human at a TallyPrime screen to prove — alter a voucher, add
 * one, delete one, comparing after each — and until it is proven an install
 * that would rather be slow than wrong sets `TALLY_EXPORT_INTERVAL_MINUTES=60`
 * and gets a fixed hourly export instead. If `ALTERID` does NOT move on some
 * edit, a change check skips exports while the books change: the workbook looks
 * current and is wrong, which is worse than a slow schedule.
 */

/** One reading of the books' identity, small enough to store beside the log. */
export interface Fingerprint {
  /** Hex digest over the sorted (MasterId, AlterId) pairs of both collections. */
  digest: string;
  /** Pairs read per collection, so a truncated read is visible rather than silent. */
  voucherPairs: number;
  ledgerPairs: number;
  /** Blocks that carried neither ID — see the skeleton note below. */
  skeletonBlocks: number;
}

/**
 * TallyPrime emits an empty `<VOUCHER></VOUCHER>` template alongside the real
 * records — observed live 2026-08-18: six blocks for five vouchers. It is
 * constant today, so it would not have produced a false movement, but it does
 * not belong in a fingerprint and a future build is not promised to keep it
 * constant. Counted rather than quietly absorbed.
 */
function pairsIn(xml: string, element: string): { pairs: string[]; skeleton: number } {
  const blocks = xml.match(new RegExp(`<${element}[\\s>][\\s\\S]*?</${element}>`, 'g')) ?? [];
  const pairs: string[] = [];
  let skeleton = 0;

  for (const block of blocks) {
    const alter = /<ALTERID[^>]*>\s*(\d+)\s*<\/ALTERID>/.exec(block);
    const master = /<MASTERID[^>]*>\s*(\d+)\s*<\/MASTERID>/.exec(block);
    // Both IDs or nothing. MASTERID is what makes a deletion visible — the pair
    // disappears — so a record contributing only an ALTERID would weaken the
    // fingerprint precisely where it has to be strong.
    if (master === null || alter === null) {
      skeleton += 1;
      continue;
    }
    pairs.push(`${element}:${master[1] ?? ''}:${alter[1] ?? ''}`);
  }

  return { pairs, skeleton };
}

/**
 * Read the books' fingerprint for one company.
 *
 * Both collections, because a voucher-only fingerprint is blind to a renamed
 * ledger, a new ledger or a changed opening balance — none of which touches a
 * voucher, and all of which change what the workbook should say.
 *
 * The company is always named. An unscoped request is answered from whichever
 * company TallyPrime considers current, so an unscoped fingerprint could be
 * read off one company while the workbook is written for another.
 */
export async function readFingerprint(
  deps: ToolDeps,
  company: string | undefined
): Promise<Fingerprint> {
  const scope: CompanyScope = company === undefined || company === '' ? UNSCOPED : company;
  // XML, not JSON: the pair extraction below is a regex over Tally's element
  // names, and the JSON wire shape does not carry them.
  const options: TallyRequestOptions = { company: scope, format: 'xml' };

  /*
   * BYPASS THE CACHE. This is not an optimisation choice — it is the difference
   * between a change check that works and one that cannot.
   *
   * These two request bodies are byte-identical on every run, which makes them
   * the most cacheable requests this server sends. With the response cache at
   * its five-minute default, a minute-by-minute check would ask Tally once and
   * then be handed the same answer from memory for the next four runs — so a
   * voucher posted at 10:01 would not be exported until 10:05, and the workbook
   * would report itself current the whole time.
   *
   * It is the same trap the connection probe hit on 2026-08-14, when a cached
   * liveness reply reported `connected: true` while a real request timed out
   * against a wedged TallyPrime. Caught here by a test that deletes a voucher
   * and expects the next run to export.
   */
  const vouchers = await deps.client.send(buildVoucherAlterIdRequest(options), 'standard', {
    bypassCache: true,
  });
  const ledgers = await deps.client.send(buildLedgerAlterIdRequest(options), 'standard', {
    bypassCache: true,
  });

  const voucherPairs = pairsIn(vouchers.body, 'VOUCHER');
  const ledgerPairs = pairsIn(ledgers.body, 'LEDGER');

  const all = [...voucherPairs.pairs, ...ledgerPairs.pairs].sort();

  return {
    // Order-independent by construction: TallyPrime is not promised to return
    // rows in a stable order, and a fingerprint that moved when nothing did
    // would be worse than useless — it would export every minute.
    digest: createHash('sha256').update(all.join('|')).digest('hex').slice(0, 32),
    voucherPairs: voucherPairs.pairs.length,
    ledgerPairs: ledgerPairs.pairs.length,
    skeletonBlocks: voucherPairs.skeleton + ledgerPairs.skeleton,
  };
}

/** What the exporter remembers between runs, beside the run log. */
export interface ExportState {
  /** The fingerprint of the last SUCCESSFUL export. */
  digest: string | null;
  /** ISO timestamp of the last successful export. */
  exportedAt: string | null;
  /** Local date (YYYY-MM-DD) of the last archive copy, for the daily guarantee. */
  archivedOn: string | null;
  /** Whether the last run failed, so a repeat failure can stay quiet. */
  lastFailure: string | null;
  /** Minutes that found nothing changed since the last logged line. */
  unchangedRuns: number;
}

export const EMPTY_STATE: ExportState = {
  digest: null,
  exportedAt: null,
  archivedOn: null,
  lastFailure: null,
  unchangedRuns: 0,
};

/**
 * Should this run export?
 *
 * Three reasons, in the order they are checked, because the reason goes in the
 * run log and "nothing changed but it was time for the daily copy" is a
 * different fact from "the books moved".
 */
export type DueReason = 'forced' | 'first-run' | 'changed' | 'daily';

export function exportIsDue(
  state: ExportState,
  current: Fingerprint,
  today: string,
  force: boolean
):
  | { due: true; reason: DueReason }
  | { due: false; reason: 'unchanged' } {
  if (force) return { due: true, reason: 'forced' };
  if (state.digest === null) return { due: true, reason: 'first-run' };
  if (state.digest !== current.digest) return { due: true, reason: 'changed' };
  // The guaranteed daily run. Without it, "nothing changed" could justify an
  // indefinitely old workbook — and the as-of stamp on the Manifest, which is
  // the reader's only defence against a stale cloud copy, would never advance.
  if (state.archivedOn !== today) return { due: true, reason: 'daily' };
  return { due: false, reason: 'unchanged' };
}
