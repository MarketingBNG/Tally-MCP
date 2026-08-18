#!/usr/bin/env node
/**
 * Is TallyPrime's Edit Log reachable over the HTTP interface, and failing that,
 * what audit metadata does a VOUCHER actually carry?
 *
 *   TALLY_PROBE_COMPANY="Some Company" node scripts/probe-editlog.mjs
 *
 * ## Why this exists
 *
 * SA 240 asks for evidence about journal entries and management override, and CARO
 * Rule 11(g) asks for a positive report that the audit trail was on all year. The
 * connector cannot answer either. `ALTERID` shows THAT a voucher changed relative to
 * a baseline, never who changed it, when, or from what.
 *
 * docs/probe-findings-2026-08-14.md finding 5 settled half of this: no Edit Log
 * report ID exists, and the audit containers on `List of Accounts` are empty
 * scaffolding. It left one thing explicitly untested — whether the same field names
 * are POPULATED at voucher level. That is what part two below answers, and it is the
 * only remaining place a voucher-level "who and when" could come from.
 *
 * ## What it may NOT do
 *
 * REPORT IDs ONLY in part one (`TYPE=Data`). An unrecognised report ID is refused
 * with a clean `<LINEERROR>` — established over 23 live requests, see
 * docs/report-id-verification.md. An unrecognised collection `<TYPE>` is a different
 * failure class: it parks Tally behind a modal dialog that blocks HTTP until a human
 * dismisses it, and cost two restarts to learn. So nothing here guesses a TYPE. Part
 * two sends `<TYPE>Voucher</TYPE>`, which is already in production use in this
 * server; only the FETCH field names vary, and an unsupported native method fails
 * OPEN — Tally omits it rather than erroring (verified 2026-08-13 on
 * BaseCurrencySymbol). A missing tag therefore means "not served", never "not set".
 *
 * If the Edit Log turns out to be collection-only, that is this probe's ANSWER, not
 * a reason to widen it.
 *
 * Read-only: every request is `TALLYREQUEST=Export`. A health probe runs between
 * report candidates so a hang is attributable to the request that caused it.
 *
 * TAG NAMES AND COUNTS ONLY — never values. Printing a real username or timestamp
 * would put company data into output meant to be quoted in a public repo, which
 * tests/fixtures/noRealData.test.ts exists to prevent.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildReportRequest, buildCompanyListRequest, buildConnectionProbeRequest } = await import(
  pathToFileURL(`${ROOT}/dist/tally/requests.js`).href
);
const { normalizeCompanies } = await import(pathToFileURL(`${ROOT}/dist/tally/normalize.js`).href);

async function post(body) {
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:9000', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    body,
    signal: AbortSignal.timeout(60000),
  });
  const raw = Buffer.from(await response.arrayBuffer());
  const text =
    raw.length > 1 && raw[1] === 0
      ? new TextDecoder('utf-16le').decode(raw)
      : new TextDecoder('utf-8').decode(raw);
  return { text, ms: Date.now() - started, bytes: raw.byteLength };
}

const companies = normalizeCompanies((await post(buildCompanyListRequest())).text).data;
const wanted = process.env.TALLY_PROBE_COMPANY;
const loaded =
  wanted === undefined
    ? companies.length === 1
      ? companies[0]
      : undefined
    : companies.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
if (!loaded) {
  console.error(
    '\nName the company with TALLY_PROBE_COMPANY. Loaded:\n' +
      companies.map((c) => `  - ${c.name}`).join('\n')
  );
  process.exit(1);
}

const startYear = Number((loaded.startingFrom ?? '2025-04-01').slice(0, 4));
const startMonth = (loaded.startingFrom ?? '2025-04-01').slice(5, 7);
// Follow the company's own year rather than assuming April: a calendar-year company
// probed on an April..March window reads as having no vouchers at all.
const period =
  startMonth === '01'
    ? { fromDate: `${String(startYear)}-01-01`, toDate: `${String(startYear)}-12-31` }
    : { fromDate: `${String(startYear)}-04-01`, toDate: `${String(startYear + 1)}-03-31` };
const opts = { ...period, company: loaded.name, format: 'xml' };

console.log(`\nCompany: ${loaded.name}`);
console.log(`Period:  ${period.fromDate} to ${period.toDate}`);

/* ---------------------------------------------------------------- part one --- */

/**
 * The candidate report names, and one deliberate control.
 *
 * The names are what TallyPrime calls these views in its own menus, plus the
 * spellings a report ID plausibly differs on. The CONTROL is a name invented to be
 * wrong: if it comes back looking like a success, the probe cannot tell a working
 * report from a refused one and no verdict below means anything.
 */
const CONTROL = 'Zzz Not A Report Control';
const candidates = [
  'Edit Log',
  'Edit Log Summary',
  'Edit Log Report',
  'Voucher Edit Log',
  'Edit Log for Vouchers',
  'List of Alterations',
  'Alteration Register',
  'Alteration Summary',
  'Audit Trail',
  'Voucher Audit Trail',
  'Edit Log Vouchers',
  CONTROL,
];

console.log('\n=== Part one: is there an Edit Log report ID? ===\n');
const results = [];
for (const name of candidates) {
  let outcome;
  try {
    const r = await post(buildReportRequest(name, opts));
    const lineError = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/.exec(r.text);
    outcome = {
      name,
      verdict: lineError ? 'REFUSED' : r.bytes < 200 ? 'EMPTY' : 'ANSWERED',
      bytes: r.bytes,
    };
  } catch (error) {
    outcome = { name, verdict: 'ERROR', bytes: 0, detail: String(error) };
  }
  results.push(outcome);
  console.log(`${outcome.verdict.padEnd(9)} ${String(outcome.bytes).padStart(8)}B  ${name}`);

  // Health probe between candidates: a hang has to be attributable.
  try {
    await post(buildConnectionProbeRequest());
  } catch {
    console.error(`\n*** Tally stopped answering after "${name}". STOPPING. ***`);
    process.exit(1);
  }
}

const control = results.find((r) => r.name === CONTROL);
if (control?.verdict !== 'REFUSED') {
  console.log(
    `\n*** The control name came back ${control?.verdict ?? '?'}, not REFUSED. The probe\n` +
      '    cannot distinguish a real report from a rejected one — every verdict above\n' +
      '    is unreliable. ***'
  );
}
const answered = results.filter((r) => r.verdict === 'ANSWERED' && r.name !== CONTROL);
console.log(
  `\n${String(answered.length)} of ${String(candidates.length - 1)} candidate names answered.`
);

/* ---------------------------------------------------------------- part two --- */

const tallyDate = (iso) => iso.replaceAll('-', '');
function voucherAuditRequest(fields) {
  return [
    '<ENVELOPE><HEADER><VERSION>1</VERSION>',
    '<TALLYREQUEST>Export</TALLYREQUEST>',
    '<TYPE>Collection</TYPE><ID>AuditProbeVouchers</ID></HEADER>',
    '<BODY><DESC><STATICVARIABLES>',
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    `<SVCURRENTCOMPANY>${loaded.name.replaceAll('&', '&amp;')}</SVCURRENTCOMPANY>`,
    `<SVFROMDATE>${tallyDate(period.fromDate)}</SVFROMDATE>`,
    `<SVTODATE>${tallyDate(period.toDate)}</SVTODATE>`,
    '</STATICVARIABLES><TDL><TDLMESSAGE>',
    '<COLLECTION NAME="AuditProbeVouchers" ISMODIFY="No" ISFIXED="No">',
    '<TYPE>Voucher</TYPE>',
    `<FETCH>${fields.join(',')}</FETCH>`,
    '</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>',
  ].join('');
}

const AUDIT_FIELDS = [
  'Date',
  'GUID',
  'MasterId',
  'AlterId',
  'VoucherNumber',
  'EnteredBy',
  'AlteredBy',
  'CreatedBy',
  'UpdatedDateTime',
  'Audited',
  'IsCancelled',
  'IsDeleted',
  'IsDeletedVchRetained',
  'IsSecurityOnWhenEntered',
  'PersistedView',
];

// A literal space rather than `\s`: this pattern is BUILT from a string, and an
// escape that survives the source but not the build reads as "field not served" for
// a field that is plainly there. That artifact produced a wrong verdict once.
function tag(block, name) {
  const m = new RegExp('<' + name + '( [^>]*)?>([^<]*)</' + name + '>').exec(block);
  return m === null ? null : m[2].trim();
}

console.log('\n=== Part two: what does a VOUCHER carry? ===\n');
const vr = await post(voucherAuditRequest(AUDIT_FIELDS));
const blocks = [
  ...vr.text
    // CMPINFO carries a `<VOUCHER>0</VOUCHER>` counter that a block match counts as
    // a voucher, reporting data where there is none.
    .replace(/<CMPINFO>[\s\S]*?<\/CMPINFO>/g, '')
    .matchAll(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/g),
]
  .map((m) => m[0])
  .filter((b) => tag(b, 'DATE') !== null);

console.log(`${String(blocks.length)} voucher(s), ${String(vr.bytes)}B\n`);
if (blocks.length === 0) {
  console.log('No vouchers in this period, so part two is INCONCLUSIVE, not negative.');
  process.exit(0);
}

console.log('FIELD                     populated/total  verdict');
for (const field of AUDIT_FIELDS) {
  const values = blocks.map((b) => tag(b, field.toUpperCase()));
  const served = values.filter((v) => v !== null).length;
  const populated = values.filter((v) => v !== null && v !== '').length;
  const verdict = served === 0 ? 'NOT SERVED' : populated === 0 ? 'SERVED BUT EMPTY' : 'POPULATED';
  console.log(
    `${field.padEnd(26)}${`${String(populated)}/${String(blocks.length)}`.padEnd(17)}${verdict}`
  );
}

/**
 * `UpdatedDateTime` needs more than a populated/empty verdict, because it is the one
 * field here that could substitute for part of the Edit Log — and it has two ways of
 * being useless. It comes back as an all-zero placeholder on some companies, and even
 * when stamped it could be a single bulk migration event repeated onto every record
 * rather than a per-voucher stamp. Distinct-stamp counts separate the two.
 */
const stamps = blocks
  .map((b) => tag(b, 'UPDATEDDATETIME'))
  .filter((u) => u !== null && u !== '' && !/^0+$/.test(u) && u.length >= 14);
const dates = blocks.map((b) => tag(b, 'DATE'));
console.log('\nUpdatedDateTime in detail:');
console.log(`  real timestamps            ${String(stamps.length)}/${String(blocks.length)}`);
if (stamps.length > 0) {
  const day = (u) => u.slice(0, 8);
  const distinctDays = [...new Set(stamps.map(day))].sort();
  console.log(`  distinct full stamps       ${String(new Set(stamps).size)}`);
  console.log(`  distinct calendar days     ${String(distinctDays.length)}`);
  console.log(`  stamp day span             ${distinctDays[0]} .. ${distinctDays.at(-1)}`);
  const later = blocks.filter((b, i) => {
    const u = tag(b, 'UPDATEDDATETIME');
    return u !== null && u.length >= 14 && !/^0+$/.test(u) && day(u) > (dates[i] ?? '');
  }).length;
  console.log(`  stamped after voucher date ${String(later)}/${String(blocks.length)}`);
  console.log(
    '\n  Many distinct stamps over few calendar days = a real per-voucher stamp from a\n' +
      '  handful of keying sessions. ONE distinct stamp = a bulk event, and nothing\n' +
      '  voucher-specific can be read from it.'
  );
}
