import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { isPlainObject, removeServerFromConfig } from './lib/configMerge.mjs';
import { codexConfigPath, removeServerFromToml } from './lib/codexConfig.mjs';
import { uicConfigPath } from './lib/uicConfig.mjs';
import { claudeConfigCandidates, installRootFor } from './lib/paths.mjs';
import {
  readEnvSetting,
  removeTask,
  stableLauncherPath,
  taskBelongsTo,
  TASK_NAME,
} from './lib/exportSetup.mjs';

/**
 * Take TallyPrime for Claude off this computer.
 *
 * Run through Uninstall.bat. It undoes what Setup did, and nothing more:
 *
 *   - the scheduled export task
 *   - the `tally` connection in Claude Desktop, Codex and UIC GPT, with a backup
 *     of each settings file taken first and every other connection left alone
 *   - the earlier-years copies the export keeps on this computer
 *
 * ## What it deliberately leaves
 *
 * THE EXPORT FOLDER. It is normally a shared OneDrive or Google Drive folder, and
 * deleting it here deletes it from the cloud and from everyone it is shared with.
 * The spreadsheets in it are the user's, not this program's.
 *
 * THIS FOLDER. The program is running from it, so it cannot delete itself. The
 * last screen says to delete it by hand.
 *
 * ## Only what belongs to THIS install
 *
 * A connection or task pointing at a different folder — a second unzipped copy,
 * a developer checkout — is somebody's working setup. It is reported and left.
 */

const INSTALL_ROOT = installRootFor(import.meta.url);
const ROOT_PREFIX = `${resolve(INSTALL_ROOT).toLowerCase()}${sep}`;

/** Does this path sit inside the install being removed? */
function owns(path) {
  return `${resolve(path).toLowerCase()}${sep}`.startsWith(ROOT_PREFIX);
}

async function main() {
  heading('TallyPrime for Claude — Uninstall');
  line('This removes TallyPrime for Claude from this computer:');
  line('  - the automatic Excel export');
  line('  - the Tally connection in Claude Desktop, Codex and UIC GPT');
  blank();
  line('It does NOT touch your TallyPrime data, your other Claude connections,');
  line('or the spreadsheets in your export folder.');
  blank();

  if (!(await confirm('Remove it now?'))) {
    line('Nothing was changed.');
    return;
  }
  blank();

  // Claude Desktop rewrites its own settings file while it runs, and would put
  // the connection straight back on exit.
  if (isRunning('claude.exe')) {
    line('Claude Desktop is open. Please close it fully — right-click its icon');
    line('near the clock and choose Quit — then press Enter here.');
    await ask('  ');
    blank();
  }

  report('Automatic export', removeOurTask());
  for (const candidate of claudeConfigCandidates()) {
    if (existsSync(candidate.path)) report('Claude Desktop', removeFromJson(candidate.path));
  }
  const codex = codexConfigPath();
  if (codex !== null && existsSync(codex)) report('Codex', removeFromToml(codex));
  const uic = uicConfigPath();
  if (uic !== null && existsSync(uic)) report('UIC GPT', removeFromJson(uic));
  report('Saved earlier years', removeEarlierYears());

  blank();
  const exportFolder = readEnvSetting(INSTALL_ROOT, 'TALLY_EXPORT_FOLDER');
  if (exportFolder !== null) {
    line('Your spreadsheets were left where they are:');
    line(`  ${exportFolder}`);
    line('Delete that folder yourself only if nobody else uses it.');
    blank();
  }
  line('Last step: close this window, then delete this folder:');
  line(`  ${INSTALL_ROOT}`);
  line('If Claude Desktop was open, start it again; Tally will no longer be listed.');
  blank();
}

function removeOurTask() {
  let xml;
  try {
    xml = execFileSync('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/XML'], { stdio: 'pipe' }).toString('utf8');
  } catch {
    return 'was not set up';
  }
  if (!taskBelongsTo(xml, INSTALL_ROOT)) return 'left alone: it belongs to another copy of the program';
  const result = removeTask();
  if (!result.ok) return `could NOT be removed: ${result.detail}`;
  // The starter outside this folder that the task ran. See stableLauncherPath.
  const starter = stableLauncherPath();
  if (starter !== null) {
    rmSync(starter, { force: true });
    rmSync(`${starter}.missing`, { force: true });
  }
  return 'removed';
}

function removeFromJson(path) {
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return `left alone: the settings file could not be read (${path})`;
  }
  if (!isPlainObject(existing)) return `left alone: the settings file is not in the expected form (${path})`;
  const { config, outcome } = removeServerFromConfig(existing, owns);
  if (outcome !== 'removed') return describe(outcome, path);
  backup(path);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return `removed (a backup was saved beside ${path})`;
}

function removeFromToml(path) {
  let existing;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    return `left alone: the settings file could not be read (${path})`;
  }
  const { text, outcome } = removeServerFromToml(existing, owns);
  if (outcome !== 'removed') return describe(outcome, path);
  backup(path);
  writeFileSync(path, text, 'utf8');
  return `removed (a backup was saved beside ${path})`;
}

function describe(outcome, path) {
  return outcome === 'absent'
    ? 'was not connected'
    : `left alone: the connection there belongs to another copy (${path})`;
}

/**
 * The whole earlier-years folder, not just this install's companies: its
 * entries are named by a hash that cannot be traced back to a company here. It
 * is a cache, so another copy on this computer loses one slow export, nothing else.
 */
function removeEarlierYears() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return 'none found';
  const folder = join(base, 'TallyPrime for Claude', 'earlier years');
  if (!existsSync(folder)) return 'none found';
  try {
    rmSync(folder, { recursive: true, force: true });
    rmdirSync(join(base, 'TallyPrime for Claude'));
  } catch {
    // The parent still holds something else; leaving it is correct.
  }
  return existsSync(folder) ? `could NOT be removed (${folder})` : 'removed';
}

function backup(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(path, `${path}.backup-${stamp}`);
}

function isRunning(image) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { stdio: 'pipe' });
    return out.toString('utf8').toLowerCase().includes(image);
  } catch {
    return false;
  }
}

function report(what, outcome) {
  line(`${what}: ${outcome}`);
}

async function confirm(question) {
  const answer = (await ask(`  ${question} (y/n):  `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    rl.question(question, (answer) => {
      rl.close();
      done(answer);
    });
  });
}

function heading(text) {
  console.log('');
  console.log(`  ${text}`);
  console.log(`  ${'-'.repeat(text.length)}`);
  console.log('');
}

function line(text = '') {
  console.log(text ? `  ${text}` : '');
}

function blank() {
  console.log('');
}

main()
  .catch((error) => {
    heading('Uninstall could not finish');
    line(`Technical detail:  ${error?.message ?? String(error)}`);
    line('Send that line to whoever set this up for you.');
    process.exitCode = 1;
  })
  .finally(() => ask('  Press Enter to close this window. '));
