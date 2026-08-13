#!/usr/bin/env node
/**
 * Live acceptance run against a real TallyPrime.
 *
 *   npm run check:live              -- shipped limits, the run that counts
 *   npm run check:live -- --raised  -- ceilings raised, to see whole answers
 *   npm run check:live -- --out=path/to/dir
 *
 * ## Why this exists as a script rather than a one-off
 *
 * Two paths in the tools it covers CANNOT be verified on any company available so
 * far: `reconciled: true` on the bank tool needs a company that reconciles its
 * bank inside TallyPrime, and the ageing schedule needs one that keeps bill-wise
 * details. See docs/known-limitations.md. When such a company turns up, this is
 * the thing to run against it, and the two summary lines at the end say directly
 * whether the gap closed.
 *
 * ## Safety, because this talks to books someone may have unsaved work in
 *
 * - Imports `dist/`, not `src/`: that is the artefact Claude Desktop launches, so
 *   a pass here is a pass on what ships. Run `npm run build` first.
 * - Every call is awaited in sequence. TallyPrime's HTTP listener serves one
 *   request at a time; concurrency causes blocking, timeouts and truncated bodies.
 * - It sends NO report or collection ID that is not already verified against a
 *   live install — it only calls registered tools, which only use the builders in
 *   src/tally/requests.ts. A guessed ID can raise a modal and terminate
 *   TallyPrime, taking unsaved work with it; that is why nothing here improvises.
 * - It ABORTS on the first connection-class failure rather than continuing. One
 *   wedged request poisons a session, and a run that keeps going would report a
 *   cascade of failures with one real cause.
 * - Cheapest calls first; a one-month range before a full year.
 *
 * ## What it cannot tell you
 *
 * Nothing here compares a figure against TallyPrime's own screen. The trial
 * balance reconciliation in docs/project-status.md was done by eye and remains the
 * only check of that kind.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// fileURLToPath, not hand-rolled URL parsing: this repo's own install path
// contains a space ("Kirti Arora"), and decoding it by hand leaves the %20 to be
// re-encoded on the way back out. The installer scripts hit the same hazard,
// which is why they resolve paths rather than assembling them.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const useRaised = args.includes('--raised');
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = resolve(outArg ? outArg.slice('--out='.length) : `${ROOT}/.live-check`);

const dist = async (rel) => {
  try {
    return await import(pathToFileURL(`${ROOT}/dist/${rel}`).href);
  } catch (error) {
    console.error(
      `\nCould not load dist/${rel}. Run "npm run build" first — this script deliberately\n` +
        'exercises the built output, because that is what Claude Desktop launches.\n'
    );
    throw error;
  }
};

const { loadConfig } = await dist('config/config.js');
const { createLogger } = await dist('utils/logger.js');
const { TallyClient } = await dist('tally/TallyClient.js');

// Every tool module, so a new tool is covered by adding one line below rather
// than by remembering to wire up a registrar.
const modules = await Promise.all(
  [
    'connection',
    'companies',
    'ledgers',
    'groups',
    'vouchers',
    'voucherTypes',
    'bankReconciliation',
    'outstanding',
    'reports',
  ].map((name) => dist(`tools/${name}.js`))
);

const handlers = new Map();
const schemas = new Map();
const server = {
  registerTool(name, config, handler) {
    handlers.set(name, handler);
    schemas.set(name, config.inputSchema);
    return { name };
  },
  registerResource: () => ({ name: 'resource' }),
};

const config = loadConfig({
  TALLY_HOST: process.env.TALLY_HOST ?? '127.0.0.1',
  TALLY_PORT: process.env.TALLY_PORT ?? '9000',
  LOG_LEVEL: 'error',
  ...(useRaised
    ? {
        // Only for reading whole answers out of a diagnostic. A run in this mode
        // cannot catch a tool that works ONLY with the ceilings raised, which is
        // why it is not the default.
        TALLY_REPORT_TIMEOUT_MS: '300000',
        TALLY_TIMEOUT_MS: '60000',
        TALLY_MAX_RESPONSE_BYTES: '20000000',
        TALLY_MAX_RECORDS: '20000',
      }
    : { TALLY_REPORT_TIMEOUT_MS: '300000' }),
});
const logger = createLogger('error');
const deps = { client: new TallyClient(config, logger), config, logger };

for (const mod of modules) {
  for (const exported of Object.values(mod)) {
    if (typeof exported === 'function' && exported.name.startsWith('register')) {
      exported(server, deps);
    }
  }
}

mkdirSync(OUT, { recursive: true });

const ABORT_CODES = new Set([
  'TALLY_NOT_RUNNING',
  'TALLY_CONNECTION_FAILED',
  'TALLY_TIMEOUT',
  'TALLY_AUTHENTICATION_ERROR',
]);

const results = [];
let aborted = null;

async function run(label, tool, args = {}, expect = 'ok') {
  if (aborted) {
    results.push({ label, tool, skipped: true });
    console.log(`  skipped (aborted)             ${label}`);
    return null;
  }

  const handler = handlers.get(tool);
  if (!handler) throw new Error(`Tool "${tool}" is not registered — is dist/ stale?`);

  const startedAt = Date.now();
  let output;
  try {
    output = await handler(schemas.get(tool)?.parse(args) ?? args);
  } catch (error) {
    aborted = `${tool} threw ${String(error)}`;
    console.log(`  THREW                         ${label}`);
    return null;
  }

  const elapsedMs = Date.now() - startedAt;
  const text = output.content?.[0]?.text ?? '{}';
  const payload = JSON.parse(text);
  const failed = output.isError === true;
  const code = payload.error?.code ?? null;
  if (failed && ABORT_CODES.has(code)) aborted = `${tool} returned ${code}`;

  writeFileSync(`${OUT}/${label}.json`, JSON.stringify(payload, null, 2), 'utf-8');

  // `expect` records intent: some of these calls SHOULD fail, and a run where a
  // guard rail quietly started passing is a regression, not a success.
  const asExpected = expect === 'ok' ? !failed : failed && code === expect;
  results.push({ label, tool, args, ok: !failed, code, expect, asExpected, elapsedMs, file: `${label}.json` });

  console.log(
    `  ${(asExpected ? 'ok' : 'UNEXPECTED').padEnd(12)}${(failed ? code : '').padEnd(30)}` +
      `${label.padEnd(30)}${String(elapsedMs).padStart(7)}ms ${String(
        Math.round(Buffer.byteLength(text, 'utf-8') / 1024)
      ).padStart(5)}KB`
  );

  return failed ? null : payload.data;
}

// ---------------------------------------------------------------------------

console.log(
  useRaised
    ? '\nRAISED CEILINGS (diagnostic mode — not an acceptance run)'
    : `\nSHIPPED LIMITS: maxResponseBytes=${String(config.tallyMaxResponseBytes)} maxRecords=${String(config.tallyMaxRecords)}`
);
console.log(`Endpoint: ${config.tallyBaseUrl}\nOutput:   ${OUT}\n`);

console.log('Reachability and orientation');
await run('01-connection', 'tally_connection_status');
const companies = await run('02-companies', 'tally_list_companies');

const loaded = companies?.companies?.[0];
if (!loaded) {
  console.log('\nNo company is loaded in TallyPrime. Open one and re-run — every check below needs it.');
  process.exit(1);
}

/**
 * Period comes from the LOADED COMPANY's own financial year, not from today.
 *
 * This is the trap in docs/known-limitations.md: firms keep one company per
 * financial year, so a company whose year has passed returns zero rows for every
 * date-defaulted query. Deriving the period from `startingFrom` means this script
 * keeps working next April instead of quietly testing an empty range.
 */
const startYear = Number((loaded.startingFrom ?? '2025-04-01').slice(0, 4));
const fy = { fromDate: `${String(startYear)}-04-01`, toDate: `${String(startYear + 1)}-03-31` };
const q1 = { fromDate: `${String(startYear)}-04-01`, toDate: `${String(startYear)}-06-30` };
const q2 = { fromDate: `${String(startYear)}-07-01`, toDate: `${String(startYear)}-09-30` };
const month = { fromDate: `${String(startYear)}-04-01`, toDate: `${String(startYear)}-04-30` };

console.log(`\nCompany: "${loaded.name}", books from ${String(loaded.startingFrom)}`);
console.log(`Testing over ${fy.fromDate} to ${fy.toDate}\n`);

console.log('Voucher types');
const types = await run('03-voucher-types', 'tally_get_voucher_types');
await run('04-voucher-types-query', 'tally_get_voucher_types', { query: 'sales' });

console.log('\nStatements and comparison');
await run('05-tb-single', 'tally_get_statement', { statement: 'trial_balance', ...fy });

// A mid-year end date. TallyPrime ignores it and accumulates to the year end, so
// the answer must come back flagged rather than presented as the quarter's
// figures. See the END_DATE_NOTE in src/tools/reports.ts.
const midYear = await run('06-tb-mid-year', 'tally_get_statement', {
  statement: 'trial_balance',
  ...q2,
});

/**
 * Comparisons are only answerable when both sides run to the financial year end,
 * because that is the only shape where the requested period is the period Tally
 * actually covers. Two cumulative positions from different start dates is the
 * comparison that means something: "the year so far" against "from Q3 onward".
 */
const identical = await run('07-tb-compare-identical', 'tally_get_statement', {
  statement: 'trial_balance',
  ...fy,
  compareFromDate: fy.fromDate,
  compareToDate: fy.toDate,
});
await run('08-pl-compare-cumulative', 'tally_get_statement', {
  statement: 'profit_loss',
  ...fy,
  compareFromDate: q2.fromDate,
  compareToDate: fy.toDate,
});

console.log('\nBank reconciliation');
const bank = await run('09-bank-month', 'tally_get_bank_reconciliation', month);

/**
 * Deliberately over the response ceiling, to prove the recovery loop closes.
 *
 * The ceiling exists to stop one call dominating a conversation's context, and it
 * is only useful if the refusal tells the caller how to succeed. So this asks for
 * a page known to be too large, reads the pageSize the error computed from the
 * measured size, and retries with it. A refusal that cannot be acted on would be
 * no better than a truncated answer.
 */
const oversized = await run(
  '10-bank-year-oversized',
  'tally_get_bank_reconciliation',
  { ...fy, pageSize: 400 },
  'RESPONSE_TOO_LARGE'
);
let retried = null;
if (oversized === null) {
  const error = JSON.parse(readFileSync(`${OUT}/10-bank-year-oversized.json`, 'utf-8')).error ?? {};
  const suggested = Number(/pageSize (\d+)/.exec(String(error.suggestion))?.[1] ?? 0);
  console.log(`  (the refusal suggested pageSize ${String(suggested)}; retrying with it)`);
  if (suggested > 0) {
    retried = await run('11-bank-year-retried', 'tally_get_bank_reconciliation', {
      ...fy,
      pageSize: suggested,
    });
  }
}

console.log('\nOutstanding, with and without ageing');
await run('12-payable-plain', 'tally_get_outstanding', { side: 'payable', ...fy, pageSize: 200 });
const payableAgeing = await run('12b-payable-ageing', 'tally_get_outstanding', {
  side: 'payable',
  ...fy,
  includeAgeing: true,
  pageSize: 200,
});
const receivableAgeing = await run('13-receivable-ageing', 'tally_get_outstanding', {
  side: 'receivable',
  ...fy,
  includeAgeing: true,
  pageSize: 200,
});

console.log('\nGuard rails (these must fail, with the right code)');
await run(
  '14-half-comparison',
  'tally_get_statement',
  { statement: 'trial_balance', ...fy, compareFromDate: fy.fromDate },
  'INVALID_DATE_RANGE'
);
await run(
  '15-descending-buckets',
  'tally_get_outstanding',
  { side: 'payable', ...fy, includeAgeing: true, ageingBuckets: [90, 30] },
  'INVALID_PARAMETERS'
);
// The one that matters most. A mid-year comparison must refuse: both sides would
// accumulate to the same year end, so subtracting them yields minus the whole of
// the earlier period — a wrong figure of plausible size, which is worse than no
// answer. If this ever starts returning `ok`, the guard has been lost.
await run(
  '16-mid-year-comparison',
  'tally_get_statement',
  {
    statement: 'trial_balance',
    ...q2,
    compareFromDate: q1.fromDate,
    compareToDate: q1.toDate,
  },
  'TALLY_UNSUPPORTED_OPERATION'
);

// ---------------------------------------------------------------------------
// Assertions worth making automatically, because they are the ones a human
// skims past.
// ---------------------------------------------------------------------------

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : '*** FAIL ***'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

console.log('\nAssertions');

if (midYear) {
  check(
    'a mid-year statement is flagged as not covering the period requested',
    midYear.coversPeriodRequested === false,
    `figures actually cover to ${String(midYear.figuresActuallyCover?.toDate)}`
  );
  check(
    'and says so in a warning, not only in a flag',
    (midYear.warnings ?? []).some((w) => /ignores the end date/i.test(w))
  );
}

if (identical) {
  // Same period on both sides, so every paired figure must net to exactly zero.
  // The strongest single check on the pairing and the arithmetic: a mispairing
  // cannot survive it.
  const bad = [];
  for (const row of identical.comparison.changes) {
    for (const [column, figure] of Object.entries(row.figures)) {
      if (figure.change !== null && Number(figure.change.amount) !== 0) {
        bad.push(`${row.name}.${column}=${figure.change.amount}`);
      }
    }
  }
  check(
    'comparing a period with itself yields zero movement everywhere',
    bad.length === 0,
    bad.length ? bad.slice(0, 3).join(', ') : `${String(identical.comparison.changes.length)} rows paired`
  );
  check(
    'nothing was reported as ambiguous when both sides are the same statement',
    identical.comparison.unpaired.ambiguous.length === 0
  );
}

if (types) {
  const withSeries = types.items.filter((t) => t.numberingSeries.length > 0);
  check(
    'voucher types carry a numbering series from the nested list',
    withSeries.length > 0,
    `${String(withSeries.length)} of ${String(types.items.length)} types`
  );
  // The legacy scalar reads "None" on every type; seeing it would mean the fix
  // regressed. See docs/known-limitations.md.
  check(
    'no numbering series reports the legacy "None"',
    withSeries.every((t) => t.numberingSeries.every((s) => s.method !== 'None'))
  );
  const families = new Set(types.items.map((t) => t.parent));
  console.log(`  (this company defines ${String(types.items.length)} types across ${String(families.size)} base types)`);
}

if (bank) {
  const statuses = new Set(bank.items.map((r) => r.reconciled));
  check(
    'bank instruments were found to report on',
    bank.items.length > 0,
    `${String(bank.items.length)} instrument(s)`
  );
  check(
    'reconciled status is null exactly when no bank date is reported anywhere',
    bank.reconciliationStatusAvailable === !statuses.has(null),
    `statusAvailable=${String(bank.reconciliationStatusAvailable)}`
  );
  const leftoverZeros = bank.items.flatMap((r) =>
    Object.entries(r.instrument).filter(([k, v]) => k.startsWith('DENOMINATIONCOUNT') && Number(v) === 0)
  );
  check('zero denomination counters were dropped', leftoverZeros.length === 0);

  // Folding must be lossless: a constant lives in uniformFields instead of on
  // each row, so uniform + row must reconstruct what Tally sent.
  const uniform = bank.uniformFields ?? {};
  if (Object.keys(uniform).length > 0) {
    check(
      'folded instrument fields are absent from the rows that share them',
      bank.items.every((r) => Object.keys(uniform).every((k) => !(k in r.instrument))),
      `${String(Object.keys(uniform).length)} field(s) folded`
    );
    check(
      'and the response says where they went',
      (bank.warnings ?? []).some((w) => /uniformFields/.test(w))
    );
  }
}

// The recovery loop: a refusal is only useful if acting on it works.
if (retried) {
  check(
    'retrying at the pageSize the refusal computed succeeds',
    retried.items.length > 0,
    `${String(retried.items.length)} instrument(s) returned`
  );
}

for (const [side, data] of [
  ['payable', payableAgeing],
  ['receivable', receivableAgeing],
]) {
  if (!data) continue;
  const aged = data.items.filter((r) => r.ageing);
  const bucketed = aged.flatMap((r) => r.ageing.buckets).filter((b) => b.count > 0);
  check(
    `${side} ageing basis is stated in the response`,
    data.ageingBasis?.measure?.includes('not days overdue') === true
  );
  console.log(
    `  (${side}: ${String(aged.length)} of ${String(data.items.length)} parties have bills, ` +
      `${String(bucketed.length)} non-empty bucket(s))`
  );
}

// The two paths no available company can exercise. Reported as coverage, not as
// failures — but reported every run, so the day they finally light up is visible.
const bankDatesSeen = bank ? bank.reconciliationStatusAvailable === true : false;
const billsSeen = [payableAgeing, receivableAgeing].some((d) =>
  (d?.items ?? []).some((r) => r.ageing && r.ageing.buckets.some((b) => b.count > 0))
);

console.log('\nCoverage of the two paths that need a particular company');
console.log(
  `  reconciled:true      ${bankDatesSeen ? 'EXERCISED — this company reconciles its bank. Update docs/known-limitations.md.' : 'not exercised: this company records no bank statement dates'}`
);
console.log(
  `  ageing on real bills ${billsSeen ? 'EXERCISED — this company keeps bill-wise details. Update docs/known-limitations.md.' : 'not exercised: this company records no bill references'}`
);

const failed = checks.filter((c) => !c.pass);
const unexpected = results.filter((r) => !r.skipped && !r.asExpected);

writeFileSync(
  `${OUT}/summary.json`,
  JSON.stringify(
    {
      company: loaded.name,
      period: fy,
      mode: useRaised ? 'raised' : 'shipped',
      limits: { maxResponseBytes: config.tallyMaxResponseBytes, maxRecords: config.tallyMaxRecords },
      coverage: { reconciledTrue: bankDatesSeen, ageingOnRealBills: billsSeen },
      aborted,
      checks,
      results,
    },
    null,
    2
  ),
  'utf-8'
);

console.log(
  `\n${String(results.length)} calls, ${String(checks.length - failed.length)}/${String(checks.length)} assertions passed. Written to ${OUT}`
);
if (aborted) console.log(`ABORTED: ${aborted}`);
if (unexpected.length > 0) {
  console.log(`Unexpected outcomes: ${unexpected.map((r) => r.label).join(', ')}`);
}
if (aborted || failed.length > 0 || unexpected.length > 0) process.exitCode = 1;
