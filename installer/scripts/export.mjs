import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installRootFor, packageRootFor } from './lib/paths.mjs';
import { probeTally } from './lib/probe.mjs';
import { loadEnvFile } from './lib/exportSetup.mjs';
import { toast } from './lib/notify.mjs';
import { notifyOnce } from './lib/notifyOnce.mjs';
import { unblockOnce } from './lib/unblock.mjs';
import { explainProbe } from './lib/explain.mjs';
import { checkForUpdate } from './lib/update.mjs';

/**
 * The scheduled export.
 *
 * Run through Run-Export.bat, never directly — the .bat supplies the bundled
 * Node runtime and holds the window open when somebody double-clicks it.
 *
 * ## What this file is and is not
 *
 * It is the RUNNER: find the server's own build, load configuration, check
 * TallyPrime is reachable, hand over to `runExport`, and turn the outcome into
 * something visible to a person who is not watching a console. The export logic
 * itself lives in src/export/ and is tested there.
 *
 * ## Read-only, and it stays that way
 *
 * Everything it sends TallyPrime comes from the server's own request builders,
 * which emit `TALLYREQUEST=Export` and nothing else. No request XML is written
 * here, for the reason lib/probe.mjs already records: this runs on machines with
 * real books open, and a malformed request is the one thing that can take
 * TallyPrime down with somebody's unsaved work in it.
 *
 * ## Failures have to be VISIBLE
 *
 * Nobody is watching this. So a failed run leaves, in the folder:
 *
 *   - `LAST RUN FAILED - TallyPrime was not open - 2026-08-19 18-05.txt`
 *   - a line in `run-log.txt`
 *   - a Windows toast — but a sparing one, under one of two rules
 *
 * Being sparing is not a nicety. At a five-minute cadence, notifying every
 * failure would fire twelve times an hour for as long as somebody leaves the
 * workbook open in Excel — which trains people to ignore it, and then the
 * failure that matters is ignored too.
 *
 * The two rules, and the difference between them matters:
 *
 *   - A failure DURING a company's export — the workbook locked, a sheet gone —
 *     follows a change-of-state rule: notify the first one, log the repeats,
 *     notify the recovery. These are faults, and a fault that comes back is
 *     news each time.
 *
 *   - A failure BEFORE any company is reached — almost always a closed
 *     TallyPrime — is notified ONCE PER INSTALL AND NEVER AGAIN. A closed Tally
 *     is not a fault; it is every evening and every weekend. See
 *     lib/notifyOnce.mjs, which carries the full reasoning.
 *
 * The console output obeys neither rule: a run somebody started by hand always
 * prints everything, because they are standing there watching it.
 */

const PACKAGE_ROOT = packageRootFor(import.meta.url);
// Settings, logs and the update marker live above the versioned payload, so an
// update replaces the code without resetting what the user chose. See
// installRootFor in lib/paths.mjs.
const INSTALL_ROOT = installRootFor(import.meta.url);
const QUIET = process.argv.includes('--quiet');
const FORCE = process.argv.includes('--force');

async function main() {
  if (!QUIET) heading('TallyPrime for Claude — Export');

  const dist = join(PACKAGE_ROOT, 'dist');
  if (!existsSync(join(dist, 'index.js'))) {
    return fail([
      'This copy looks incomplete.',
      '',
      `Expected to find:  ${join(dist, 'index.js')}`,
      '',
      'What to do:  delete this folder, unzip the download again, and run',
      'Setup once more.',
    ]);
  }

  // BEFORE the config module is imported, because `dotenv` runs at import time
  // and looks in the working directory — which the scheduler sets to
  // System32, not to this folder. See loadEnvFile.
  loadEnvFile(INSTALL_ROOT);

  /*
   * A far longer report timeout than an interactive tool wants.
   *
   * The server's default is four times the base timeout — 120 seconds — and
   * that is the right number for somebody sitting waiting for an answer. The
   * export is not that. It reads EVERY book year the company holds, and a
   * single prior year is a report running to tens of megabytes: measured live,
   * one year took 103 seconds on its own, and a full MUDALS export took 146.
   *
   * At the interactive default those years time out. They are then excluded
   * with a warning rather than lost silently — but a workbook that quietly
   * stops carrying history because of a timeout nobody chose is not what
   * "everything Tally has" means.
   *
   * Only a default: an operator who set the variable meant it, and
   * `loadEnvFile` has already applied any value from the .env by this point.
   */
  process.env.TALLY_REPORT_TIMEOUT_MS ??= '600000';

  /*
   * Once per install, and the reason it is HERE is in unblockOnce: this is the
   * only code path that reaches an existing install as the new version. It
   * takes Windows' download mark off the folder, which is what stops
   * "The publisher could not be verified" appearing every five minutes when the
   * task launches Run-Export-Hidden.vbs.
   *
   * Before anything that can fail, and silent either way — a repair is not news.
   */
  const unblocked = unblockOnce(INSTALL_ROOT);
  if (!QUIET && unblocked.cleared > 0) {
    line(`Cleared Windows' download warning from ${unblocked.cleared} file(s).`);
    blank();
  }

  // The server's own modules, so nothing here re-derives a figure or a request.
  const { loadConfig } = await load(dist, 'config/config.js');
  const { TallyClient } = await load(dist, 'tally/TallyClient.js');
  const { createLogger } = await load(dist, 'utils/logger.js');
  const { runExport, resolveExportCompanies } = await load(dist, 'export/run.js');

  if (FORCE) process.env.TALLY_EXPORT_FORCE = 'true';

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return fail([
      'The settings could not be read, so nothing was exported.',
      '',
      `Technical detail:  ${error?.message ?? String(error)}`,
    ]);
  }

  if (!config.tallyExportFolder) {
    return fail([
      'No export folder has been chosen yet, so there is nowhere to write.',
      '',
      'What to do:  run Setup and answer the two export questions — where the',
      'spreadsheets should go, and which companies to export.',
    ]);
  }

  // Checked BEFORE the fingerprint request, so "Tally was not open" is diagnosed
  // in plain words rather than surfacing as a connection error from deep inside
  // a fetch. This is the single most common failure and it deserves the good
  // message.
  const probe = await probeTally({ host: config.tallyHost, port: config.tallyPort });
  if (probe.status !== 'ok') {
    const explained = explainProbe(probe, { host: config.tallyHost, port: config.tallyPort });
    notifyOnceAbout(
      config.tallyExportFolder,
      probe.status === 'no-listener' ? 'TallyPrime was not open' : explained.headline
    );
    return fail([explained.headline, '', ...explained.lines]);
  }

  /*
   * QUIETER THAN THE SERVER, on purpose.
   *
   * At the default `info` level every export prints a wall of lines like
   *   repaired a malformed Tally payload ... Removed 4219 illegal
   *   control-character reference(s) from text fields.
   * TallyPrime emits those characters on ordinary data and the client cleans
   * them up; it is routine, not a problem. But it reads as a fault, it is the
   * only thing on screen when somebody double-clicks Run-Export to watch, and
   * at a one-minute cadence it is pure noise.
   *
   * NOTHING IS LOST BY QUIETENING IT. Every repair already travels as a warning
   * on the fetch that produced it, through `collectCompany` and onto the
   * workbook's Manifest tab — which is the record that actually gets read.
   *
   * An explicit LOG_LEVEL still wins, so a support session can turn the detail
   * back on without editing code.
   */
  const logger = createLogger(process.env.LOG_LEVEL ? config.logLevel : 'error');
  const client = new TallyClient(config, logger);
  const deps = { client, config, logger };
  const now = new Date();

  let companies;
  try {
    companies = await resolveExportCompanies(deps, config);
  } catch (error) {
    return fail([error?.message ?? String(error)]);
  }

  if (companies.length === 0) {
    return fail([
      'TallyPrime has no company open, so there was nothing to export.',
      '',
      'What to do:  open the company in TallyPrime. The scheduled export will',
      'pick it up at the next run.',
    ]);
  }

  let outcomes;
  try {
    outcomes = await runExport(deps, config, companies, now);
  } catch (error) {
    // A failure OUTSIDE any company folder — the export folder itself being
    // gone is the realistic one. There is nowhere per-company to record it, so
    // it is notified here, once, under the same rule as a closed Tally.
    notifyOnceAbout(config.tallyExportFolder, 'the export folder could not be reached');
    return fail([error?.message ?? String(error)]);
  }

  for (const outcome of outcomes) {
    if (!QUIET) {
      line(
        `${outcome.company}:  ${outcome.status} — ${outcome.reason}` +
          (outcome.status === 'exported'
            ? `  (${outcome.rows} rows, ${(outcome.durationMs / 1000).toFixed(1)}s)`
            : '')
      );
      if (outcome.workbookPath) line(`  ${outcome.workbookPath}`);
    }

    // A toast ONLY where the state changed — see the header. Best effort
    // throughout: a notification that cannot be raised must never fail a run
    // whose workbook was written correctly.
    if (!outcome.stateChanged) continue;
    if (outcome.status === 'failed') {
      toast('TallyPrime export failed', `${outcome.company}: ${outcome.reason}`);
    } else if (outcome.status === 'exported') {
      toast('TallyPrime export is working again', `${outcome.company} exported successfully.`);
    }
  }

  const failed = outcomes.filter((outcome) => outcome.status === 'failed');

  const wrote = outcomes.filter((outcome) => outcome.status === 'exported');

  if (!QUIET) {
    blank();
    if (failed.length > 0) {
      line(`${failed.length} of ${outcomes.length} companies did not export. See above.`);
    } else if (wrote.length === 0) {
      // Said accurately. "The spreadsheet was written" after a run that wrote
      // nothing is a small lie that would teach somebody to distrust the rest.
      line('Nothing needed writing — the books have not changed since the last');
      line('export, so the spreadsheet in your folder is already current.');
    } else {
      line('The spreadsheet was written to disk.');
      blank();
      line('That is all this can confirm. Whether Google Drive has UPLOADED it is');
      line("Drive's own business — check its icon in the notification area if the");
      line('cloud copy matters.');
    }
    blank();
  }

  process.exitCode = failed.length > 0 ? 1 : 0;

  // LAST, and deliberately after the exit code is set. Keeping the workbook
  // current is this task's job; fetching a new version is a convenience, and it
  // must never be the reason a successful export reports failure.
  await maybeUpdate();
}

/**
 * Check for a new version and stage it, once per run.
 *
 * Piggybacks on the export schedule rather than registering a second task: the
 * machine already wakes for this, the check is one small HTTPS request, and a
 * second scheduled task is a second thing that can be blocked by policy or
 * silently disabled.
 *
 * Nothing here can fail the run. The check swallows its own errors, and this
 * wrapper swallows anything it somehow did not — an install that cannot reach
 * GitHub is an install that keeps working, not one that starts complaining.
 */
async function maybeUpdate() {
  try {
    const installed = installedVersion();
    if (installed === null) return;

    const result = await checkForUpdate({ packageRoot: INSTALL_ROOT, installed });

    if (!QUIET) {
      blank();
      line(result.acted ? `Update ready: version ${result.staged}.` : `Update check: ${result.reason}`);
    }

    // Told once, when it happens, and never again — the staged marker stops the
    // next run repeating it. A toast every hour about the same pending update is
    // how somebody learns to ignore every toast this tool raises.
    if (result.acted) {
      toast(
        'TallyPrime for Claude has an update ready',
        `Version ${result.staged} will start being used the next time you open Claude.`
      );
    }
  } catch {
    // Best effort, as everywhere in this file.
  }
}

/** The version of the payload currently running, or null if unreadable. */
function installedVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/** Import one of the built server's modules. */
async function load(dist, relative) {
  return import(pathToFileURL(join(dist, relative)).href);
}

/**
 * Notify about a failure that happened BEFORE any company was reached — a
 * closed TallyPrime being the overwhelmingly common one.
 *
 * Once per reason per install, and then never again: a closed Tally is normal
 * evening-and-weekend behaviour, not a fault, and notifying about it on a
 * schedule is how somebody learns to ignore every notification this tool
 * raises. The reasoning, and what deliberately does NOT stop, are in
 * lib/notifyOnce.mjs.
 */
function notifyOnceAbout(exportFolder, reason) {
  notifyOnce({ installRoot: INSTALL_ROOT, exportFolder, reason });
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

function fail(lines) {
  if (!QUIET) {
    heading('The export could not finish');
    lines.forEach((text) => line(text));
    blank();
  }
  process.exitCode = 1;
}

main().catch((error) => {
  // Never show a stack trace to this audience.
  if (!QUIET) {
    heading('The export could not finish');
    line('Something unexpected went wrong.');
    blank();
    line(`Technical detail:  ${error?.message ?? String(error)}`);
    blank();
    line('Send that line to whoever set this up for you.');
    blank();
  }
  process.exitCode = 1;
});
