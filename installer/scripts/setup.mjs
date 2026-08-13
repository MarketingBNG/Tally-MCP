import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { mergeServerIntoConfig, isPlainObject } from './lib/configMerge.mjs';
import { probeTally } from './lib/probe.mjs';
import { explainProbe } from './lib/explain.mjs';
import { packageRootFor, isTemporaryLocation } from './lib/paths.mjs';

/**
 * One-time (and re-runnable) setup: point Claude Desktop at this copy of the
 * server.
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

  const configPath = claudeConfigPath();
  if (!configPath) {
    return fail([
      'Could not work out where Claude Desktop keeps its settings.',
      '',
      'What to do:  check that Claude Desktop is installed on this computer,',
      'then run Setup again.',
    ]);
  }

  // Step 1 — read whatever is there, and refuse rather than clobber.
  let existing = null;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    if (raw.trim().length > 0) {
      try {
        existing = JSON.parse(raw);
      } catch {
        return fail([
          'Claude Desktop\'s settings file could not be read.',
          '',
          `File:  ${configPath}`,
          '',
          'It contains something that is not valid settings, so Setup has stopped',
          'rather than overwrite it and risk losing other connections you have',
          'set up.',
          '',
          'What to do:  send that file to whoever set this up for you.',
        ]);
      }

      if (!isPlainObject(existing)) {
        return fail([
          'Claude Desktop\'s settings file is not in the expected form.',
          '',
          `File:  ${configPath}`,
          '',
          'Setup has stopped rather than overwrite it.',
          '',
          'What to do:  send that file to whoever set this up for you.',
        ]);
      }
    }
  }

  const { config, replacedExisting, preservedServers } = mergeServerIntoConfig(existing, {
    nodePath: process.execPath,
    serverPath: SERVER_ENTRY,
    env: DEFAULT_ENV,
  });

  // Step 2 — back up before writing. Cheap, and the only thing standing
  // between a bug here and someone else's connectors.
  let backupPath = null;
  if (existsSync(configPath)) {
    backupPath = `${configPath}.backup-${timestamp()}`;
    copyFileSync(configPath, backupPath);
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  line(replacedExisting ? 'Updated the Claude Desktop connection.' : 'Connected to Claude Desktop.');
  if (preservedServers.length > 0) {
    line(`Left your other connections untouched: ${preservedServers.join(', ')}`);
  }
  if (backupPath) {
    line('A backup of the previous settings was saved alongside them.');
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
  line('Close Claude Desktop completely, then open it again.');
  blank();
  line('Closing the window is not enough — it keeps running in the notification');
  line('area, by the clock. Right-click its icon there and choose Quit, then');
  line('start Claude Desktop again.');
  blank();
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
