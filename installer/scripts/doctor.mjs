import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { probeTally } from './lib/probe.mjs';
import { explainProbe } from './lib/explain.mjs';
import { isPlainObject, SERVER_KEY } from './lib/configMerge.mjs';
import { packageRootFor, isTemporaryLocation } from './lib/paths.mjs';
import { buildFreshness } from './lib/buildFreshness.mjs';

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

async function main() {
  heading('TallyPrime for Claude — Check');

  // 1. Version and location. First question in every support conversation.
  line(`Version   ${readVersion()}`);
  line(`Folder    ${PACKAGE_ROOT}`);
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
