import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildCompanyListRequest } from '../tally/requests.js';
import { normalizeCompanies } from '../tally/normalize.js';
import type { AppConfig } from '../config/config.js';
import type { ToolDeps } from '../tools/toolResult.js';
import { collectCompany, currentYearOnly, type CompanyData } from './collect.js';
import {
  EMPTY_STATE,
  exportIsDue,
  readFingerprint,
  type ExportState,
} from './fingerprint.js';
import { assignFolderNames, companyPaths, stampFor, type CompanyPaths } from './folders.js';
import { contentsTable, manifestTable } from './manifest.js';
import {
  balanceSheetTable,
  closingStockTable,
  currenciesTable,
  godownsTable,
  groupsTable,
  ledgerBalancesTable,
  ledgersTable,
  genericReportTable,
  monthlyFlowTable,
  nestedStructureTables,
  usedMastersTable,
  notInThisWorkbookTable,
  payablesTable,
  profitLossTable,
  receivablesTable,
  simpleMasterTables,
  statementsByYearTables,
  stockItemsTable,
  tallyDefaultsTable,
  trialBalanceTable,
  voucherEntriesTable,
  vouchersTable,
  voucherTypesTable,
  type Table,
} from './tables.js';
import { writeWorkbook } from './workbook.js';
import { csvFileName, csvIndex, toCsv } from './csv.js';

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

/** The tab order the workbook is built in. Contents and Manifest come first. */
function buildTables(
  data: CompanyData,
  runReason: string,
  scope: 'all-years' | 'current-year'
): Table[] {
  const godowns = godownsTable(data);
  const cashFlow = monthlyFlowTable(
    'Cash flow',
    "TallyPrime's own monthly Cash Flow. One row per month; the Net column is Tally's own " +
      'figure, not one computed here.',
    data.cashFlow
  );
  const fundsFlow = monthlyFlowTable(
    'Funds flow',
    "TallyPrime's own monthly Funds Flow. Debit and credit are the month's opening and closing " +
      "funds on this report, and Net is Tally's own figure — the arithmetic differs from cash " +
      'flow, so do not assume the columns mean the same thing.',
    data.fundsFlow
  );

  const body: Table[] = [
    // The books
    trialBalanceTable(data),
    ledgerBalancesTable(data),
    vouchersTable(data),
    voucherEntriesTable(data),
    receivablesTable(data),
    payablesTable(data),
    profitLossTable(data),
    balanceSheetTable(data),
    ...(cashFlow === null ? [] : [cashFlow]),
    ...(fundsFlow === null ? [] : [fundsFlow]),

    // The same three statements across every book year the company holds.
    ...statementsByYearTables(data),

    // The detail inside vouchers — DISCOVERED, not listed. Whatever structures
    // this company records get a tab, at every level they nest to.
    ...nestedStructureTables(data),
    usedMastersTable(data),

    // The masters
    ledgersTable(data),
    groupsTable(data),
    voucherTypesTable(data),
    stockItemsTable(data),
    closingStockTable(data),
    currenciesTable(data),
    ...(godowns === null ? [] : [godowns]),

    // The real master lists, reachable since the collection types were re-probed.
    ...simpleMasterTables(data),

    // TallyPrime's own register and exception views
    ...data.reports.map((entry) => genericReportTable(entry)),

    // The rest
    tallyDefaultsTable(data),
    notInThisWorkbookTable(),
  ];

  // Built from the body, so the row counts on both are measured from what was
  // actually assembled rather than from what was intended.
  const manifest = manifestTable(data, body, runReason, scope);
  const contents = contentsTable([manifest, ...body]);

  return [contents, manifest, ...body];
}

/**
 * Write one CSV per tab, plus the index a reader fetches first.
 *
 * Each file goes to a temp name and is renamed into place, so Google Drive
 * never uploads a half-written table — the same rule the workbook follows, for
 * the same reason.
 *
 * Files from a PREVIOUS run whose tab no longer exists are removed. A company
 * that stops using GST should not leave a GST table behind for somebody to read
 * as current; the tab would be gone from the workbook and only the stale CSV
 * would still claim it.
 */
function writeCsvTables(folder: string, tables: readonly Table[]): void {
  mkdirSync(folder, { recursive: true });

  const written = new Set<string>();

  const put = (name: string, body: string): void => {
    const target = join(folder, name);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, body, 'utf8');
    rmSync(target, { force: true });
    renameSync(temporary, target);
    written.add(name.toLowerCase());
  };

  put('INDEX.csv', csvIndex(tables));
  for (const table of tables) put(csvFileName(table.title), toCsv(table));

  // Stale tables from an earlier run.
  for (const entry of readdirSync(folder)) {
    if (!entry.toLowerCase().endsWith('.csv')) continue;
    if (written.has(entry.toLowerCase())) continue;
    rmSync(join(folder, entry), { force: true });
  }
}

/** What one company's run did, for the log and the caller. */
export interface RunOutcome {
  company: string;
  status: 'exported' | 'unchanged' | 'failed';
  /** Plain-language reason. Goes in the status filename, so no jargon. */
  reason: string;
  rows: number;
  durationMs: number;
  workbookPath: string | null;
  /** True when this run's state DIFFERS from the last — the toast condition. */
  stateChanged: boolean;
}

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

/**
 * A failure reason an accountant can act on, and short enough for a filename.
 *
 * No error codes and no jargon, per the rule the installer scripts already
 * follow: "ECONNREFUSED" tells the user nothing.
 */
export function plainReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/ECONNREFUSED|EHOSTUNREACH|Could not reach TallyPrime|TALLY_CONNECTION_FAILED/i.test(message)) {
    return 'TallyPrime was not open';
  }
  // The folder is checked BEFORE the workbook, and the workbook branch needs
  // evidence that it was the workbook. `EPERM` and `EBUSY` arrive from both
  // situations, so a bare code test on the workbook branch would report "the
  // workbook is open in Excel" to somebody whose export folder had gone
  // read-only — sending them to close a file that was never the problem.
  if (/could not be reached or created|ENOENT|EACCES|EROFS|no such file or directory|permission denied/i.test(message)) {
    return 'the export folder is missing or cannot be written to';
  }
  if (/has it open|EBUSY|EPERM|resource busy or locked/i.test(message)) {
    return 'the workbook is open in Excel';
  }
  if (/does not have .* open|TALLY_COMPANY_NOT_LOADED/i.test(message)) {
    return 'the company is not open in TallyPrime';
  }
  if (/timed out|ETIMEDOUT|TALLY_TIMEOUT/i.test(message)) {
    return 'TallyPrime did not answer in time';
  }
  return 'something unexpected went wrong';
}

function describeReason(reason: 'forced' | 'first-run' | 'changed' | 'daily'): string {
  switch (reason) {
    case 'forced':
      return 'an export was asked for explicitly';
    case 'first-run':
      return 'this is the first export for this company';
    case 'changed':
      return 'the books changed since the last export';
    default:
      return "nothing changed, but this is the day's guaranteed run";
  }
}

/**
 * The news, in a filename — visible in the folder without opening anything.
 *
 * Exactly one status file exists at a time, so "LAST RUN" is never ambiguous.
 */
function writeStatusFile(folder: string, now: Date, failure: string | null): void {
  try {
    const name =
      failure === null
        ? `LAST RUN OK - ${stampFor(now)}.txt`
        : `LAST RUN FAILED - ${failure} - ${stampFor(now)}.txt`;

    // WRITE FIRST, then remove the older ones. The other order — clear the
    // folder, then write — leaves NO status file at all if the write fails,
    // which is the one moment somebody is most likely to be looking at the
    // folder wondering what happened. The name carries the outcome and the
    // time, so it necessarily changes; a superseded one is not information
    // anybody wants, and run-log.txt keeps the full history either way.
    writeFileSync(
      join(folder, name),
      failure === null
        ? [
            'The last export finished and the workbook in this folder was replaced.',
            '',
            'This says the file was WRITTEN. It does NOT say Google Drive has uploaded it —',
            'only Drive\'s own icon can tell you that.',
          ].join('\n')
        : [
            `The last export did not finish: ${failure}.`,
            '',
            'The workbook in this folder is the one from the last run that DID finish, so it',
            'is still readable — check its as-at date on the Manifest tab before quoting it.',
            '',
            'See run-log.txt in this folder for the detail.',
          ].join('\n'),
      'utf8'
    );

    // Now the superseded ones, and never the one just written — a same-minute
    // rerun with the same outcome produces the same name, and deleting it would
    // leave the folder saying nothing.
    for (const entry of readdirSync(folder)) {
      if (entry.startsWith('LAST RUN ') && entry !== name) {
        rmSync(join(folder, entry), { force: true });
      }
    }
  } catch {
    // Best effort. A status file that cannot be written must never take the
    // export down with it — the run log already has the outcome.
  }
}

function formatLogLine(
  now: Date,
  outcome: RunOutcome,
  unchangedRuns: number,
  data: CompanyData
): string {
  const parts = [
    now.toISOString(),
    'EXPORTED',
    outcome.company,
    outcome.reason,
    `${String(outcome.rows)} rows`,
    `${String(data.vouchers.length)} vouchers`,
    `${String(outcome.durationMs)}ms`,
    outcome.workbookPath ?? '',
  ];
  const quiet =
    unchangedRuns > 0
      ? `\n    (${String(unchangedRuns)} run(s) since the last line found nothing changed)`
      : '';
  return parts.join('  ') + quiet;
}

function appendLog(path: string, line: string): void {
  try {
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch {
    // Same rule as the status file: logging must not be able to fail a run.
  }
}

function readState(path: string): ExportState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ExportState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    // A missing or unreadable state file means "we know nothing", which makes
    // the next run a first run. That exports once unnecessarily; the
    // alternative — assuming the last digest — would skip an export it owed.
    return { ...EMPTY_STATE };
  }
}

function writeState(path: string, state: ExportState): void {
  try {
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // Losing the state costs one unnecessary export, never a wrong workbook.
  }
}

/** How long a lock may be held before it is presumed dead. */
const LOCK_STALE_MS = 30 * 60 * 1000;

function takeLock(path: string, now: Date): { taken: boolean } {
  try {
    if (existsSync(path)) {
      const held = Number(readFileSync(path, 'utf8').trim());
      // A machine that was switched off mid-run leaves a lock nothing will
      // ever release. Half an hour is far longer than any real export and far
      // shorter than a working day, so a crashed run self-heals by lunchtime
      // rather than silently stopping the schedule forever.
      if (Number.isFinite(held) && now.getTime() - held < LOCK_STALE_MS) return { taken: false };
    }
    writeFileSync(path, String(now.getTime()), 'utf8');
    return { taken: true };
  } catch {
    // If the lock cannot be written, the folder is unwritable and the export
    // is going to fail anyway. Proceed, so the failure is the REAL one and
    // gets the plain-language reason rather than a lock message.
    return { taken: true };
  }
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never written. Either way there is nothing to do.
  }
}

/** Local date, not UTC: "the day's guaranteed run" means the operator's day. */
function isoLocalDate(when: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}
