/**
 * Look for a request setting that makes TallyPrime honour the requested END
 * date on Trial Balance / Profit and Loss / Cash Flow.
 *
 * See docs/known-limitations.md, "The statements ignore the requested END date
 * and accumulate to the year end" — verified 2026-08-12: `SVFROMDATE` binds,
 * `SVTODATE` does not, so a three-month Cash Flow request returns nine months.
 * This is currently the largest single limitation on what the server can
 * answer.
 *
 * METHOD, and why this is a SAFER experiment than probing report IDs:
 *
 *   - The report ID never changes. Every request in this file uses `Cash Flow`,
 *     already verified working (docs/report-id-verification.md). Only the
 *     STATICVARIABLES block gains ONE extra candidate entry per attempt.
 *   - Unknown STATICVARIABLES entries are documented TDL behaviour to be
 *     silently ignored, not rejected — so a wrong guess here degrades to "no
 *     effect", not an error, and categorically cannot be the kind of malformed
 *     request that has been observed to wedge TallyPrime (that came from an
 *     undefined COLLECTION, a different request shape entirely — see
 *     docs/known-limitations.md, "A malformed request can terminate
 *     TallyPrime").
 *   - Even so: one request at a time, a health probe between every candidate,
 *     abort the moment Tally stops answering, controls at both ends. Same
 *     discipline as scripts/probe-reports.ts and
 *     docs/report-id-verification.md, applied conservatively anyway.
 *   - The verdict is legible without printing company data: Cash Flow returns
 *     one row per month, so "does a 3-month request return 3 rows or 9" is
 *     answerable from a ROW COUNT, never from the figures themselves.
 *
 * BEFORE RUNNING: save your work in TallyPrime.
 *
 *   TALLY_PROBE_CONFIRM=yes npm run probe:period
 */

import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import { buildConnectionProbeRequest } from '../src/tally/requests.js';
import { isoToTallyDate } from '../src/utils/dates.js';
import { normalizeMonthlyFlow } from '../src/tally/normalize.js';

/** The three-month window used throughout. Any period narrower than a full
 * financial year works as a test; three months makes an over-wide result
 * (9, 12) obviously distinguishable from a correct one (3). */
const FROM = '2025-07-01';
const TO = '2025-09-30';
const EXPECTED_ROWS_IF_FIXED = 3;

/**
 * The same envelope buildReportRequest emits, with one addition: an arbitrary
 * extra child element inside STATICVARIABLES. Kept local and separate from
 * production code on purpose — this is a one-off experiment, not a shape any
 * tool should send by default until a candidate is confirmed.
 */
function reportRequestWithExtra(reportId: string, extraXml: string): string {
  const staticVars = [
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVFROMDATE>${isoToTallyDate(FROM)}</SVFROMDATE>`,
    `<SVTODATE>${isoToTallyDate(TO)}</SVTODATE>`,
    extraXml,
  ].join('');

  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Data</TYPE>',
    `<ID>${reportId}</ID>`,
    '</HEADER>',
    '<BODY><DESC>',
    `<STATICVARIABLES>${staticVars}</STATICVARIABLES>`,
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

interface Candidate {
  label: string;
  extraXml: string;
  why: string;
}

/**
 * Each tries ONE additional static variable on top of the baseline that is
 * already known to under-bind. None of these is documented for this report ID
 * — they are informed guesses about TallyPrime's own TDL variable names, which
 * is exactly what makes this an experiment rather than a known fix.
 */
const CANDIDATES: Candidate[] = [
  {
    label: 'baseline (reproduce the known bug)',
    extraXml: '',
    why: 'Control. Must reproduce the documented 9-months-for-3-requested result, or the rest of this run cannot be trusted.',
  },
  {
    label: '+ SVCURRENTDATE',
    extraXml: `<SVCURRENTDATE>${isoToTallyDate(TO)}</SVCURRENTDATE>`,
    why: 'Some Tally balance-style reports read an "as on" date from SVCURRENTDATE rather than SVTODATE.',
  },
  {
    label: '+ SVISPERIODICREPORT',
    extraXml: '<SVISPERIODICREPORT>Yes</SVISPERIODICREPORT>',
    why: 'Guess: an explicit flag distinguishing a ranged report from a cumulative-to-date one.',
  },
  {
    label: '+ SVVIEWNAME Monthly',
    extraXml: '<SVVIEWNAME>Monthly</SVVIEWNAME>',
    why: 'Cash Flow already renders monthly; forcing the view explicitly might also bind the range.',
  },
  {
    label: 'SVPERIODFROM/SVPERIODTO instead of SVFROMDATE/SVTODATE',
    // Note: this candidate REPLACES the baseline pair rather than adding to it,
    // built as a full custom envelope below rather than via the shared helper.
    extraXml: '__REPLACE__',
    why: 'Guess: the variable pair actually honoured for a bounded range differs from the one used for master/voucher requests.',
  },
  {
    label: '+ duplicate SVTODATE (last-wins test)',
    extraXml: `<SVTODATE>${isoToTallyDate(TO)}</SVTODATE>`,
    why: 'If Tally reads the LAST occurrence of a static variable, a duplicate is harmless; if the FIRST, this is a no-op. Cheap to rule out.',
  },
];

function replaceEnvelope(reportId: string): string {
  const staticVars = [
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVPERIODFROM>${isoToTallyDate(FROM)}</SVPERIODFROM>`,
    `<SVPERIODTO>${isoToTallyDate(TO)}</SVPERIODTO>`,
  ].join('');
  return [
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>',
    `<ID>${reportId}</ID></HEADER><BODY><DESC>`,
    `<STATICVARIABLES>${staticVars}</STATICVARIABLES>`,
    '</DESC></BODY></ENVELOPE>',
  ].join('');
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      [
        'Refusing to run without confirmation.',
        '',
        'This sends a small number of extra STATICVARIABLES entries alongside the',
        'already-verified "Cash Flow" report ID. Unknown static variables are silently',
        'ignored by TallyPrime rather than rejected, so this cannot wedge the app the way',
        'an undefined collection can — but save your work first regardless, then:',
        '',
        '  TALLY_PROBE_CONFIRM=yes npm run probe:period',
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '8000', TALLY_CACHE_TTL_MS: '0' });
  const client = new TallyClient(config, createLogger('error'));

  console.log(`Probing ${config.tallyBaseUrl}`);
  console.log(`Requesting ${FROM} to ${TO} (3 months) on "Cash Flow" — the known-bad baseline returns 9.\n`);

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

  let fixFound = false;

  for (const candidate of CANDIDATES) {
    const body =
      candidate.extraXml === '__REPLACE__'
        ? replaceEnvelope('Cash Flow')
        : reportRequestWithExtra('Cash Flow', candidate.extraXml);

    let rows = -1;
    let errorMessage: string | null = null;

    try {
      const response = await client.send(body, 'report');
      const { data } = normalizeMonthlyFlow(response.body, 'cash flow');
      rows = data.length;
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    const verdict =
      errorMessage !== null
        ? `ERROR: ${errorMessage}`
        : rows === EXPECTED_ROWS_IF_FIXED
          ? '*** BOUND CORRECTLY — candidate works ***'
          : `${String(rows)} rows (still unbound)`;

    console.log(`${candidate.label.padEnd(42)} ${verdict}`);
    console.log(`  ${candidate.why}`);

    if (candidate.label.startsWith('baseline')) {
      const baselineConfirmed = rows !== EXPECTED_ROWS_IF_FIXED && errorMessage === null;
      if (!baselineConfirmed) {
        console.error(
          '\n  ^ Baseline did not reproduce the documented bug. Either it is already fixed ' +
            '(check TallyPrime version) or something about this run differs from the ' +
            'original finding. Treat every line below as unreliable and stop.'
        );
        return;
      }
    } else if (rows === EXPECTED_ROWS_IF_FIXED) {
      fixFound = true;
    }

    if (!(await healthy())) {
      console.error('\nTallyPrime stopped answering. ABORTING — do not re-run until it is back.');
      process.exitCode = 1;
      return;
    }
  }

  console.log('');
  if (fixFound) {
    console.log(
      'A candidate bound the range correctly. Confirm it holds for Trial Balance and ' +
        'Profit and Loss too (same STATICVARIABLES mechanism, different report ID) before ' +
        'wiring it into src/tally/requests.ts, and re-run tests/tools/v3.test.ts plus ' +
        '`npm run check:live` afterward.'
    );
  } else {
    console.log(
      'No candidate bound the range. This is a real, useful result: it means the fix is not ' +
        'a missing STATICVARIABLES entry discoverable this way, and the current mitigation ' +
        '(refuse mid-year comparison, flag mid-year statements as cumulative) should stand ' +
        'rather than be revisited with more guesses. Record this attempt in ' +
        'docs/known-limitations.md so nobody re-runs the same experiment.'
    );
  }
}

await main();
