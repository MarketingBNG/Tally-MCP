#!/usr/bin/env node
/**
 * Does `ALTERID` move on every kind of edit?
 *
 *   node scripts/probe-alterid.mjs            -- take a reading
 *   node scripts/probe-alterid.mjs --compare  -- compare against the last reading
 *
 * ## Why this exists, and why it is a script rather than a feature
 *
 * The single biggest speed-up left is to stop re-fetching the whole book when
 * nothing has changed. TallyPrime stamps an `ALTERID` on every record, so IF the
 * maximum `ALTERID` reliably increases on every edit, a tiny request can prove the
 * cache is still valid — turning a ~2.6s / 8.6MB refetch into a ~30ms check, and
 * removing the five-minute staleness window entirely, because the cache would be
 * correct by validation rather than by expiry.
 *
 * That is worth having. It is also worth NOT having if the assumption is false.
 *
 * **If `ALTERID` does not move on some kind of edit — most likely a DELETION — then
 * a validated cache would serve stale figures while reporting them as current.** That
 * is strictly worse than today's honest expiry: an accountant would be shown a
 * receivables balance that has changed, with no indication. So the assumption has to
 * be PROVEN against a real install before any of it is built, and proving it needs
 * someone to edit the books, which no automated test can do.
 *
 * ## How to run it
 *
 * Read-only throughout: this script only ever sends `TALLYREQUEST=Export`. YOU make
 * the edits, in TallyPrime, on a company you do not mind touching.
 *
 *   1. node scripts/probe-alterid.mjs
 *   2. In Tally: ALTER an existing voucher (change its narration). Accept it.
 *      node scripts/probe-alterid.mjs --compare
 *   3. In Tally: ADD a new voucher. Accept it.
 *      node scripts/probe-alterid.mjs --compare
 *   4. In Tally: DELETE a voucher.
 *      node scripts/probe-alterid.mjs --compare
 *
 * All three must report MOVED. If any reports UNCHANGED, `ALTERID` cannot be used to
 * validate a cache, and that result should be written into
 * docs/known-limitations.md so nobody tries again.
 *
 * Use a scratch company if you have one. Deleting a voucher is a real change to real
 * books.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = `${ROOT}/.live-check/alterid.json`;
const compare = process.argv.includes('--compare');

const { buildVoucherAlterIdRequest, buildCompanyListRequest } = await import(
  pathToFileURL(`${ROOT}/dist/tally/requests.js`).href
);
const { normalizeCompanies } = await import(pathToFileURL(`${ROOT}/dist/tally/normalize.js`).href);

async function post(body) {
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:9000', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    body,
  });
  const raw = Buffer.from(await response.arrayBuffer());
  const text =
    raw.length > 1 && raw[1] === 0
      ? new TextDecoder('utf-16le').decode(raw)
      : new TextDecoder('utf-8').decode(raw);
  return { text, ms: Date.now() - started, bytes: raw.byteLength };
}

const companies = await post(buildCompanyListRequest());
const loaded = normalizeCompanies(companies.text).data[0];
if (!loaded) {
  console.error('No company is loaded in TallyPrime. Open one and re-run.');
  process.exit(1);
}

const startYear = Number((loaded.startingFrom ?? '2025-04-01').slice(0, 4));
const period = { fromDate: `${String(startYear)}-04-01`, toDate: `${String(startYear + 1)}-03-31` };

/**
 * Read the maximum ALTERID using the narrow request the feature itself would use —
 * measured at 537KB / ~200ms against 8.6MB / ~2,000ms for the full fetch. So the probe
 * measures the real thing, not an approximation of it.
 */
const voucherXml = await post(buildVoucherAlterIdRequest({ ...period, format: 'xml' }));

const ids = [...voucherXml.text.matchAll(/<ALTERID[^>]*>\s*(\d+)\s*<\/ALTERID>/g)].map((m) =>
  Number(m[1])
);

if (ids.length === 0) {
  console.error(
    'No ALTERID elements came back. The idea cannot be built on this Tally build — record that in docs/known-limitations.md.'
  );
  process.exit(1);
}

/**
 * The (MasterId, AlterId) pairs, not just the maximum.
 *
 * A MAXIMUM cannot see a deletion: remove any record other than the highest and
 * the maximum is unchanged, so a cache validated on it serves figures for a
 * voucher that no longer exists. A SET can — the pair simply disappears. Since
 * this probe already pays for one row per voucher (537KB), the set costs nothing
 * extra to record, and one pass of the manual edits below then answers BOTH
 * questions: does the naive max approach work, and does the set approach.
 *
 * Order-independent: Tally is not promised to return rows in a stable order, and
 * a fingerprint that changes when nothing did would be worse than useless.
 */
const pairs = [...voucherXml.text.matchAll(
  /<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/g
)].map((block) => {
  const alter = /<ALTERID[^>]*>\s*(\d+)\s*<\/ALTERID>/.exec(block[0]);
  const master = /<MASTERID[^>]*>\s*(\d+)\s*<\/MASTERID>/.exec(block[0]);
  return `${master?.[1] ?? '?'}:${alter?.[1] ?? '?'}`;
});
const fingerprint = createHash('sha256')
  .update(pairs.slice().sort().join('|'))
  .digest('hex')
  .slice(0, 16);

const reading = {
  company: loaded.name,
  max: Math.max(...ids),
  count: ids.length,
  distinct: new Set(ids).size,
  pairsRead: pairs.length,
  fingerprint,
  // Stamped by the caller, not by the script: Date.now() inside a probe makes two
  // runs incomparable if the clock is the only thing that changed.
  bytes: voucherXml.bytes,
  ms: voucherXml.ms,
};

console.log(`\nCompany:            ${reading.company}`);
console.log(`Period:             ${period.fromDate} to ${period.toDate}`);
console.log(`Vouchers with an ID:${String(reading.count).padStart(6)}`);
console.log(`Distinct ALTERIDs:  ${String(reading.distinct).padStart(6)}`);
console.log(`MAXIMUM ALTERID:    ${String(reading.max).padStart(6)}`);
console.log(`Set fingerprint:    ${reading.fingerprint}  (${String(reading.pairsRead)} pairs)`);
console.log(
  `Cost of this read:  ${String(reading.ms)}ms, ${(reading.bytes / 1048576).toFixed(1)}MB`
);

if (!compare) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(reading, null, 2), 'utf-8');
  console.log(`\nReading saved. Now make ONE edit in TallyPrime, then run:`);
  console.log(`  node scripts/probe-alterid.mjs --compare\n`);
  // Deliberately NOT process.exit(0): calling it while fetch's handles are still
  // closing trips a libuv assertion on Windows and prints an alarming line after a
  // run that actually succeeded. Letting Node drain exits 0 on its own.
  process.exitCode = 0;
}

if (compare) {
  if (!existsSync(STATE)) {
    console.error('\nNo previous reading. Run without --compare first.');
    process.exit(1);
  }

  const previous = JSON.parse(readFileSync(STATE, 'utf-8'));

  if (previous.company !== reading.company) {
    console.error(
      `\nPrevious reading was for "${previous.company}" — different company, not comparable.`
    );
    process.exit(1);
  }

  const moved = reading.max > previous.max;
  const countChanged = reading.count !== previous.count;
  // The verdict that actually decides whether this can be built.
  const setChanged = reading.fingerprint !== previous.fingerprint;

  console.log(`\nPrevious maximum:   ${String(previous.max).padStart(6)}`);
  console.log(`Voucher count:      ${String(previous.count)} -> ${String(reading.count)}`);
  console.log(
    `\n  BY MAXIMUM: ${moved ? 'MOVED' : '*** UNCHANGED ***'}  maximum ALTERID ${moved ? 'increased' : 'did NOT increase'}`
  );
  console.log(
    `  BY SET:     ${setChanged ? 'MOVED' : '*** UNCHANGED ***'}  fingerprint ` +
      `${previous.fingerprint ?? 'none'} -> ${reading.fingerprint}`
  );

  // The case that decides the design. A maximum cannot see a deletion; the set
  // can. If this fires, validate on the set and the deletion risk disappears.
  if (!moved && setChanged) {
    console.log(
      '\n  The SET saw this edit and the MAXIMUM did not. That is the argument for\n' +
        '  validating on the (MasterId, AlterId) set rather than on a maximum.'
    );
  }

  // Nothing can be built on ALTERID if this fires after a real edit.
  if (!setChanged) {
    console.log(
      '\n  *** The SET did not change either. If an edit really was accepted in\n' +
        '  Tally, ALTERID cannot validate a cache at all — write that into\n' +
        '  docs/known-limitations.md and abandon the idea rather than working\n' +
        '  around it. ***'
    );
  }

  if (!moved && countChanged) {
    console.log(
      '\n  The voucher COUNT changed while the maximum ALTERID did not. That is the\n' +
        '  failure case: a deletion that leaves no trace in ALTERID. Do NOT build cache\n' +
        '  validation on it — record this in docs/known-limitations.md.'
    );
  } else if (!moved) {
    console.log(
      '\n  Nothing appears to have changed. Did the edit get accepted in Tally?\n' +
        '  If it did, ALTERID does not track this kind of change and the idea is dead.'
    );
  } else {
    console.log('\n  Good. Repeat for the remaining edit types — all three must MOVE.');
  }

  writeFileSync(STATE, JSON.stringify(reading, null, 2), 'utf-8');
  if (!moved) process.exitCode = 1;
}
