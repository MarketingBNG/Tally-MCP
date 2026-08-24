import {
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildCompanyListRequest } from '../../tally/requests.js';
import { normalizeCompanies } from '../../tally/normalize.js';
import type { AppConfig } from '../../config/config.js';
import type { ToolDeps } from '../../tools/toolResult.js';
import { collectCompany, currentYearOnly, } from '../collect.js';
import {
  exportIsDue,
  readFingerprint,
} from '../fingerprint.js';
import { assignFolderNames, companyPaths, type CompanyPaths } from '../folders.js';
import { writeWorkbook } from '../workbook.js';

/**
 * One export run, end to end.
 *
 * ## What this promises, and what it explicitly does not
 *
 * It promises that a run either replaces the workbook with a complete one or
 * leaves the previous one exactly as it was. Never a half-written file: the
 * workbook is written under a temporary name in the SAME folder and renamed
 * over the target, which is atomic on NTFS, so Google Drive never uploads a
 * partial workbook.
 *
 * **It cannot confirm Google Drive uploaded anything.** That is Drive Desktop's
 * business. The run log and the status filename say the file was WRITTEN, never
 * that it synced. If Drive is signed out or paused, the local file is correct
 * and the cloud copy is stale, and only Drive's own icon will say so.
 */
import {
  appendLog,
  describeReason,
  formatLogLine,
  isoLocalDate,
  plainReason,
  readState,
  releaseLock,
  takeLock,
  writeState,
  writeStatusFile,
  type RunOutcome,
} from './state.js';
import { buildTables, writeCsvTables } from './tables.js';

/**
 * Running the export: which companies, then one company at a time.
 *
 * Split out of run.ts at 736 lines. Sequential per company by design — see
 * requestQueue.ts on why concurrency against Tally's listener buys nothing, and
 * so a failure names the company that caused it.
 */

/**
 * Which companies this run covers, and — crucially — under Tally's own spelling.
 *
 * When configuration names them, each name is matched against the loaded list
 * and the CANONICAL spelling is used from there on. A configured name that
 * TallyPrime does not have open is refused by name rather than silently
 * skipped: silence would produce a run that reported success having exported
 * fewer companies than the operator asked for.
 *
 * When configuration names none, this is every company TallyPrime currently has
 * open. That is honest — the Manifest records the name Tally gave — but it does
 * mean the set can change without anyone editing the configuration, which is
 * why Setup asks.
 */
export async function resolveExportCompanies(
  deps: ToolDeps,
  config: AppConfig
): Promise<string[]> {
  const response = await deps.client.send(buildCompanyListRequest(), 'standard');
  const loaded = normalizeCompanies(response.body).data.map((company) => company.name);

  const configured = (config.tallyExportCompanies ?? '')
    .split(';')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  if (configured.length === 0) return loaded;

  const resolved: string[] = [];
  const missing: string[] = [];

  for (const wanted of configured) {
    const match = loaded.find((name) => name.toLowerCase() === wanted.toLowerCase());
    if (match === undefined) missing.push(wanted);
    else resolved.push(match);
  }

  if (missing.length > 0) {
    throw new Error(
      `TallyPrime does not have ${missing.map((name) => `"${name}"`).join(', ')} open.\n\n` +
        `Currently open:\n${loaded.map((name) => `  - ${name}`).join('\n') || '  (none)'}\n\n` +
        'What to do: open those companies in TallyPrime, or run Setup again and correct the ' +
        'list. Nothing was exported for them, and a run that quietly skipped them would report ' +
        'success having done less than you asked.'
    );
  }

  return resolved;
}

/**
 * Export every configured company.
 *
 * Companies are named EXPLICITLY where configuration names them. TallyPrime
 * holds several at once and answers an unscoped request from whichever it
 * considers current — that is how a workbook ends up labelled one company and
 * read from another, which is the worst failure this export can have.
 */
export async function runExport(
  deps: ToolDeps,
  config: AppConfig,
  companies: readonly string[],
  now: Date
): Promise<RunOutcome[]> {
  const exportFolder = config.tallyExportFolder;
  if (exportFolder === undefined) {
    throw new Error(
      'No export folder is configured, so there is nowhere to write. Run Setup and answer the ' +
        'export questions.'
    );
  }

  // Checked here rather than left to fail at the first write. A folder that has
  // gone — an unmapped drive letter, a Drive folder someone moved — is one of
  // the three failures the plan names, and it deserves the plain-language
  // message rather than an OS error nobody can act on.
  try {
    mkdirSync(exportFolder, { recursive: true });
  } catch (error) {
    throw new Error(
      `The export folder could not be reached or created:\n  ${exportFolder}\n\n` +
        'What to do: check the folder still exists and that this computer can write to it. ' +
        'A mapped drive that is not connected, or a Google Drive folder somebody moved or ' +
        'renamed, is the usual cause. Run Setup again to choose a different folder.\n\n' +
        `Technical detail: ${String(error)}`,
      { cause: error }
    );
  }

  const labels = assignFolderNames(companies);
  const outcomes: RunOutcome[] = [];

  for (const company of companies) {
    outcomes.push(
      await runOneCompany(deps, config, exportFolder, company, labels.get(company) ?? company, now)
    );
  }

  return outcomes;
}

async function runOneCompany(
  deps: ToolDeps,
  config: AppConfig,
  exportFolder: string,
  company: string,
  label: string,
  now: Date
): Promise<RunOutcome> {
  const started = Date.now();
  let paths: CompanyPaths;

  try {
    paths = companyPaths(exportFolder, company, label, now);
  } catch (error) {
    // A path that will not fit is reported before anything is fetched — an
    // opaque OS error at rename time, after a twenty-second fetch, is the worst
    // place to discover a path problem. The log line goes to the export folder
    // rather than the company folder, since the company folder is the thing
    // that could not be named.
    appendLog(
      join(exportFolder, 'run-log.txt'),
      `${now.toISOString()}  FAILED  ${company}  ${String(error)}`
    );
    return {
      company,
      status: 'failed',
      reason: 'the export folder is too deep for this company name',
      rows: 0,
      durationMs: Date.now() - started,
      workbookPath: null,
      stateChanged: true,
    };
  }

  mkdirSync(paths.folder, { recursive: true });
  const state = readState(paths.statePath);

  // Belt and braces with the scheduled task's own "do not start a second
  // instance": a slow Tally turning a 20s export into a 90s one at 1-minute
  // intervals would otherwise have two runs writing the same workbook.
  const lock = takeLock(paths.lockPath, now);
  if (!lock.taken) {
    return {
      company,
      status: 'unchanged',
      reason: 'a previous run is still going',
      rows: 0,
      durationMs: Date.now() - started,
      workbookPath: null,
      stateChanged: false,
    };
  }

  try {
    const fingerprint = await readFingerprint(deps, company);
    const today = isoLocalDate(now);
    const due = exportIsDue(state, fingerprint, today, config.tallyExportForce);

    if (!due.due) {
      // A minute that found nothing changed is COUNTED, not logged in full.
      // At this cadence a line per minute would be 1,440 a day saying "no
      // change", and the log has to stay readable to be worth keeping.
      writeState(paths.statePath, {
        ...state,
        unchangedRuns: state.unchangedRuns + 1,
      });
      return {
        company,
        status: 'unchanged',
        reason: 'nothing changed in the books',
        rows: 0,
        durationMs: Date.now() - started,
        workbookPath: null,
        stateChanged: false,
      };
    }

    const data = await collectCompany(deps, company, now);
    const tables = buildTables(data, describeReason(due.reason), 'all-years');
    const rows = tables.reduce((total, table) => total + table.rows.length, 0);

    /*
     * Same folder as the target, so the rename below is a move within one
     * volume and therefore atomic. A temp file on another drive would be a
     * copy, and a copy can be observed half-done.
     *
     * ONE FIXED NAME, overwritten every run — not a timestamped one. A run
     * killed between writing this file and renaming it (the machine shut down,
     * the task hit its time limit) leaves the file behind; with a timestamp in
     * the name each such crash would leave a new ~250KB orphan in a folder that
     * syncs to Drive, and would need a sweeper to tidy up after it. With a
     * fixed name the next run simply writes over it, so the mess cannot
     * accumulate and there is nothing to clean up.
     *
     * Safe against two runs at once because there is only ever one: the task's
     * IgnoreNew policy and the lock file above both prevent it, and each
     * company has its own folder.
     */
    const temporary = join(paths.folder, '~export in progress.xlsx.tmp');
    await writeWorkbook(temporary, tables, { company: data.company.name, asOf: data.asOf });

    try {
      renameSync(temporary, paths.workbook);
    } catch (error) {
      // Almost always the workbook being open in local Excel, which holds a
      // lock on it. The temp file is KEPT rather than discarded: the export
      // succeeded, only the replacement failed, and throwing away twenty
      // seconds of Tally's work would be wasteful.
      //
      // ONE FIXED NAME, overwritten each time — NOT a dated one. A dated name
      // looks tidier and is a trap: the books still differ from the last
      // successful export, so every minute retries, fails the same way, and
      // leaves another 250KB file. Measured: two files in two minutes. Left
      // over a working day that is ~1,400 files and ~350MB, every one of them
      // syncing to Google Drive.
      const kept = join(paths.folder, 'Could not replace the workbook - latest attempt.xlsx');
      try {
        // Remove first: rename onto an existing file fails on Windows.
        rmSync(kept, { force: true });
        renameSync(temporary, kept);
      } catch {
        rmSync(temporary, { force: true });
      }
      throw new Error(
        'The workbook could not be replaced because something has it open — almost always ' +
          `Excel on this computer.\n\nClose the workbook and it will be replaced at the next ` +
          `run. This run's data was kept as:\n  ${kept}\n\nTechnical detail: ${String(error)}`,
        { cause: error }
      );
    }

    /*
     * The current-year companion, written once the full file is safely in place.
     *
     * Best effort on purpose. The full workbook is the deliverable; this one is
     * a convenience for the question people actually ask, and failing the run
     * over it would report a failure that did not happen. It IS written before
     * the archive copy, so a folder with room for one more file gets the one
     * people read rather than the one they rarely open.
     */
    let companionNote: string | null = null;
    try {
      const narrowed = currentYearOnly(data);
      const narrowTables = buildTables(narrowed, describeReason(due.reason), 'current-year');
      const narrowTemp = join(paths.folder, '~current year in progress.xlsx.tmp');
      await writeWorkbook(narrowTemp, narrowTables, {
        company: data.company.name,
        asOf: data.asOf,
      });
      // Remove first: a rename onto an existing file fails on Windows.
      rmSync(paths.currentYearWorkbook, { force: true });
      renameSync(narrowTemp, paths.currentYearWorkbook);
    } catch (error) {
      companionNote = `the current-year companion workbook could not be written: ${String(error)}`;
    }

    /*
     * The per-tab CSVs, for a reader that wants one table rather than a whole
     * workbook. See src/export/csv.ts for the measurement that justifies them:
     * the workbook arrives at a connector as base64, which is ~89,000 tokens
     * for the current-year file and ~476,000 for the full one, whereas a
     * trial-balance CSV is under a thousand.
     *
     * Built from the FULL tables, not the narrowed ones. Per-tab granularity
     * means a reader only pays for the table it fetches, so there is no reason
     * to withhold history here — the small tabs stay small either way.
     *
     * Best effort, like the companion workbook: the deliverable is the .xlsx.
     */
    let csvNote: string | null = null;
    try {
      writeCsvTables(paths.csvFolder, tables);
    } catch (error) {
      csvNote = `the per-tab CSV files could not be written: ${String(error)}`;
    }

    /*
     * One dated copy A DAY, written by the daily guaranteed run rather than by
     * every export. At a one-minute cadence a copy per run would bury the
     * folder within hours.
     *
     * BEST EFFORT, and deliberately so. The workbook has already been replaced
     * successfully by this point — the export worked. If the archive copy
     * cannot be written (a full disk, a read-only Archive folder), failing the
     * whole run would be wrong twice over: it would report a failure that did
     * not happen, and because `archivedOn` would never advance, the daily
     * condition would stay true and re-export every single minute forever.
     */
    let archivedOn = state.archivedOn;
    let archiveNote: string | null = null;
    if (archivedOn !== today) {
      try {
        mkdirSync(paths.archiveFolder, { recursive: true });
        copyFileSync(paths.workbook, paths.archiveWorkbook);
        archivedOn = today;
      } catch (error) {
        // Recorded so a folder that has silently stopped keeping history is
        // discoverable, rather than only noticed when somebody needs an old copy.
        archiveNote = `today's Archive copy could not be written: ${String(error)}`;
        // `archivedOn` is still advanced. Otherwise this retries every minute
        // for the rest of the day, re-exporting the whole company each time to
        // chase a copy that is not going to succeed.
        archivedOn = today;
      }
    }

    const outcome: RunOutcome = {
      company,
      status: 'exported',
      reason: describeReason(due.reason),
      rows,
      durationMs: Date.now() - started,
      workbookPath: paths.workbook,
      stateChanged: state.lastFailure !== null,
    };

    writeState(paths.statePath, {
      digest: fingerprint.digest,
      exportedAt: now.toISOString(),
      archivedOn,
      lastFailure: null,
      unchangedRuns: 0,
    });

    writeStatusFile(paths.folder, now, null);
    appendLog(paths.logPath, formatLogLine(now, outcome, state.unchangedRuns, data));
    if (archiveNote !== null) appendLog(paths.logPath, `    WARNING: ${archiveNote}`);
    if (companionNote !== null) appendLog(paths.logPath, `    WARNING: ${companionNote}`);
    if (csvNote !== null) appendLog(paths.logPath, `    WARNING: ${csvNote}`);
    return outcome;
  } catch (error) {
    const reason = plainReason(error);

    // The first failure notifies; repeats go quietly to the log. At a
    // one-minute cadence, notifying every failure would fire once a minute for
    // as long as somebody leaves the workbook open.
    const stateChanged = state.lastFailure !== reason;

    writeState(paths.statePath, { ...state, lastFailure: reason, unchangedRuns: 0 });
    writeStatusFile(paths.folder, now, reason);
    appendLog(
      paths.logPath,
      `${now.toISOString()}  FAILED  ${company}  ${reason}\n    ${String(error).replace(/\n/g, '\n    ')}`
    );

    return {
      company,
      status: 'failed',
      reason,
      rows: 0,
      durationMs: Date.now() - started,
      workbookPath: null,
      stateChanged,
    };
  } finally {
    releaseLock(paths.lockPath);
  }
}
