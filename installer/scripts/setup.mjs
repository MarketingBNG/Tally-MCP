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
import {
  markFolderRetired,
  moveExportData,
  pickFolder,
  readEnvSetting,
  registerTask,
  removeTask,
  writeEnvSettings,
} from './lib/exportSetup.mjs';

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

  // Tally is asked FIRST now, not last. The export questions below need the
  // company list, and asking somebody to type company names they cannot see —
  // spelled exactly as Tally spells them — is how a configured name ends up
  // matching nothing.
  heading('Checking TallyPrime');
  const probe = await probeTally({
    host: DEFAULT_ENV.TALLY_HOST,
    port: Number(DEFAULT_ENV.TALLY_PORT),
  });
  const explained = explainProbe(probe, {
    host: DEFAULT_ENV.TALLY_HOST,
    port: Number(DEFAULT_ENV.TALLY_PORT),
  });
  line(explained.headline);
  blank();
  explained.lines.forEach(line);
  blank();

  // The spreadsheet export is asked about before the connector, because on a
  // Drive-only install it decides whether the connector is set up at all — and
  // asking "which app?" first would be asking a question whose answer might not
  // be needed.
  const exportChoice = await configureExport(probe.companies);

  const targets = exportChoice.wantsConnector ? await chooseTargets() : [];

  if (targets.length === 0) {
    blank();
    line('The Tally connector was NOT switched on, so Claude will answer from the');
    line('spreadsheet only. That is the lighter setup: the connector costs about');
    line('12,000 tokens of every conversation just to describe its tools.');
    blank();
    line('To switch it on later, run Setup again and answer Yes to the connector');
    line('question. Nothing else needs redoing.');
    blank();
    await pause();
    return;
  }

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
 * The scheduled spreadsheet export: where it writes, what it covers, and how
 * often it looks.
 *
 * ## Why this is asked at all rather than defaulted
 *
 * The folder decides whether anyone else ever sees the spreadsheet, and there
 * is no safe default: writing to Documents produces a file nobody can share,
 * and guessing at a Google Drive path produces a folder that syncs somewhere
 * unexpected. The companies matter for a sharper reason — TallyPrime answers an
 * unscoped request from whichever company it considers current, so naming them
 * is what stops a workbook being labelled one company and read from another.
 *
 * ## What it does NOT ask
 *
 * Anything about Google. No account, no sign-in, no permission. The folder is
 * an ordinary local folder; if it happens to sit inside one Google Drive
 * Desktop syncs, Drive's own client uploads it. No credential is ever created
 * here, so none can leak.
 *
 * @param {string[]} companiesOpen Company names TallyPrime reported, for the prompt.
 * @returns {Promise<{wantsConnector: boolean}>}
 */
async function configureExport(companiesOpen) {
  // No keyboard attached — a scripted or unattended run. The export needs a
  // folder that only a person can choose, and half-configuring it (settings
  // written, no folder) would leave a scheduled task failing every minute. So
  // it is skipped, said out loud, and the connector is set up as before.
  if (!process.stdin.isTTY) {
    heading('The daily spreadsheet');
    line('Skipped: the automatic spreadsheet export needs someone at the keyboard');
    line('to choose a folder. Run Setup again from a window to set it up.');
    blank();
    return { wantsConnector: true };
  }

  heading('The daily spreadsheet');

  line('This can write your Tally data to an Excel workbook automatically, so');
  line('Claude can answer questions from the spreadsheet without TallyPrime');
  line('having to be open.');
  blank();
  line('Put the folder inside Google Drive and the whole team can see it.');
  blank();

  if (!(await confirm('Set up the automatic spreadsheet export?', true))) {
    line('Skipped. Nothing was scheduled.');
    blank();
    return { wantsConnector: true };
  }

  const folder = await chooseExportFolder();

  if (folder === null) {
    line('No folder chosen, so the export was not set up. Run Setup again when you');
    line('know where you want it.');
    blank();
    return { wantsConnector: true };
  }

  // Shown back, spelled the way Tally spells them, so a typed name matches.
  blank();
  if (companiesOpen.length > 0) {
    line('TallyPrime currently has these companies open:');
    companiesOpen.forEach((name) => line(`   - ${name}`));
  } else {
    line('TallyPrime has no company open at the moment, so there is no list to');
    line('show. You can leave the next question blank and it will export whatever');
    line('is open when it runs.');
  }
  blank();

  const companies = (
    await ask(
      '  Which companies should it export?\n' +
        '  (separate several with a semicolon, or press Enter for all open ones):  '
    )
  ).trim();

  const settings = {
    TALLY_EXPORT_FOLDER: folder,
    // HOURLY, not the every-minute design. The minute cadence depends on the
    // change check being sound, and that rests on TallyPrime's ALTERID moving on
    // every edit including deletions — not yet proven at a real screen. If it
    // does not hold, the exporter skips runs while the books move and the
    // workbook reports itself current while being stale. Hourly is merely slow.
    TALLY_EXPORT_INTERVAL_MINUTES: '60',
  };
  if (companies !== '') settings.TALLY_EXPORT_COMPANIES = companies;

  const previousFolder = readEnvSetting(PACKAGE_ROOT, 'TALLY_EXPORT_FOLDER');
  const envPath = writeEnvSettings(PACKAGE_ROOT, settings);
  blank();
  line(`Settings saved to  ${envPath}`);
  blank();

  // The folder CHANGED, so there are spreadsheets and archive copies sitting in
  // the old one. Offer to bring them across, because the alternative is a frozen
  // workbook that looks current — the most dangerous thing this design can leave
  // lying around.
  if (previousFolder !== null && normalisePath(previousFolder) !== normalisePath(folder)) {
    await handleFolderChange(previousFolder, folder);
  }

  // The schedule is offered, never assumed: it changes the machine's task
  // list, and a policy on a managed machine may forbid it outright.
  line('It can run once an hour. Each time it asks TallyPrime whether anything');
  line('has changed, and writes a fresh workbook only if the books actually');
  line('moved — plus once a day regardless, so the file never looks older than');
  line('it is.');
  blank();

  if (await confirm('Schedule it to run automatically?', true)) {
    const result = registerTask({
      batPath: join(PACKAGE_ROOT, 'Run-Export.bat'),
      everyMinutes: 60,
    });
    if (result.ok) {
      line('Scheduled. It runs while you are logged on, which is also when');
      line('TallyPrime is open.');
      blank();
      if (result.hidden) {
        line('You will not see anything happen — it runs with no window.');
      } else {
        // Said plainly rather than letting them discover it. A window every
        // minute is the kind of thing somebody switches the feature off over,
        // and they should at least know why it is happening.
        line('ONE THING TO EXPECT: a small black window will appear briefly each');
        line('time it runs. This computer is missing the component that would let');
        line('it run invisibly (Windows Script Host), so the visible version is');
        line('being used instead — an export you can see is better than one that');
        line('silently never happens.');
      }
    } else {
      line('The schedule could NOT be created, so nothing will run on its own.');
      blank();
      line('You can still export whenever you like by double-clicking');
      line('Run-Export in this folder.');
      blank();
      line('This usually means a policy on this computer forbids scheduled tasks.');
      line(`Technical detail:  ${result.detail ?? 'none'}`);
    }
  } else {
    removeTask();
    line('Not scheduled. Double-click Run-Export in this folder whenever you');
    line('want a fresh spreadsheet.');
  }
  blank();

  // The connector question. Asked here because the answer only makes sense
  // once someone knows they already have the spreadsheet.
  heading('The Tally connector');
  line('The connector lets Claude query TallyPrime live — useful for checking a');
  line('figure, or for anything the spreadsheet does not cover.');
  blank();
  line('It costs about 12,000 tokens of EVERY conversation just to describe its');
  line('tools, whether or not you use them. With the spreadsheet set up, most');
  line('people do not need it switched on all the time.');
  blank();

  const wantsConnector = await confirm('Switch the Tally connector on as well?', false);
  return { wantsConnector };
}

/**
 * Where the spreadsheets go — chosen in a Windows folder picker, not typed.
 *
 * The picker is offered first because a typed path is the step this audience
 * gets stuck on, and a mistyped one is not visibly wrong: Setup would save it,
 * and the scheduled task would then fail every minute against a folder that was
 * never there.
 *
 * Typing stays available for three real cases — a dialog that cannot be shown, a
 * UNC path somebody wants to paste, and anyone who simply prefers it. A picker
 * that fails must never become an install that cannot be finished.
 *
 * @returns {Promise<string|null>} A folder that EXISTS, or null if they gave up.
 */
async function chooseExportFolder() {
  // What it is set to now, so re-running Setup to change ONE other answer does
  // not mean re-finding a folder somebody chose weeks ago.
  const current = readEnvSetting(PACKAGE_ROOT, 'TALLY_EXPORT_FOLDER');

  if (current !== null) {
    line('At the moment the spreadsheets go here:');
    line(`   ${current}`);
    if (!existsSync(current)) {
      line('');
      line('   ...except that folder does not exist any more. It was probably moved,');
      line('   renamed, or is on a drive that is not connected right now.');
    }
    blank();

    if (await confirm('Keep using that folder?', true)) {
      blank();
      return current;
    }
    blank();
  }

  for (;;) {
    line('A folder picker will open. Choose (or create) the folder you want.');
    line('If you use Google Drive, pick something under  Shared drives  so the');
    line('whole team can see it, rather than your own My Drive.');
    blank();

    const picked = pickFolder('Where should the TallyPrime spreadsheets go?', current);

    if (picked !== null) {
      line(`Chosen:  ${picked}`);
      blank();
      return picked;
    }

    // Null covers two different things, and they deserve different words: the
    // dialog appeared and was cancelled, or it could not appear at all. From
    // here they look identical, so the message covers both without claiming
    // which happened.
    line('Nothing was chosen — either the picker was cancelled, or this computer');
    line('would not show it.');
    blank();

    const typed = (
      await ask('  Type or paste the folder instead, or press Enter to skip:  ')
    ).trim();

    if (typed === '') return null;

    // Checked, and NOT created. A path with a typo in it would otherwise be
    // created as a brand-new empty folder that syncs nowhere, and the mistake
    // would only surface days later as a spreadsheet nobody can find.
    if (existsSync(typed)) {
      line(`Chosen:  ${typed}`);
      blank();
      return typed;
    }

    line('That folder does not exist, so it was not saved.');
    blank();
    line('Check the spelling — or create the folder in File Explorer first, then');
    line('let the picker find it.');
    blank();

    if (!(await confirm('Try again?', true))) return null;
  }
}

/**
 * The old folder, once the export has moved on from it.
 *
 * Offered as a MOVE — bring the spreadsheets and their archive across, then
 * remove them from the old place — because the thing left behind is a workbook
 * that has stopped updating and still looks current. Two copies of a client's
 * books, one of them quietly frozen, is worse than either one alone.
 *
 * Always confirmed, never assumed, and the prompt says the one thing that makes
 * this irreversible: if the old folder is inside Google Drive, removing files
 * locally removes them from the cloud, and from everyone else's synced copy too.
 */
async function handleFolderChange(previousFolder, folder) {
  heading('The folder you were using before');

  line('The spreadsheets used to go here:');
  line(`   ${previousFolder}`);
  blank();

  if (!existsSync(previousFolder)) {
    line('That folder cannot be reached right now, so nothing was moved out of it.');
    line('If it comes back — a drive that was not connected, say — remember that');
    line('whatever is in it has stopped updating.');
    blank();
    return;
  }

  line('Anything left there stops updating, while still LOOKING like a current');
  line('spreadsheet. Two copies of one client\'s books, one of them quietly');
  line('frozen, is the thing worth avoiding here.');
  blank();
  line('IF THAT FOLDER IS IN GOOGLE DRIVE, moving files out of it removes them');
  line('from Drive as well — for everyone it is shared with, not just this');
  line('computer. Say no if you would rather sort it out by hand.');
  blank();

  if (!(await confirm('Move the old spreadsheets across to the new folder?', true))) {
    line('Nothing moved. A note has been left in the old folder instead, saying');
    line('that what is in it no longer updates.');
    markFolderRetired(previousFolder, folder, new Date());
    blank();
    return;
  }

  const result = moveExportData(previousFolder, folder);
  blank();

  if (result.moved.length > 0) {
    line(`Moved ${String(result.moved.length)} item(s) across, including each company's`);
    line('spreadsheet and its Archive folder.');
  } else {
    line('There was nothing of ours to move — no spreadsheet had been written yet.');
  }

  // Said explicitly. Somebody who chose a shared folder needs to know their
  // other files were deliberately not touched, rather than wondering whether
  // they were about to be.
  if (result.left.length > 0) {
    blank();
    line(`${String(result.left.length)} other item(s) in that folder were NOT touched, because`);
    line('this program did not put them there. They are still where they were:');
    result.left.slice(0, 5).forEach((name) => line(`   ${name}`));
    if (result.left.length > 5) line(`   ...and ${String(result.left.length - 5)} more`);
  }

  if (result.failed.length > 0) {
    blank();
    line(`${String(result.failed.length)} item(s) could not be copied, so they were LEFT ALONE`);
    line('rather than deleted — something may have them open. They are still in');
    line('the old folder:');
    result.failed.slice(0, 5).forEach((name) => line(`   ${name}`));
    blank();
    line('Close anything using them and move them across by hand, or run Setup');
    line('again and choose the same new folder.');
  }

  if (result.oldFolderRemoved) {
    blank();
    line('The old folder was empty afterwards, so it has been removed.');
  } else if (result.failed.length === 0 && result.left.length > 0) {
    blank();
    line('The old folder is still there, holding those other files.');
  }

  blank();
  line('The next run will overwrite the spreadsheets in the new folder with fresh');
  line('figures. The Archive copies that came across are kept as they are.');
  blank();
}

/**
 * Windows paths differ by slash and by case without differing, so "did the
 * folder change?" cannot be a string comparison. Getting this wrong would
 * retire the folder the export is about to write to.
 */
function normalisePath(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** A yes/no question with a default, for an audience that should not get stuck. */
async function confirm(question, fallback) {
  const hint = fallback ? 'Y/n' : 'y/N';
  if (!process.stdin.isTTY) return fallback;

  for (;;) {
    const answer = (await ask(`  ${question}  (${hint}):  `)).trim().toLowerCase();
    if (answer === '') return fallback;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    line('Please answer y or n.');
  }
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
