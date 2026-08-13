import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { mergeServerIntoConfig, isPlainObject } from './lib/configMerge.mjs';
import { probeTally } from './lib/probe.mjs';
import { explainProbe } from './lib/explain.mjs';
import { packageRootFor, isTemporaryLocation } from './lib/paths.mjs';
import {
  codexConfigPath,
  isClaudeInstalled,
  isCodexInstalled,
  mergeServerIntoToml,
} from './lib/codexConfig.mjs';

/**
 * One-time (and re-runnable) setup: point Claude Desktop and/or Codex at this
 * copy of the server.
 *
 * Run through Setup.bat, never directly — the .bat is what supplies the bundled
 * Node runtime and keeps the window open at the end.
 *
 * Two decisions worth knowing before editing:
 *
 * 1. It writes the config with THIS folder's current location every time it
 *    runs. That makes "I moved the folder and it stopped working" — otherwise a
 *    silent failure — repairable by running setup again, which is the only fix a
 *    non-technical user can be expected to perform.
 *
 * 2. It registers `process.execPath`, the Node runtime that is running this
 *    script, as the command. Inside the shipped folder that is the bundled
 *    runtime, so the install does not depend on the user having Node installed
 *    or on PATH being sane.
 */

const PACKAGE_ROOT = packageRootFor(import.meta.url);
const SERVER_ENTRY = join(PACKAGE_ROOT, 'dist', 'index.js');

const DEFAULT_ENV = {
  TALLY_HOST: '127.0.0.1',
  TALLY_PORT: '9000',
  LOG_LEVEL: 'info',
};

async function main() {
  heading('TallyPrime for Claude — Setup');

  const version = readVersion();
  line(`Version ${version}`);
  line(`Folder  ${PACKAGE_ROOT}`);
  blank();

  // Checked before anything is read or written: an install from a temp folder
  // must not half-happen.
  const location = isTemporaryLocation(PACKAGE_ROOT);
  if (location.temporary) {
    return fail(
      location.reason === 'zip'
        ? [
            'This is still running from inside the zip file.',
            '',
            'Windows unpacked it to a temporary place to run it. That folder gets',
            'deleted, which would break the connection a few days from now with',
            'nothing to show why. So nothing has been changed.',
            '',
            'What to do:',
            '',
            '   1. Close this window.',
            '   2. Find the .zip file you downloaded.',
            '   3. Right-click it and choose  Extract All...',
            '   4. Pick a folder that can stay — Documents is fine.',
            '   5. Open the extracted folder and double-click Setup there.',
            '',
            `For reference, it is currently running from:`,
            `   ${PACKAGE_ROOT}`,
          ]
        : [
            'This folder is in a temporary location.',
            '',
            `   ${PACKAGE_ROOT}`,
            '',
            'Windows deletes these folders, which would break the connection later',
            'with nothing to show why. So nothing has been changed.',
            '',
            'What to do:  move this folder somewhere it can stay — Documents is',
            'fine — then double-click Setup there.',
          ]
    );
  }

  if (!existsSync(SERVER_ENTRY)) {
    return fail([
      'This copy looks incomplete.',
      '',
      `Expected to find:  ${SERVER_ENTRY}`,
      '',
      'What to do:  delete this folder, unzip the download again, and run',
      'Setup once more. If you unzipped by opening the .zip and dragging one',
      'file out, that is the usual cause — right-click the .zip and choose',
      '"Extract All" instead.',
    ]);
  }

  const targets = await chooseTargets();

  const results = [];
  for (const target of targets) {
    const result = target === 'claude' ? configureClaude() : configureCodex();
    results.push(result);
  }

  // A run that could configure NOTHING is a failed install, and must not go on
  // to print "last step" as though it worked.
  if (results.every((result) => !result.ok)) {
    return fail(results.flatMap((result) => [`${result.app}:`, ...result.lines, '']));
  }

  blank();
  for (const result of results) {
    result.lines.forEach(line);
  }
  blank();

  // Step 3 — tell them about Tally now, while they are still at the keyboard.
  heading('Checking TallyPrime');
  const probe = await probeTally({ host: DEFAULT_ENV.TALLY_HOST, port: Number(DEFAULT_ENV.TALLY_PORT) });
  const explained = explainProbe(probe, {
    host: DEFAULT_ENV.TALLY_HOST,
    port: Number(DEFAULT_ENV.TALLY_PORT),
  });

  line(explained.headline);
  blank();
  explained.lines.forEach(line);
  blank();

  heading('Last step');
  const configured = results.filter((result) => result.ok).map((result) => result.app);

  if (configured.includes('Claude Desktop')) {
    line('Close Claude Desktop completely, then open it again.');
    blank();
    line('Closing the window is not enough — it keeps running in the notification');
    line('area, by the clock. Right-click its icon there and choose Quit, then');
    line('start Claude Desktop again.');
    blank();
  }

  if (configured.includes('Codex')) {
    line('Close Codex completely, then open it again — it only reads its settings');
    line('at startup, so it will not see this until you do.');
    blank();
  }

  line('Then ask it something like:  "What is my cash balance in Tally?"');
  blank();

  if (!explained.ok) {
    line('TallyPrime still needs sorting out first — see above. You can run');
    line('Check-Tally any time to test it again; you do not need to run Setup again.');
    blank();
  }

  await pause();
}

/**
 * Which app is this being set up for?
 *
 * Asked rather than inferred. A machine can have both installed while the user
 * only ever opens one, and writing a config for an app nobody uses is at best
 * clutter — at worst it is a second place to go wrong later.
 *
 * Detection LABELS the options; it never removes them. Someone setting up
 * before they have launched the app for the first time must still be able to
 * choose it, and a wrong guess here would be unfixable by a non-technical user.
 *
 * `--target=` / TALLY_SETUP_TARGET skip the prompt, which is what lets this be
 * exercised by a test and by an unattended install.
 */
async function chooseTargets() {
  const forced = (targetFromArgs() ?? process.env.TALLY_SETUP_TARGET ?? '').trim().toLowerCase();
  if (forced === 'claude' || forced === 'codex' || forced === 'both') return expandChoice(forced);

  const claude = isClaudeInstalled();
  const codex = isCodexInstalled();
  const found = '<- found on this computer';
  const label = (text) => text.padEnd(16);

  heading('Which app will you ask your questions in?');
  line(`1.  ${label('Claude Desktop')}${claude ? found : ''}`);
  line(`2.  ${label('Codex')}${codex ? found : ''}`);
  line(`3.  ${label('Both')}`);
  blank();

  // Enter alone must do the right thing: for this audience, a prompt with no
  // default is a place to get stuck.
  const fallback = claude && codex ? '3' : codex && !claude ? '2' : '1';

  // No keyboard attached (an unattended or scripted run). Choosing silently
  // would leave no record of WHICH app was set up, so it says so.
  if (!process.stdin.isTTY) {
    line(`No keyboard input available, so Setup used option ${fallback}.`);
    blank();
    return expandChoice(fallback);
  }

  for (;;) {
    const answer = (
      await ask(`  Type 1, 2 or 3 and press Enter  (just Enter = ${fallback}):  `)
    ).trim();
    if (answer === '') return expandChoice(fallback);
    if (answer === '1' || answer === '2' || answer === '3') return expandChoice(answer);
    line('Please type 1, 2 or 3.');
  }
}

function expandChoice(choice) {
  if (choice === '1' || choice === 'claude') return ['claude'];
  if (choice === '2' || choice === 'codex') return ['codex'];
  return ['claude', 'codex'];
}

function targetFromArgs() {
  const arg = process.argv.slice(2).find((value) => value.startsWith('--target='));
  return arg ? arg.slice('--target='.length) : null;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(answer);
    });
  });
}

/**
 * Write the server into Claude Desktop's JSON config.
 *
 * Returns rather than throws, because with two apps in play one failing must
 * not abandon the other: a user with both installed should still end up with a
 * working Claude connection when Codex's config turns out to be unreadable.
 */
function configureClaude() {
  const app = 'Claude Desktop';
  const configPath = claudeConfigPath();
  if (!configPath) {
    return {
      app,
      ok: false,
      lines: [
        'Could not work out where Claude Desktop keeps its settings.',
        'Check that Claude Desktop is installed, then run Setup again.',
      ],
    };
  }

  let existing = null;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    if (raw.trim().length > 0) {
      try {
        existing = JSON.parse(raw);
      } catch {
        return {
          app,
          ok: false,
          lines: [
            "Claude Desktop's settings file could not be read, so nothing was changed.",
            `File:  ${configPath}`,
            'Send that file to whoever set this up for you.',
          ],
        };
      }
      if (!isPlainObject(existing)) {
        return {
          app,
          ok: false,
          lines: [
            "Claude Desktop's settings file is not in the expected form, so nothing was changed.",
            `File:  ${configPath}`,
            'Send that file to whoever set this up for you.',
          ],
        };
      }
    }
  }

  const { config, replacedExisting, preservedServers } = mergeServerIntoConfig(existing, {
    nodePath: process.execPath,
    serverPath: SERVER_ENTRY,
    env: DEFAULT_ENV,
  });

  const backupPath = backup(configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return { app, ok: true, lines: describe(app, replacedExisting, preservedServers, backupPath) };
}

/**
 * Write the server into Codex's `~/.codex/config.toml`.
 *
 * See lib/codexConfig.mjs for why this edits the file rather than calling
 * `codex mcp add`: the executable hides behind a per-version hash and is
 * routinely absent from PATH, so shelling out fails on exactly the machines
 * this has to work on.
 */
function configureCodex() {
  const app = 'Codex';
  const configPath = codexConfigPath();
  if (!configPath) {
    return {
      app,
      ok: false,
      lines: [
        'Could not work out where Codex keeps its settings.',
        'Check that Codex is installed, then run Setup again.',
      ],
    };
  }

  let existing = '';
  if (existsSync(configPath)) {
    try {
      existing = readFileSync(configPath, 'utf8');
    } catch {
      return {
        app,
        ok: false,
        lines: [
          "Codex's settings file could not be read, so nothing was changed.",
          `File:  ${configPath}`,
        ],
      };
    }
  }

  const { text, replacedExisting, preservedServers } = mergeServerIntoToml(existing, {
    nodePath: process.execPath,
    serverPath: SERVER_ENTRY,
    env: DEFAULT_ENV,
  });

  const backupPath = backup(configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, text, 'utf8');

  return { app, ok: true, lines: describe(app, replacedExisting, preservedServers, backupPath) };
}

function describe(app, replacedExisting, preservedServers, backupPath) {
  const lines = [replacedExisting ? `Updated the ${app} connection.` : `Connected to ${app}.`];
  if (preservedServers.length > 0) {
    lines.push(`  Left your other ${app} connections untouched: ${preservedServers.join(', ')}`);
  }
  if (backupPath) lines.push(`  A backup of the previous ${app} settings was saved alongside them.`);
  return lines;
}

/** Copy before writing. The only thing between a bug here and someone's other connectors. */
function backup(configPath) {
  if (!existsSync(configPath)) return null;
  const backupPath = `${configPath}.backup-${timestamp()}`;
  copyFileSync(configPath, backupPath);
  return backupPath;
}

/**
 * %APPDATA%\Claude\claude_desktop_config.json on Windows.
 *
 * APPDATA is read rather than reconstructed from the user name, because it moves
 * on domain-joined and roaming-profile machines — which describes a lot of
 * accounting offices.
 */
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

function timestamp() {
  // Local time, filename-safe: 2026-08-11-153012
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join('-');
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

async function fail(lines) {
  heading('Setup could not finish');
  lines.forEach(line);
  blank();
  await pause();
  process.exitCode = 1;
}

/**
 * Hold the window open. Setup.bat also pauses, but a user who runs this from an
 * already-open terminal gets the same courtesy, and it costs nothing.
 */
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
  // Never show a stack trace to this audience.
  heading('Setup could not finish');
  line('Something unexpected went wrong.');
  blank();
  line(`Technical detail:  ${error?.message ?? String(error)}`);
  blank();
  line('Send that line to whoever set this up for you.');
  blank();
  process.exitCode = 1;
});
