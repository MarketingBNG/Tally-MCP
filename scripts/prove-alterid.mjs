#!/usr/bin/env node
/**
 * Guided check: does TallyPrime notice every kind of edit?
 *
 *   node scripts/prove-alterid.mjs
 *
 * ## What this decides
 *
 * The spreadsheet export asks TallyPrime one cheap question on a schedule — "has
 * anything changed?" — and only does the real work when the answer is yes. That
 * question is answered by comparing a fingerprint built from every voucher's
 * ALTERID and MASTERID (see src/export/fingerprint.ts).
 *
 * The whole design rests on that fingerprint moving on EVERY edit. Altering and
 * adding are near-certain; DELETING is the one nobody has confirmed, and it is
 * the dangerous one, because a deletion that goes unnoticed means the exporter
 * skips a run while the books have changed. The spreadsheet then looks current
 * and is wrong, which is the one failure an accountant cannot see.
 *
 * Until this passes, an install ships at 60-minute intervals, which does not
 * depend on the check being perfect. Passing it unlocks the one-minute cadence
 * the design intends.
 *
 * ## Why it is a guided script rather than instructions
 *
 * Because the instructions were the barrier. Reading a fingerprint, editing a
 * voucher, reading it again and comparing hex strings by eye is a task nobody
 * should have to hold in their head. This asks for one edit at a time and says
 * "moved" or "DID NOT MOVE" after each.
 *
 * ## It changes nothing
 *
 * Every request it sends is an export request — the same ones the server already
 * makes. The edits are made by a human in TallyPrime, which is the entire point:
 * nothing here can write to your books.
 *
 * USE A SCRATCH COMPANY. You are being asked to delete a voucher.
 *
 * ## It needs a licensed TallyPrime
 *
 * The Educational version does not allow the edits this asks for, so it cannot
 * answer the question. That is why the 60-minute interval is not a temporary
 * state waiting on someone's afternoon: it is the shipped default until a
 * licensed install is available to run this, and it is the correct default
 * because it does not depend on the answer.
 */

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((done) => rl.question(question, done));

const line = (text = '') => console.log(text ? `  ${text}` : '');
function heading(text) {
  console.log('');
  console.log(`  ${text}`);
  console.log(`  ${'-'.repeat(text.length)}`);
  console.log('');
}

/**
 * Load from dist/, not src/, so this exercises the code that actually ships.
 * A check that passed against source and failed in the built server would be
 * worse than no check at all.
 */
async function load(relative) {
  const path = join(ROOT, 'dist', relative);
  if (!existsSync(path)) {
    line('The server has not been built yet, so there is nothing to test.');
    line('Run:  npm run build');
    process.exit(1);
  }
  return import(pathToFileURL(path).href);
}

const { loadConfig } = await load('config/config.js');
const { createLogger } = await load('utils/logger.js');
const { TallyClient } = await load('tally/TallyClient.js');
const { readFingerprint } = await load('export/fingerprint.js');

const config = loadConfig({ LOG_LEVEL: 'error' });
const logger = createLogger('error');
const deps = { client: new TallyClient(config, logger), config, logger };

heading('Does TallyPrime notice every edit?');
line('This decides whether the spreadsheet can safely check for changes every');
line('minute instead of every hour.');
line('');
line('You will be asked to make three edits in TallyPrime, one at a time:');
line('change a voucher, add one, and delete one. After each, press Enter here');
line('and this will say whether TallyPrime reported the change.');
line('');
line('USE A PRACTICE COMPANY. You are going to delete a voucher.');
line('');
line('Nothing here writes to Tally. You make the edits; this only looks.');
line('');

const company = (await ask('  Which company are you testing in? (Enter for whichever is open):  ')).trim();
const target = company === '' ? undefined : company;

let previous;
try {
  previous = await readFingerprint(deps, target);
} catch (error) {
  line('');
  line(`Could not read from TallyPrime: ${error?.message ?? String(error)}`);
  line('');
  line('Is TallyPrime open, with the company loaded?');
  rl.close();
  process.exit(1);
}

line('');
line(`Starting point:  ${previous.voucherPairs} vouchers, ${previous.ledgerPairs} ledgers.`);

/** One step: ask for an edit, then report whether the fingerprint moved. */
async function step(number, instruction) {
  heading(`Step ${number} of 3`);
  line(instruction);
  line('');
  await ask('  Press Enter once you have saved it...  ');

  const now = await readFingerprint(deps, target);
  const moved = now.digest !== previous.digest;
  previous = now;

  line('');
  if (moved) {
    line(`PASS — TallyPrime reported the change. (${now.voucherPairs} vouchers now)`);
  } else {
    line('DID NOT MOVE — TallyPrime did not report this change.');
  }
  return moved;
}

const results = {
  altered: await step(1, 'CHANGE any voucher — edit an amount or the narration — and save it.'),
  added: await step(2, 'ADD a new voucher. Anything will do.'),
  deleted: await step(3, 'DELETE a voucher. This is the important one.'),
};

heading('Verdict');

if (results.altered && results.added && results.deleted) {
  line('All three were noticed. The every-minute check is safe to switch on.');
  line('');
  line('To switch it on:');
  line('  1. Open the .env file in your TallyPrime for Claude folder.');
  line('  2. Change the line   TALLY_EXPORT_INTERVAL_MINUTES=60');
  line('                to     TALLY_EXPORT_INTERVAL_MINUTES=1');
  line('  3. Run Setup again so the schedule is updated to match.');
} else {
  const missed = Object.entries(results)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
    .join(', ');

  line(`NOT SAFE. TallyPrime did not report: ${missed}.`);
  line('');
  line('Leave the interval at 60. At that setting the export does not depend on');
  line('this check being perfect, so the spreadsheet stays trustworthy — it is');
  line('just up to an hour behind rather than up to a minute.');
  line('');
  line('An every-minute check would skip exports while your books were changing,');
  line('and the spreadsheet would look current while being out of date.');
}

line('');
rl.close();
