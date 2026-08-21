#!/usr/bin/env node
/**
 * Can an UNOBSERVED collection TYPE be asked for safely?
 *
 *   node scripts/probe-collection-types.mjs
 *
 * ## Read this before running it
 *
 * This is the probe the safety rule in docs/coverage.md exists to prevent.
 * Collection-type probing was **stopped after two hangs**: asking TallyPrime for
 * a `TYPE` it does not recognise parks it behind a modal dialog — "incorrect
 * object type" or similar — which it will sit behind, answering nothing, until
 * somebody clicks it. Everything else in this codebase treats that as a hard
 * boundary, which is why `CostCentre`, `CostCategory` and `Godown` master lists
 * are documented as unreachable rather than merely untried.
 *
 * So this script is deliberately awkward to run by accident, and it must only be
 * run when ALL of these hold:
 *
 *   1. **Somebody is watching the TallyPrime window** and can dismiss a dialog.
 *   2. **The scheduled export is DISABLED.** Otherwise a wedged Tally turns into
 *      a failure and a toast every single minute:
 *        schtasks /Change /TN "TallyPrime for Claude - Export" /DISABLE
 *   3. Ideally a scratch company is the smallest one loaded, so a wedge costs
 *      the least attention.
 *
 * ## What makes this safe ENOUGH to attempt at all
 *
 * The hazard is AVAILABILITY, not integrity. Every request is still
 * `TALLYREQUEST=Export` and cannot alter a thing; the worst case is a dialog
 * somebody has to click. So the design here is: one type at a time, a short
 * timeout, and a **health check between every probe**. The moment Tally stops
 * answering, the script stops asking — it does not work through the list making
 * a wedged install worse.
 *
 * The request itself comes from the server's own builder, never hand-written
 * XML, for the reason lib/probe.mjs records: a malformed request is its own way
 * of upsetting Tally.
 */

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { buildCollectionRequest, buildConnectionProbeRequest, UNSCOPED } = await import(
  pathToFileURL(`${ROOT}/dist/tally/requests.js`).href
);
const { normalizeCompanies } = await import(pathToFileURL(`${ROOT}/dist/tally/normalize.js`).href);
const { buildCompanyListRequest } = await import(pathToFileURL(`${ROOT}/dist/tally/requests.js`).href);

const ENDPOINT = 'http://127.0.0.1:9000';

/** Short on purpose: a wedged Tally should be detected in seconds, not minutes. */
const TIMEOUT_MS = 12_000;

async function post(body, label) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=utf-8' },
      body,
      signal: controller.signal,
    });
    const raw = Buffer.from(await response.arrayBuffer());
    const text =
      raw.length > 1 && raw[1] === 0
        ? new TextDecoder('utf-16le').decode(raw)
        : new TextDecoder('utf-8').decode(raw);
    return { ok: true, text, ms: Date.now() - started, bytes: raw.byteLength };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error), label };
  } finally {
    clearTimeout(timer);
  }
}

/** Is Tally still answering AT ALL? The gate between every probe. */
async function healthy() {
  const result = await post(buildConnectionProbeRequest(), 'health');
  return result.ok && result.text.length > 0;
}

const companies = await post(buildCompanyListRequest(), 'companies');
if (!companies.ok) {
  console.error('TallyPrime is not answering even a company list. Nothing was probed.');
  process.exit(1);
}

const loaded = normalizeCompanies(companies.text).data;
if (loaded.length === 0) {
  console.error('No company is open. Nothing was probed.');
  process.exit(1);
}

// The smallest company by book span, as a rough proxy for "least important".
// Named explicitly in the output either way, because probing one company and
// reporting it as another would be worse than not probing at all.
const target = process.env.TALLY_PROBE_COMPANY ?? loaded[0].name;
console.log(`\nProbing against: ${target}`);
console.log(`Companies open : ${loaded.map((c) => c.name).join(', ')}`);
console.log(`Timeout        : ${TIMEOUT_MS}ms per request\n`);

/**
 * The three master lists the workbook cannot reach, plus one CONTROL.
 *
 * The control matters: `Ledger` is a type this server uses in production, so it
 * MUST come back healthy. If the control fails, the probe itself is broken and
 * nothing can be concluded about the other three.
 */
const TYPES = [
  { type: 'Ledger', fields: ['Name'], control: true },
  { type: 'CostCentre', fields: ['Name', 'Parent', 'Category'] },
  { type: 'CostCategory', fields: ['Name'] },
  { type: 'Godown', fields: ['Name', 'Parent'] },
];

const findings = [];

for (const spec of TYPES) {
  if (!(await healthy())) {
    console.log(`STOPPING: TallyPrime stopped answering before "${spec.type}" was tried.`);
    console.log('Check the TallyPrime window for a dialog and dismiss it.');
    findings.push({ type: spec.type, verdict: 'NOT TRIED — Tally was already wedged' });
    break;
  }

  const request = buildCollectionRequest(
    `Probe${spec.type}`,
    spec.type,
    spec.fields,
    { company: target === undefined ? UNSCOPED : target, format: 'xml' }
  );

  const result = await post(request, spec.type);

  if (!result.ok) {
    console.log(`${spec.type.padEnd(14)} NO ANSWER in ${result.ms}ms — ${result.error}`);
    const recovered = await healthy();
    findings.push({
      type: spec.type,
      verdict: recovered
        ? 'TIMED OUT but Tally recovered on its own'
        : 'WEDGED — Tally is not answering; dismiss the dialog in TallyPrime',
    });
    if (!recovered) {
      console.log('\n*** TallyPrime is WEDGED. Dismiss the dialog on screen. Stopping here. ***');
      break;
    }
    continue;
  }

  const error = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/.exec(result.text);
  const records = [...result.text.matchAll(new RegExp(`<${spec.type}\\b`, 'gi'))].length;

  console.log(
    `${spec.type.padEnd(14)} ${String(result.ms).padStart(5)}ms  ` +
      `${String(result.bytes).padStart(8)} bytes  ` +
      (error !== null ? `REFUSED: ${error[1].trim().slice(0, 60)}` : `${records} record(s)`)
  );

  findings.push({
    type: spec.type,
    verdict:
      error !== null
        ? `REFUSED cleanly: ${error[1].trim()}`
        : records > 0
          ? `REACHABLE — ${records} record(s), ${result.bytes} bytes`
          : 'ACCEPTED but returned no records',
    control: spec.control === true,
  });
}

console.log('\n--- findings ---');
for (const finding of findings) {
  console.log(`  ${finding.type.padEnd(14)} ${finding.verdict}${finding.control ? '   (CONTROL)' : ''}`);
}

const control = findings.find((f) => f.control);
if (control && !control.verdict.startsWith('REACHABLE')) {
  console.log(
    '\nThe CONTROL failed, so nothing above can be trusted — the probe itself is at fault,\n' +
      'not the types being tested.'
  );
}

console.log('\nRe-enable the scheduled export when you are done:');
console.log('  schtasks /Change /TN "TallyPrime for Claude - Export" /ENABLE\n');
