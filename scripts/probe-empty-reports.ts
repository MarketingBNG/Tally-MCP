/**
 * Re-probe the six report IDs that are CONFIRMED VALID but returned nothing on
 * every company probed so far (docs/next-steps.md item 2).
 *
 * These are not guesses. Each one was already accepted by TallyPrime — it did
 * not come back with <LINEERROR> — but the company loaded at the time recorded
 * nothing for it, so there was no way to learn the response SHAPE and therefore
 * no way to build `tally_get_report` (item 1) against it.
 *
 * What this run is asking is narrow: does a richer company populate them?
 *
 *   empty     -> the company still does not use that feature. No new knowledge.
 *   data      -> the shape can finally be read, and item 1 unparks for that ID.
 *   rejected  -> the earlier "valid" finding was wrong for this Tally build.
 *
 * METHOD is unchanged from docs/report-id-verification.md and probe-reports.ts:
 * named reports only (TYPE=Data, through the server's own builder — never a
 * bare COLLECTION, which is what closes TallyPrime), one request at a time, a
 * health probe between every candidate aborting the run the moment Tally stops
 * answering, responses hashed so aliases are visible, and a known-good plus a
 * known-bad control so the classifier is proven before any verdict is believed.
 *
 * The risk here is lower than the original probe, since every unknown below has
 * already been sent to a live Tally once without incident. It is not zero:
 * BEFORE RUNNING, save your work in TallyPrime.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-empty-reports.ts
 */

import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import { buildConnectionProbeRequest, buildReportRequest } from '../src/tally/requests.js';

const CANDIDATES: { id: string; expect: 'data' | 'rejected' | 'unknown'; why: string }[] = [
  {
    id: 'Statistics',
    expect: 'data',
    why: 'Positive control: verified working. If this is rejected, the connection or the script is wrong, not the candidate.',
  },
  {
    id: 'Outstandings',
    expect: 'rejected',
    why: 'Negative control: verified as no-such-report. If this returns data, the rejection detection cannot be trusted.',
  },
  {
    id: 'Cost Centre Summary',
    expect: 'unknown',
    why: 'Cost centres are the single largest remaining gap — branch and project P&L.',
  },
  { id: 'Godown Summary', expect: 'unknown', why: 'Location-wise stock. Needs multi-godown inventory.' },
  { id: 'Bills Receivable', expect: 'unknown', why: 'Needs bill-wise details on debtors; would verify ageing against real bills.' },
  { id: 'Bills Payable', expect: 'unknown', why: 'Same, creditor side.' },
  { id: 'Stock Summary', expect: 'unknown', why: 'Closing stock by item; needs inventory to be maintained.' },
  { id: 'Ledger Vouchers', expect: 'unknown', why: 'Per-ledger register. Previously empty without a ledger in scope.' },
];

type Verdict = 'data' | 'rejected' | 'empty' | 'liveness';

function classify(body: string): Verdict {
  if (/<LINEERROR>/i.test(body)) return 'rejected';
  if (/server is running/i.test(body)) return 'liveness';
  if (/^\s*<ENVELOPE>\s*<\/ENVELOPE>\s*$/i.test(body)) return 'empty';
  return 'data';
}

function hashOf(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

/**
 * Names of elements present in the body, with counts. Element NAMES are the
 * schema — that is exactly what this run is trying to learn — whereas element
 * VALUES are the company's real books. Printing names is safe and useful;
 * printing values would leak accounting data into a terminal and a log.
 */
function elementCensus(body: string, limit = 14): string {
  const counts = new Map<string, number>();
  for (const match of body.matchAll(/<([A-Z][A-Z0-9._]*)\b/gi)) {
    const tag = match[1].toUpperCase();
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, n]) => `${tag}x${n}`)
    .join(' ');
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      [
        'Refusing to run without confirmation.',
        '',
        'This sends six already-accepted report IDs to a live TallyPrime. The',
        'residual risk is lost UNSAVED work in Tally. Save your work, then:',
        '',
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-empty-reports.ts',
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '15000', TALLY_CACHE_TTL_MS: '0' });
  const client = new TallyClient(config, createLogger('error'));

  console.log(`Probing ${config.tallyBaseUrl}\n`);

  const healthy = async (): Promise<boolean> => {
    try {
      await client.send(buildConnectionProbeRequest(), 'standard', { bypassCache: true });
      return true;
    } catch {
      return false;
    }
  };

  if (!(await healthy())) {
    console.error('TallyPrime did not answer the initial health probe. Nothing was sent.');
    process.exitCode = 1;
    return;
  }

  const seen = new Map<string, string>();

  for (const candidate of CANDIDATES) {
    let verdict: Verdict;
    let hash: string;
    let bytes: number;
    let census = '';

    try {
      const response = await client.send(buildReportRequest(candidate.id), 'report');
      verdict = classify(response.body);
      hash = hashOf(response.body);
      bytes = Buffer.byteLength(response.body, 'utf8');
      if (verdict === 'data') census = elementCensus(response.body);
    } catch (error) {
      console.log(`${candidate.id.padEnd(21)} ERROR   ${(error as Error).message}`);
      if (!(await healthy())) {
        console.error('\nTallyPrime stopped answering. ABORTING — do not re-run until it is back.');
        process.exitCode = 1;
        return;
      }
      continue;
    }

    const alias = seen.get(hash);
    seen.set(hash, alias ?? candidate.id);

    console.log(
      `${candidate.id.padEnd(21)} ${verdict.padEnd(9)} ${String(bytes).padStart(9)}B  ${hash}` +
        (alias !== undefined && alias !== candidate.id ? `  (identical to "${alias}")` : '')
    );
    if (census !== '') console.log(`  ${census}`);

    if (candidate.expect !== 'unknown' && verdict !== candidate.expect) {
      console.error(
        `\n  ^ CONTROL FAILED: expected "${candidate.expect}". ${candidate.why}\n` +
          '  Treat every other line above as unreliable.'
      );
    }

    if (!(await healthy())) {
      console.error('\nTallyPrime stopped answering. ABORTING — do not re-run until it is back.');
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    [
      '',
      'Done. TallyPrime answered throughout.',
      '',
      'Reading this: "empty" means the company still does not use that feature — a real',
      'answer, not a failure, and it keeps tally_get_report parked for that ID. "data"',
      'with an element census beside it is the unblock: the census names the fields, which',
      'is what a parser needs. Response bodies are deliberately not printed — they hold',
      'real balances and party names.',
    ].join('\n')
  );
}

await main();
