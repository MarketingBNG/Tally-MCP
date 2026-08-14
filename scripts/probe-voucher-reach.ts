/**
 * Can vouchers from a PAST financial year be reached at all, and can a
 * collection be filtered server-side?
 *
 * Background, measured live against MUDALS TECHNOLOGIES PRIVATE LIMITED
 * (books 2021-04-01 .. 2026-07-28, today 2026-08-14):
 *
 *   - The `AllVouchers` collection this server uses returned vouchers for
 *     2026-04 .. 2026-07 ONLY — the current financial year — when asked for the
 *     full 2021-04-01 .. 2026-07-28 span.
 *   - Historical data demonstrably exists: the Profit and Loss report returns
 *     real Indirect Expenses for FY 2023-24.
 *   - So five financial years of transactions are currently unreachable, and
 *     every voucher-derived tool reports its four-month answer as complete.
 *
 * `known-limitations.md` records the collection as ignoring SVFROMDATE/SVTODATE
 * and returning "the whole book". This measurement says something narrower and
 * worse: it returns the CURRENT financial year. A filter cannot fix that, because
 * a filter narrows a collection and never widens it — so this probes two
 * genuinely different mechanisms rather than assuming one.
 *
 * STAGE 1 — the report class, which is the SAFE class.
 *   `Day Book` is documented by Tally itself and is a named report, so an
 *   unknown-ID rejection is harmless. This server deliberately does not expose
 *   it (`known-limitations.md`: date range ignored, no ledger entries), but that
 *   was assessed for a different purpose. The question here is only: does it
 *   reach a PAST year? If it does, a historical route exists even if the entry
 *   detail has to come from elsewhere.
 *   `Ledger Vouchers` is included for the same reason — also officially
 *   documented, also never tried here.
 *
 * STAGE 2 — the collection class, with an inline TDL definition.
 *   Every request carries a full <COLLECTION> definition under <TDLMESSAGE>.
 *   A BARE collection name with no definition is the request form recorded in
 *   probe-reports.ts as closing TallyPrime, and nothing here sends one.
 *   Two variants: a <FILTER> narrowing inside the current year, which proves
 *   whether the filter syntax works at all; and the same filter aimed at a past
 *   year, which tests whether a filter can escape the current-year scope. The
 *   expected answer to the second is no, and confirming that is the point.
 *
 * STAGE 3 — the dotted sub-collection type (`Voucher.AllLedgerEntries`).
 *   The mechanism `tally-database-loader` uses in production, and the one that
 *   unlocks cost centres, bill allocations and batch detail. Probed last because
 *   it is the least familiar shape, and only if Tally is still healthy.
 *
 * SAFETY: one request at a time, cache off, an 8s timeout so a wedge shows up
 * fast, and a health probe after EVERY request that aborts the whole run on the
 * first non-answer. Counts and structural markers only — no amounts, names or
 * narrations are printed, because this output is meant to be quotable in
 * docs/known-limitations.md.
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-voucher-reach.ts
 */

import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { TallyClient } from '../src/tally/TallyClient.js';
import {
  buildConnectionProbeRequest,
  buildReportRequest,
  buildVoucherCollectionRequest,
} from '../src/tally/requests.js';

/** A past year known to hold data, and the current year as the control. */
const PAST = { from: '2023-04-01', to: '2024-03-31' };
const CURRENT = { from: '2026-04-01', to: '2026-07-31' };

/** Count voucher-shaped records without parsing them. */
function voucherCount(body: string): number {
  const xml = [...body.matchAll(/<VOUCHER\b/gi)].length;
  const json = [...body.matchAll(/"VOUCHER"\s*:/gi)].length;
  return Math.max(xml, json);
}

/** Count ledger-entry-shaped records, for the sub-collection stage. */
function entryCount(body: string): number {
  return Math.max(
    [...body.matchAll(/<ALLLEDGERENTRIES\.LIST\b/gi)].length,
    [...body.matchAll(/<LEDGERENTRIES\.LIST\b/gi)].length,
    [...body.matchAll(/<LEDGERNAME\b/gi)].length
  );
}

/** The earliest and latest date-looking value present, to show the span reached. */
function dateSpan(body: string): string {
  const dates = [...body.matchAll(/<DATE>(\d{8})<\/DATE>/gi)]
    .map((match) => match[1] ?? '')
    .filter((value) => value.length === 8)
    .sort();
  if (dates.length === 0) return '(no DATE tags)';
  return `${dates[0] ?? '?'} .. ${dates[dates.length - 1] ?? '?'}`;
}

/**
 * A voucher collection carrying an explicit date FILTER.
 *
 * The definition is always present — this is never a bare collection name. The
 * filter compares `$Date` against the period variables Tally itself populates
 * from SVFROMDATE/SVTODATE, which is the documented way to scope a collection.
 */
function filteredVoucherRequest(fromIso: string, toIso: string): string {
  const from = fromIso.replace(/-/g, '');
  const to = toIso.replace(/-/g, '');

  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Collection</TYPE>',
    '<ID>ProbeFilteredVouchers</ID>',
    '</HEADER>',
    '<BODY><DESC>',
    '<STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVFROMDATE>${from}</SVFROMDATE>`,
    `<SVTODATE>${to}</SVTODATE>`,
    '</STATICVARIABLES>',
    '<TDL><TDLMESSAGE>',
    '<COLLECTION NAME="ProbeFilteredVouchers" ISMODIFY="No" ISFIXED="No">',
    '<TYPE>Voucher</TYPE>',
    '<FETCH>Date,VoucherTypeName,VoucherNumber</FETCH>',
    '<FILTER>ProbeDateRange</FILTER>',
    '</COLLECTION>',
    '<SYSTEM TYPE="Formulae" NAME="ProbeDateRange">',
    '$Date &gt;= @@SVFROMDATE AND $Date &lt;= @@SVTODATE',
    '</SYSTEM>',
    '</TDLMESSAGE></TDL>',
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

/**
 * A dotted sub-collection: ledger entries as their own collection TYPE.
 *
 * Always with a definition. This is the shape tally-database-loader relies on;
 * if it works, cost centres and bill allocations become reachable the same way.
 */
function subCollectionRequest(fromIso: string, toIso: string): string {
  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Collection</TYPE>',
    '<ID>ProbeLedgerEntries</ID>',
    '</HEADER>',
    '<BODY><DESC>',
    '<STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVFROMDATE>${fromIso.replace(/-/g, '')}</SVFROMDATE>`,
    `<SVTODATE>${toIso.replace(/-/g, '')}</SVTODATE>`,
    '</STATICVARIABLES>',
    '<TDL><TDLMESSAGE>',
    '<COLLECTION NAME="ProbeLedgerEntries" ISMODIFY="No" ISFIXED="No">',
    '<TYPE>Voucher.AllLedgerEntries</TYPE>',
    '<FETCH>LedgerName,Amount</FETCH>',
    '</COLLECTION>',
    '</TDLMESSAGE></TDL>',
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

function classify(body: string): string {
  if (/<LINEERROR>/i.test(body)) {
    const message = /<LINEERROR>([^<]*)<\/LINEERROR>/i.exec(body)?.[1] ?? '';
    return `REJECTED (${message.slice(0, 60)})`;
  }
  if (/server is running/i.test(body)) return 'LIVENESS (not a data reply)';
  if (/^\s*<ENVELOPE>\s*<\/ENVELOPE>\s*$/i.test(body)) return 'EMPTY';
  return 'data';
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      [
        'Refusing to run without confirmation.',
        '',
        'Stage 1 sends documented REPORT ids (safe class). Stages 2 and 3 send',
        'COLLECTIONS — always WITH an inline TDL definition, never a bare name,',
        'because a bare collection name is the form recorded as closing Tally.',
        'The residual risk is lost UNSAVED work. Save it, then re-run with:',
        '',
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-voucher-reach.ts',
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ ...process.env, TALLY_TIMEOUT_MS: '8000', TALLY_CACHE_TTL_MS: '0' });
  const client = new TallyClient(config, createLogger('error'));

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

  let aborted = false;

  const attempt = async (label: string, body: string, kind: 'report' | 'standard'): Promise<void> => {
    if (aborted) return;
    try {
      const response = await client.send(body, kind);
      const bytes = Buffer.byteLength(response.body, 'utf8');
      console.log(
        `  ${label.padEnd(46)} ${classify(response.body).padEnd(22)} ` +
          `${String(bytes).padStart(9)}B  vouchers=${String(voucherCount(response.body)).padStart(4)}  ` +
          `entries=${String(entryCount(response.body)).padStart(5)}  dates=${dateSpan(response.body)}`
      );
    } catch (error) {
      console.log(`  ${label.padEnd(46)} ERROR  ${(error as Error).message}`);
    }

    if (!(await healthy())) {
      console.error('\n*** TallyPrime STOPPED ANSWERING. Aborting the run. ***');
      console.error(`*** The last request sent was: ${label} ***`);
      aborted = true;
      process.exitCode = 1;
    }
  };

  console.log('STAGE 1 — documented report IDs (safe class): can a PAST year be reached?');
  await attempt(
    `Day Book, past year ${PAST.from}..${PAST.to}`,
    buildReportRequest('Day Book', { ...toOpts(PAST), format: config.tallyPreferredFormat }),
    'report'
  );
  await attempt(
    `Day Book, current year ${CURRENT.from}..${CURRENT.to}`,
    buildReportRequest('Day Book', { ...toOpts(CURRENT), format: config.tallyPreferredFormat }),
    'report'
  );
  await attempt(
    `Ledger Vouchers, past year`,
    buildReportRequest('Ledger Vouchers', { ...toOpts(PAST), format: config.tallyPreferredFormat }),
    'report'
  );

  console.log('\nSTAGE 2 — voucher COLLECTION (always with inline TDL definition)');
  await attempt(
    'control: shipped builder, past year',
    buildVoucherCollectionRequest(toOpts(PAST)),
    'standard'
  );
  await attempt(
    'with <FILTER> $Date, current year (does filter work?)',
    filteredVoucherRequest(CURRENT.from, CURRENT.to),
    'standard'
  );
  await attempt(
    'with <FILTER> $Date, past year (can filter escape?)',
    filteredVoucherRequest(PAST.from, PAST.to),
    'standard'
  );

  console.log('\nSTAGE 3 — dotted sub-collection type Voucher.AllLedgerEntries');
  await attempt(
    'Voucher.AllLedgerEntries, current year',
    subCollectionRequest(CURRENT.from, CURRENT.to),
    'standard'
  );

  if (!aborted) {
    console.log(
      [
        '',
        'Done. TallyPrime answered throughout.',
        '',
        'Reading this:',
        '  - Any row whose dates= span falls in 2023/2024 proves a PAST year is reachable',
        '    by that route, which is the finding that matters most.',
        '  - "with <FILTER>, current year" returning FEWER vouchers than the control proves',
        '    the filter syntax works and can scope a collection server-side.',
        '  - "with <FILTER>, past year" returning 0 confirms a filter narrows but cannot',
        '    widen — i.e. the current-year scope is imposed before the filter runs.',
        '  - STAGE 3 with entries>0 confirms the dotted sub-collection mechanism, which is',
        '    what cost centres, bill allocations and batch detail all depend on.',
      ].join('\n')
    );
  }
}

/** ISO pair -> the builder's option shape. Kept tiny and local for clarity. */
function toOpts(range: { from: string; to: string }): { fromDate: string; toDate: string } {
  return { fromDate: range.from, toDate: range.to };
}

await main();
