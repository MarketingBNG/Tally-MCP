import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { probeTally } from './lib/probe.mjs';
import { explainProbe } from './lib/explain.mjs';
import { isPlainObject, SERVER_KEY } from './lib/configMerge.mjs';
import { installRootFor, packageRootFor, isTemporaryLocation } from './lib/paths.mjs';
import { readUpdateState } from './lib/update.mjs';
import { buildFreshness } from './lib/buildFreshness.mjs';
import { readEnvSetting, taskExists } from './lib/exportSetup.mjs';

/**
 * The doctor window — run by double-clicking Check-Tally.bat.
 *
 * Deliberately a window and not a command, per docs/next-steps.md: the audience
 * will not open a terminal to type a subcommand, so the diagnosis has to be one
 * double-click away. It answers the three questions support actually needs —
 * what version, is Claude wired up, is Tally reachable — in that order, because
 * that is the order in which they fail.
 *
 * Read-only, like everything else here. It reads its own config and asks Tally
 * for the company list. It changes nothing.
 */

const PACKAGE_ROOT = packageRootFor(import.meta.url);
// Settings and the update marker sit above the versioned payload. See paths.mjs.
const INSTALL_ROOT = installRootFor(import.meta.url);

async function main() {
  heading('TallyPrime for Claude — Check');

  // 1. Version and location. First question in every support conversation.
  line(`Version   ${readVersion()}`);
  line(`Folder    ${INSTALL_ROOT}`);
  reportPendingUpdate();
  blank();

  // Every problem found is recorded here, because the verdict at the bottom has
  // to reflect ALL of them. Reporting "pointed at the wrong copy" and then "All
  // good" in the same window teaches the user to distrust the whole check.
  const problems = [];

  // Worth saying first: everything below will look fine while the folder is
  // quietly living somewhere Windows is going to delete.
  const location = isTemporaryLocation(PACKAGE_ROOT);
  if (location.temporary) {
    problems.push('this folder is in a temporary place');
    line('WARNING: this folder is in a temporary place that Windows deletes.');
    blank();
    line(
      location.reason === 'zip'
        ? 'It looks like it is running from inside the zip file.'
        : 'It is inside a temporary folder.'
    );
    blank();
    line('What to do:  right-click the downloaded .zip, choose  Extract All...,');
    line('pick a folder that can stay (Documents is fine), then run Setup there.');
    blank();
  }

  // 2. Is Claude Desktop pointed at THIS folder? A stale path after the folder
  // was moved or a second copy was unzipped is otherwise invisible.
  const wiring = checkClaudeWiring();
  if (!wiring.ok) problems.push(wiring.problem);

  // Developer-only, and silent in a shipped folder: a dist/ older than src/
  // means Claude is running last build's code, which has already cost a day.
  if (!checkBuildFreshness()) problems.push('the built server is out of date');

  // 3. Is Tally reachable, with books open?
  heading('TallyPrime');
  const host = '127.0.0.1';
  const port = 9000;
  const probe = await probeTally({ host, port });
  const explained = explainProbe(probe, { host, port });
  line(explained.headline);
  blank();
  explained.lines.forEach(line);
  blank();

  if (!explained.ok) problems.push('TallyPrime is not ready');

  // 4. The spreadsheet. Its age is the thing nobody would otherwise notice:
  // a workbook that stopped updating four days ago looks exactly like one that
  // updated a minute ago, and Claude reading the cloud copy cannot tell either.
  const exportCheck = checkExport();
  if (exportCheck.problem) problems.push(exportCheck.problem);

  heading(problems.length === 0 ? 'All good' : 'Needs attention');
  if (problems.length === 0) {
    line('Nothing to fix. If Claude still says it cannot see Tally, close Claude');
    line('Desktop completely — including its icon by the clock — and open it again.');
  } else if (problems.length === 1) {
    line(`One thing needs fixing: ${problems[0]}.`);
    blank();
    line('The section above says what to do. Then run this check again.');
  } else {
    line(`${problems.length} things need fixing:`);
    blank();
    problems.forEach((problem) => line(`   - ${problem}`));
    blank();
    line('Each section above says what to do. Then run this check again.');
  }
  blank();

  await pause();
}

/**
 * The scheduled spreadsheet: is it set up, did the last run work, and — the
 * one nobody checks — HOW OLD is the workbook?
 *
 * A stale workbook is the failure this whole design is most exposed to. It
 * looks identical to a fresh one, Claude reading it through Google Drive cannot
 * tell, and the answer that comes back is confidently wrong about the date
 * rather than about the arithmetic. So the age is said out loud, in days, and a
 * workbook older than two days is reported as a problem rather than a note.
 */
function checkExport() {
  heading('The daily spreadsheet');

  const folder = readEnvSetting(INSTALL_ROOT, 'TALLY_EXPORT_FOLDER');
  if (!folder) {
    line('Not set up. Claude will answer from TallyPrime directly, if the');
    line('connector is switched on.');
    blank();
    line('What to do (optional):  run Setup and answer Yes to the spreadsheet');
    line('question. It is worth having if you want answers without Tally open.');
    blank();
    return { problem: null };
  }

  line(`Folder    ${folder}`);
  line(`Scheduled ${taskExists() ? 'yes, every minute while you are logged on' : 'NO — nothing runs on its own'}`);
  blank();

  if (!existsSync(folder)) {
    line('That folder does not exist any more.');
    blank();
    line('What to do:  check whether it was moved or renamed — a Google Drive');
    line('folder somebody reorganised is the usual cause — then run Setup again.');
    blank();
    return { problem: 'the export folder is missing' };
  }

  let worst = null;
  let anyCompany = false;

  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    anyCompany = true;

    const companyFolder = join(folder, entry.name);
    const status = readdirSync(companyFolder).find((name) => name.startsWith('LAST RUN '));
    const workbook = readdirSync(companyFolder).find((name) => name.endsWith('.xlsx'));

    line(entry.name);

    if (!workbook) {
      line('   No spreadsheet has been written yet.');
      worst = 'a company has no spreadsheet yet';
      continue;
    }

    const age = Date.now() - statSync(join(companyFolder, workbook)).mtimeMs;
    const days = age / 86_400_000;
    const howOld =
      days < 1
        ? `${Math.round(age / 3_600_000)} hour(s) old`
        : `${Math.floor(days)} day(s) old`;

    line(`   Spreadsheet  ${howOld}`);
    line(`   Last run     ${status ? status.replace(/\.txt$/, '') : 'unknown'}`);

    if (status && status.startsWith('LAST RUN FAILED')) {
      worst = 'the last export failed';
    } else if (days >= 2 && worst === null) {
      worst = 'the spreadsheet has not been updated for days';
    }
  }

  if (!anyCompany) {
    blank();
    line('Nothing has been exported yet. If it was only just set up, that is');
    line('normal — the next run will write it.');
    blank();
    return { problem: null };
  }

  blank();
  line('An up-to-date file here means it was written to THIS COMPUTER. Whether');
  line("Google Drive has uploaded it is Drive's own business — check its icon in");
  line('the notification area if the cloud copy matters.');
  blank();

  return { problem: worst };
}

/**
 * Returns {ok, problem} rather than printing and returning nothing, so the
 * verdict at the bottom of the window can account for what it found.
 */
function checkClaudeWiring() {
  heading('Claude Desktop');

  const configPath = claudeConfigPath();
  if (!configPath || !existsSync(configPath)) {
    line('Not set up yet.');
    blank();
    line('What to do:  run Setup (in this same folder) once, then come back.');
    blank();
    return { ok: false, problem: 'Claude Desktop is not set up yet' };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    line('Claude Desktop\'s settings file could not be read.');
    blank();
    line('What to do:  send this file to whoever set this up for you:');
    line(`   ${configPath}`);
    blank();
    return { ok: false, problem: 'Claude Desktop\'s settings file could not be read' };
  }

  const entry = isPlainObject(config) && isPlainObject(config.mcpServers)
    ? config.mcpServers[SERVER_KEY]
    : undefined;

  if (!isPlainObject(entry)) {
    line('Claude Desktop does not know about Tally yet.');
    blank();
    line('What to do:  run Setup (in this same folder) once, then come back.');
    blank();
    return { ok: false, problem: 'Claude Desktop does not know about Tally yet' };
  }

  const registeredPath = Array.isArray(entry.args) ? String(entry.args[0] ?? '') : '';
  const expectedPath = join(PACKAGE_ROOT, 'dist', 'index.js');

  if (normalize(registeredPath) !== normalize(expectedPath)) {
    line('Claude Desktop is pointed at a different copy of this program.');
    blank();
    line('It is currently using:');
    line(`   ${registeredPath || '(nothing readable)'}`);
    blank();
    line('This folder is:');
    line(`   ${expectedPath}`);
    blank();
    line('This happens when the folder is moved or renamed, or when a newer');
    line('version is unzipped somewhere else.');
    blank();
    line('What to do:  run Setup in THIS folder to point Claude here instead.');
    blank();
    return { ok: false, problem: 'Claude Desktop is pointed at a different copy' };
  }

  line('Connected, and pointed at this folder.');
  blank();
  return { ok: true };
}

/**
 * Warn a developer running from a source checkout that the built server is
 * behind their edits. Says nothing at all in a shipped folder, which has no
 * `src/` and whose user has no build step to run.
 *
 * Returns true when there is nothing to say — including in a shipped folder,
 * where "not applicable" must not count against the verdict.
 */
function checkBuildFreshness() {
  const result = buildFreshness(PACKAGE_ROOT);
  if (result.status === 'fresh' || result.status === 'not-applicable') return true;

  heading('Build');
  line('The built server is older than the source code.');
  blank();
  if (result.detail) line(result.detail);
  blank();
  line('Claude Desktop runs dist/index.js, so it is using the previous build —');
  line('any tool added or changed since then is invisible to it.');
  blank();
  line('What to do:  run  npm run build  then restart Claude Desktop.');
  blank();
  return false;
}

/** Windows paths differ by case and by trailing separators without differing. */
function normalize(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function claudeConfigPath() {
  const appData = process.env.APPDATA;
  if (appData && appData.trim().length > 0) {
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  const profile = process.env.USERPROFILE;
  if (profile && profile.trim().length > 0) {
    return join(profile, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  }
  return null;
}

/**
 * Say whether a newer version is already downloaded and waiting.
 *
 * Worth a line here because it answers a support question before it is asked:
 * somebody told an update was ready, who then reopens Claude and sees the old
 * version number, needs to know whether the update failed or whether Claude was
 * never actually restarted.
 */
function reportPendingUpdate() {
  const state = readUpdateState(INSTALL_ROOT);

  if (state.staged !== null) {
    line(`Update    ${state.staged} is downloaded and waiting.`);
    line('          Close Claude completely and reopen it to start using it.');
    return;
  }
  if (state.refuse !== null) {
    // A version that was tried and rolled back. Said plainly: this is the one
    // case where staying on an older version is deliberate.
    line(`Update    version ${state.refuse} would not start and was undone.`);
    line('          This copy is still working. The next release will replace it.');
    return;
  }
  if (state.lastFailure !== null) {
    line(`Update    last check could not complete: ${state.lastFailure}`);
  }
}

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
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

function pause() {
  if (!process.stdin.isTTY) return Promise.resolve();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveDone) => {
    rl.question('  Press Enter to close this window. ', () => {
      rl.close();
      resolveDone();
    });
  });
}

main().catch((error) => {
  heading('The check could not finish');
  line(`Technical detail:  ${error?.message ?? String(error)}`);
  blank();
  line('Send that line to whoever set this up for you.');
  blank();
  process.exitCode = 1;
});
