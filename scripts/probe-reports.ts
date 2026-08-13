/**
 * Look for report IDs that would unblock two things this server cannot do.
 *
 * **Licence and version** (Spec §6 rule 8). The server must refuse the
 * Educational version of TallyPrime outright, because it silently corrupts
 * data on import. Nothing in the verified request surface exposes the licence.
 *
 * **The edit log** (Spec §4 L0 `tally_get_edit_log`). Tally's audit trail —
 * who created or altered which voucher, and when — is statutorily required
 * evidence and the input to most of the §4 L3 fraud-risk tests: entries posted
 * at odd hours, backdated entries, entries by users who rarely post. Without
 * it, `Voucher.createdAt` and friends in the normalised model stay null and
 * those tests cannot be built at all.
 *
 * This is a deliberate one-off rather than production code, because a guessed
 * report ID is worse than an admitted gap: a licence check would report "not
 * Educational" on evidence it never actually had.
 *
 * METHOD, taken from docs/report-id-verification.md, which is how the existing
 * report list was established without taking Tally down:
 *
 *   - Named reports only (TYPE=Data). Verified harmless: an unknown report ID
 *     returns <LINEERROR>, it does not wedge Tally. A bare COLLECTION name with
 *     no definition is what closes the application, and this script never
 *     sends one — it goes through `buildReportRequest`, the same builder
 *     production uses.
 *   - One request at a time.
 *   - A health probe between every candidate, aborting the whole run the
 *     moment Tally stops answering, so a wedged install is caught before more
 *     requests pile onto it.
 *   - Responses hashed, so two IDs returning identical bytes are visible as
 *     the alias they are rather than as two independent successes.
 *   - Controls at both ends: a known-good ID and a known-bad one, so the
 *     script's own classification is proven before any verdict on an unknown
 *     is believed.
 *
 * BEFORE RUNNING: save your work in TallyPrime. The residual risk here is lost
 * unsaved work, not damaged books — but it is a real risk, which is why the
 * run refuses to start without explicit acknowledgement:
 *
 *   TALLY_PROBE_CONFIRM=yes npm run probe:reports
 */

import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import { buildConnectionProbeRequest, buildReportRequest } from '../src/tally/requests.js';

/**
 * Report IDs to try, with two controls.
 *
 * The unknowns are guesses by design — that is what is being tested. None of
 * them is used anywhere in the server, and a rejection costs nothing.
 */
const CANDIDATES: { id: string; expect: 'data' | 'rejected' | 'unknown'; why: string }[] = [
  {
    id: 'Statistics',
    expect: 'data',
    why: 'Positive control: verified working on 2026-08-10. If this is rejected, the script or the connection is wrong, not the candidate.',
  },
  {
    id: 'Outstandings',
    expect: 'rejected',
    why: 'Negative control: verified as no-such-report. If this returns data, the rejection detection below cannot be trusted.',
  },
  // Licence and version.
  { id: 'License Info', expect: 'unknown', why: 'Most direct guess at a licence report.' },
  { id: 'Licensing Info', expect: 'unknown', why: 'Alternate spelling.' },
  { id: 'License', expect: 'unknown', why: 'Bare form.' },
  { id: 'Company Info', expect: 'unknown', why: 'May carry product/licence metadata alongside company details.' },
  { id: 'About', expect: 'unknown', why: "Tally's own About screen shows version and licence." },
  { id: 'Version', expect: 'unknown', why: 'Product version alone would satisfy half of §4 L0.' },

  // Edit log / audit trail. Named after what TallyPrime calls the feature in
  // its own menus, since that is where its report IDs usually come from.
  { id: 'Edit Log', expect: 'unknown', why: 'TallyPrime own name for the audit trail feature.' },
  { id: 'Edit Log Summary', expect: 'unknown', why: 'The summary view of the same feature.' },
  { id: 'Audit Trail', expect: 'unknown', why: 'Statutory name for it.' },
  { id: 'Alteration Report', expect: 'unknown', why: 'Legacy name for altered-voucher reporting.' },
];

/** Strings worth reporting if they appear anywhere in a response. */
const SIGNALS = [
  // Licence and version.
  'educational',
  'silver',
  'gold',
  'serial',
  'licence',
  'license',
  'version',
  'release',
  // Edit log.
  'altered',
  'createdby',
  'enteredby',
  'username',
  'timestamp',
];

type Verdict = 'data' | 'rejected' | 'empty' | 'liveness';

function classify(body: string): Verdict {
  if (/<LINEERROR>/i.test(body)) return 'rejected';
  if (/server is running/i.test(body)) return 'liveness';
  // Tally's "valid report, nothing to show" reply.
  if (/^\s*<ENVELOPE>\s*<\/ENVELOPE>\s*$/i.test(body)) return 'empty';
  return 'data';
}

function hashOf(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

function signalsIn(body: string): string[] {
  const lowered = body.toLowerCase();
  return SIGNALS.filter((signal) => lowered.includes(signal));
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      [
        'Refusing to run without confirmation.',
        '',
        'This sends a small number of unverified report IDs to a live TallyPrime.',
        'Named reports are known to reject harmlessly, but the residual risk is',
        'lost UNSAVED work in Tally. Save your work, then re-run with:',
        '',
        '  TALLY_PROBE_CONFIRM=yes npm run probe:reports',
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  // A short timeout on purpose: a wedged Tally should show up as a fast
  // failure rather than a hang that invites a second run on top of it.
  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '8000', TALLY_CACHE_TTL_MS: '0' });
  const client = new TallyClient(config, createLogger('error'));

  console.log(`Probing ${config.tallyBaseUrl}\n`);

  const healthy = async (): Promise<boolean> => {
    try {
      await client.send(buildConnectionProbeRequest(), 'standard');
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
    let signals: string[];

    try {
      const response = await client.send(buildReportRequest(candidate.id), 'report');
      verdict = classify(response.body);
      hash = hashOf(response.body);
      bytes = Buffer.byteLength(response.body, 'utf8');
      signals = signalsIn(response.body);
    } catch (error) {
      console.log(`${candidate.id.padEnd(16)} ERROR   ${(error as Error).message}`);
      // An error is not necessarily fatal to the run, but Tally's health is.
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
      `${candidate.id.padEnd(16)} ${verdict.padEnd(9)} ${String(bytes).padStart(7)}B  ${hash}` +
        (alias !== undefined && alias !== candidate.id ? `  (identical to "${alias}")` : '') +
        (signals.length > 0 ? `  signals: ${signals.join(', ')}` : '')
    );

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
      'What to do with this: any candidate reporting "data" with a signal beside it is a',
      'lead — a licence signal unblocks the §6 rule 8 Educational check, an edit-log signal',
      'unblocks tally_get_edit_log and most of the §4 L3 fraud tests.',
      '',
      'The full response body is needed next, to know which field to read. This script',
      'deliberately does not print it, because it may contain company data.',
    ].join('\n')
  );
}

await main();
