import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type CompanyData } from '../collect.js';
import {
  EMPTY_STATE,
  type ExportState,
} from '../fingerprint.js';
import { stampFor, } from '../folders.js';

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

/**
 * The run's own bookkeeping: state file, log, lock, and status.
 *
 * Split out of run.ts at 736 lines. The lock is the load-bearing part — an
 * unattended export that runs twice over the same workbook is worse than one
 * that skips a run, so a lock older than LOCK_STALE_MS is presumed dead rather
 * than trusted forever.
 */

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

export function describeReason(reason: 'forced' | 'first-run' | 'changed' | 'daily'): string {
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
export function writeStatusFile(folder: string, now: Date, failure: string | null): void {
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

/**
 * Mark every company folder as failing, when the run never got far enough to
 * visit them one by one.
 *
 * ## THE FOLDER WAS LYING, AND THAT IS THE POINT OF THIS
 *
 * `writeStatusFile` above is called per company from inside the export. If the
 * run dies BEFORE that — TallyPrime unreachable, no company open, the export
 * folder itself gone — no status file is touched at all, and each folder keeps
 * the one from the last run that worked. So a folder can sit there saying
 * `LAST RUN OK - 22 Aug` next to a workbook nobody has refreshed since, and
 * every failure after that is silent in the only place the reader looks.
 *
 * Observed exactly that on 2026-08-24: the export had been failing every five
 * minutes for two days, the Drive folder still said OK, and the workbook was two
 * days stale while presenting itself as current. An accountant quoting a figure
 * out of it had nothing to warn them.
 *
 * The failure notification cannot cover this. It goes to the machine running the
 * export, once; the person reading the workbook is somewhere else entirely,
 * opening a file out of a shared drive.
 *
 * A folder is anything holding `export-state.json` — written by a real export,
 * so it identifies a company folder without needing the company list, which is
 * often exactly what could not be fetched.
 *
 * Best effort throughout: this runs on a path that is already failing, and it
 * must not turn a diagnosable failure into a crash.
 */
export function markFoldersFailed(exportRoot: string, now: Date, failure: string): void {
  try {
    for (const entry of readdirSync(exportRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(exportRoot, entry.name);
      if (!existsSync(join(folder, 'export-state.json'))) continue;
      writeStatusFile(folder, now, failure);
    }
  } catch {
    // An unreachable export root is itself one of the failures that brings us
    // here; there is nothing to mark and nothing to report.
  }
}

export function formatLogLine(
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

export function appendLog(path: string, line: string): void {
  try {
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch {
    // Same rule as the status file: logging must not be able to fail a run.
  }
}

export function readState(path: string): ExportState {
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

export function writeState(path: string, state: ExportState): void {
  try {
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // Losing the state costs one unnecessary export, never a wrong workbook.
  }
}

/** How long a lock may be held before it is presumed dead. */
const LOCK_STALE_MS = 30 * 60 * 1000;

export function takeLock(path: string, now: Date): { taken: boolean } {
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

export function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never written. Either way there is nothing to do.
  }
}

/** Local date, not UTC: "the day's guaranteed run" means the operator's day. */
export function isoLocalDate(when: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
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
