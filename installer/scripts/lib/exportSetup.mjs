import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Setting up the scheduled spreadsheet export.
 *
 * Two things happen here and they are deliberately separate: writing the
 * settings, and registering the Windows task. The first is safe and repeatable;
 * the second touches the machine's task schedule and is always offered rather
 * than assumed.
 *
 * ## Where the settings go
 *
 * The `.env` file beside the server, which `src/config/config.ts` already
 * reads. NOT the Claude Desktop config's `env` block, even though the connector
 * uses that — the exporter runs from the scheduler with no Claude in the
 * picture, so it needs settings of its own.
 *
 * ## The task, and the two options on it that matter
 *
 * - `/IT` — "only when the user is logged on". Without it the toast has nowhere
 *   to appear, and a run under a service account cannot see the user's mapped
 *   Google Drive folder either.
 * - `/F` on re-registration, so running Setup twice updates the task rather
 *   than failing on "already exists".
 *
 * Windows will not start a second instance of a task that is still running,
 * which is the outer half of the overlap guard. The exporter takes a lock file
 * as well — belt and braces, because a slow Tally turning a 20-second export
 * into a 90-second one at one-minute intervals is exactly when it matters.
 */

/** The name the task appears under in Task Scheduler. */
export const TASK_NAME = 'TallyPrime for Claude - Export';

/**
 * Read one setting out of the .env beside the server.
 *
 * Line-based and dependency-free, matching `writeEnvSettings` above. Shared with
 * the doctor, which must be able to read settings in a folder whose build is
 * broken — one of the things it exists to diagnose.
 *
 * @returns {string|null} The value, or null when absent or empty.
 */
export function readEnvSetting(packageRoot, key) {
  try {
    const text = readFileSync(join(packageRoot, '.env'), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#') || !line.startsWith(`${key}=`)) continue;
      const value = line.slice(key.length + 1).trim();
      if (value !== '') return value;
    }
  } catch {
    // No .env, or unreadable. Either way the setting is not configured.
  }
  return null;
}

/**
 * Load the .env beside the server into `process.env`.
 *
 * ## Why this exists, and what it cost to find
 *
 * The server reads its settings through `dotenv`, which looks for `.env` in the
 * **current working directory**, which is never the install folder: not under
 * Claude Desktop, Codex or UIC GPT (the server covers that itself, see
 * `installEnvPath` in src/config/config.ts), and not under the SCHEDULER:
 * Task Scheduler runs an action with the working directory set to
 * `C:\Windows\System32`, so `.env` is nowhere to be found.
 *
 * Observed on the real registration, 2026-08-19: the task fired on the minute,
 * exited 1, and reported "No export folder has been chosen yet" — every minute,
 * forever, on an install that was correctly configured. Nothing in the unit
 * tests could see it, because they never run from another directory.
 *
 * Called BEFORE the server's config module is imported, since `dotenv` runs at
 * import time. Values already present in the real environment are left alone, so
 * this fills gaps rather than overriding a deliberate setting.
 */
export function loadEnvFile(packageRoot) {
  let text;
  try {
    text = readFileSync(join(packageRoot, '.env'), 'utf8');
  } catch {
    // No .env is normal — under Claude Desktop the settings come from its own
    // config. Nothing to do, and not an error.
    return [];
  }

  const applied = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const at = line.indexOf('=');
    if (at < 1) continue;

    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === '' || value === '') continue;

    // The real environment wins. Someone who set a variable for one run meant it.
    if (process.env[key] !== undefined) continue;

    process.env[key] = value;
    applied.push(key);
  }

  return applied;
}

/**
 * Move the export's own files from an old folder to a new one.
 *
 * ## Why this only moves SOME of the folder
 *
 * The obvious implementation copies the whole folder and deletes it. That is
 * wrong here, and dangerously so. The folder is one a person chose in a picker,
 * and there is nothing stopping them choosing `G:\Shared drives\Accounts` — a
 * folder holding payroll files, scans, somebody's working papers. Deleting "the
 * old folder" would take all of it.
 *
 * Worse, if that folder is inside Google Drive, a local delete propagates: the
 * cloud copy goes, and so does everyone else's synced copy. There is no way to
 * make that reversible from here.
 *
 * So this moves only what the exporter itself created, identified by structure
 * rather than by name — see `isOwnedByExport`. Anything else is left exactly
 * where it is, and the old folder itself is removed only if it ends up empty.
 *
 * ## Copy, verify, then delete — in that order
 *
 * Nothing is deleted until its copy has been confirmed present and the same
 * size. A half-finished move that deleted as it went would lose books, and the
 * one thing worse than a stale workbook is a missing one.
 *
 * @returns {{moved: string[], left: string[], failed: string[], oldFolderRemoved: boolean}}
 */
export function moveExportData(oldFolder, newFolder) {
  const moved = [];
  const left = [];
  const failed = [];

  let entries;
  try {
    entries = readdirSync(oldFolder, { withFileTypes: true });
  } catch {
    // Old folder gone or unreadable — nothing to move, and not an error.
    return { moved, left, failed, oldFolderRemoved: false };
  }

  mkdirSync(newFolder, { recursive: true });

  for (const entry of entries) {
    const from = join(oldFolder, entry.name);

    if (!isOwnedByExport(from, entry)) {
      // Not ours. Never copied, never deleted, never mentioned again except in
      // the count we report back.
      left.push(entry.name);
      continue;
    }

    const to = join(newFolder, entry.name);

    try {
      // Overwrites a same-named file at the destination on purpose: the
      // workbook is regenerated on every run anyway, and archive copies carry
      // a timestamp in the name so they cannot collide by accident.
      cpSync(from, to, { recursive: true, force: true });

      // VERIFIED before anything is removed.
      if (!copyLooksComplete(from, to)) {
        failed.push(entry.name);
        continue;
      }

      rmSync(from, { recursive: true, force: true });
      moved.push(entry.name);
    } catch {
      // Left in place. A file that could not be copied must not be deleted.
      failed.push(entry.name);
    }
  }

  // Only when there is genuinely nothing left. An empty folder is tidy to
  // remove; a folder still holding somebody else's files is not ours to touch.
  let oldFolderRemoved = false;
  try {
    if (readdirSync(oldFolder).length === 0) {
      // `rmdirSync`, deliberately, not `rmSync({recursive: true})`. It REFUSES a
      // folder that is not empty, which makes it a second guarantee on top of
      // the check above rather than a way of ignoring it. A recursive delete
      // here would be one wrong condition away from taking somebody's files.
      rmdirSync(oldFolder);
      oldFolderRemoved = true;
    }
  } catch {
    // Leave it. A folder that will not delete is a cosmetic problem.
  }

  return { moved, left, failed, oldFolderRemoved };
}

/**
 * Did the exporter create this?
 *
 * By STRUCTURE, not by name. A company folder is recognised by the state file
 * the exporter writes into it — a name match would be a guess, and the guess
 * that matters is the one that wrongly claims someone else's folder.
 */
function isOwnedByExport(path, entry) {
  if (entry.isDirectory()) {
    // The state file is written on the first run and never by anything else.
    return existsSync(join(path, 'export-state.json'));
  }

  return (
    entry.name === 'run-log.txt' ||
    entry.name === 'last-failure.txt' ||
    entry.name.startsWith('LAST RUN ') ||
    entry.name.startsWith('THIS FOLDER IS NO LONGER UPDATED')
  );
}

/**
 * Is the copy really there?
 *
 * Files are compared by size; folders by the count of entries at every level.
 * Not a checksum — this runs on 20MB workbooks and a hash would add seconds for
 * a class of corruption `cpSync` does not silently produce. The point is to
 * catch a copy that did not finish, which is what a delete must never follow.
 */
function copyLooksComplete(from, to) {
  try {
    const source = statSync(from);
    const target = statSync(to);

    if (source.isFile()) return target.isFile() && source.size === target.size;
    if (!target.isDirectory()) return false;

    const sourceEntries = readdirSync(from, { withFileTypes: true });
    for (const entry of sourceEntries) {
      if (!copyLooksComplete(join(from, entry.name), join(to, entry.name))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Leave a note in a folder the export has stopped writing to.
 *
 * ## Why this is not optional
 *
 * Changing the export folder orphans whatever is in the old one — and an orphaned
 * workbook is the most dangerous artefact this whole design can produce. It is a
 * real spreadsheet, with real figures, in a folder somebody bookmarked, and it
 * looks exactly like a current one. If the old folder was inside Google Drive it
 * is still syncing, so Claude pointed at it would answer from books that stopped
 * updating the day the folder changed, and the only clue would be an as-at stamp
 * nobody thought to check.
 *
 * **Nothing is deleted.** Client accounting data is never removed by this
 * installer, and a folder someone chose may hold things we did not put there. The
 * note is what makes the situation visible; what to do about it is their call.
 *
 * Best effort: the old folder may already be gone, or on a disconnected drive.
 * Failing to leave a note must not fail the change of setting.
 */
export function markFolderRetired(oldFolder, newFolder, when) {
  try {
    if (!existsSync(oldFolder)) return false;

    const stamp =
      `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;

    writeFileSync(
      join(oldFolder, `THIS FOLDER IS NO LONGER UPDATED - ${stamp}.txt`),
      [
        'The TallyPrime export STOPPED writing to this folder on ' + stamp + '.',
        '',
        'It now writes to:',
        '   ' + newFolder,
        '',
        'WHAT THAT MEANS FOR THE SPREADSHEET IN HERE',
        '',
        '   It is frozen as at the last time it was written, which was on or',
        '   before the date above. It is not wrong -- those figures were real --',
        '   but it will never update again, and it looks exactly like a current',
        '   one.',
        '',
        '   Do not answer questions from it, and do not point Claude at it.',
        '   Check the Manifest tab of any spreadsheet before quoting it: it',
        '   carries the date and time the figures were read from Tally.',
        '',
        'NOTHING HAS BEEN DELETED. Everything in this folder is exactly as it',
        'was. If you still need the history, keep it; if you do not, it is safe',
        'to delete the folder yourself once you are sure.',
        '',
        'If this was a mistake, run Setup again and choose this folder.',
      ].join('\n'),
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Ask Windows to show a folder picker, and return what was chosen.
 *
 * ## Why this exists rather than "paste the path"
 *
 * Typing a path is the step where this audience gets stuck. `G:\Shared
 * drives\Accounts\Tally exports` has to be exactly right, spaces and all, and a
 * wrong one is not rejected in any obvious way — Setup would happily save it and
 * the scheduled task would then fail every minute against a folder that does not
 * exist. A picker cannot produce a path that is not there.
 *
 * ## Why PowerShell rather than a Node package
 *
 * The shipped folder carries a bundled Node runtime and production dependencies
 * only; a GUI toolkit is not among them and is not worth 40MB. `powershell.exe`
 * — Windows PowerShell 5.1, present on every Windows install, unlike `pwsh` —
 * can raise the native dialog with three lines and print the answer to stdout.
 *
 * ## It must never be the only way in
 *
 * A dialog can fail to appear at all: a machine where policy blocks it, a
 * session with no interactive desktop, a PowerShell that has been locked down.
 * So this returns null on ANY failure and the caller falls back to asking for a
 * typed path. A picker that cannot be shown must not become an install that
 * cannot be completed.
 *
 * @param {string} description Shown at the top of the dialog.
 * @param {string|null} [currentFolder] Where the export writes today, if anywhere.
 *   Preselected, so somebody changing the folder starts from the one they have
 *   rather than hunting for it again.
 * @returns {string|null} The chosen folder, or null if cancelled or unavailable.
 */
export function pickFolder(description, currentFolder = null) {
  // Preselected so the dialog opens somewhere useful rather than at This PC.
  // The folder in use wins over a guess; failing that, Google Drive Desktop
  // mounts as a drive letter, and Shared drives is where this folder belongs —
  // see the README on why not My Drive.
  const start =
    currentFolder !== null && existsSync(currentFolder)
      ? currentFolder
      : (likelyDriveFolder() ?? '');

  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = ${psQuote(description)}`,
    // The user will often be creating this folder for the first time.
    '$d.ShowNewFolderButton = $true',
    '$d.RootFolder = [System.Environment+SpecialFolder]::MyComputer',
    start === '' ? '' : `$d.SelectedPath = ${psQuote(start)}`,
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
  ]
    .filter((piece) => piece !== '')
    .join('; ');

  try {
    const chosen = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        // FolderBrowserDialog needs a single-threaded apartment. Without this
        // the dialog throws rather than appearing on some hosts.
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        encoding: 'utf8',
        // Generous, because a person has to find a folder — but bounded, so a
        // dialog nobody can see cannot wedge Setup forever.
        timeout: 5 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();

    // Empty means Cancel, which is a real answer and not a failure.
    return chosen === '' ? null : chosen;
  } catch (error) {
    // No PowerShell, no desktop, a policy in the way, or the timeout. The
    // caller asks for a typed path instead.
    //
    // The reason is normally swallowed, because it is a stack trace by another
    // name and this audience must never be shown one. But a picker that fails
    // on a customer's machine is otherwise INVISIBLE — indistinguishable from
    // somebody pressing Cancel — so `TALLY_SETUP_DEBUG=1` prints it to stderr
    // for whoever is being asked to explain it.
    if (process.env.TALLY_SETUP_DEBUG === '1') {
      process.stderr.write(
        `\n[folder picker failed] exit=${String(error?.status)} ` +
          `signal=${String(error?.signal)}\n${String(error?.stderr ?? error?.message ?? error)}\n`
      );
    }
    return null;
  }
}

/**
 * A sensible place to open the picker: the machine's Google Drive mount.
 *
 * A guess, and treated as one — it only decides where a dialog starts, so being
 * wrong costs the user a couple of clicks and nothing else. Shared drives is
 * preferred over My Drive for the reason the README gives: a workbook in one
 * person's My Drive disappears when their account does.
 */
function likelyDriveFolder() {
  const candidates = [];
  for (const letter of DRIVE_LETTERS) {
    candidates.push(`${letter}:\\Shared drives`, `${letter}:\\My Drive`);
  }
  const profile = process.env.USERPROFILE;
  // Documents USED TO BE the last candidate here, and it was a trap. On a
  // machine with no Drive mount the picker then opened straight into a purely
  // local folder — the one choice that leaves the spreadsheets visible to
  // nobody but this computer — with the dialog itself appearing to suggest it.
  //
  // A local folder is no longer BROKEN (the server reads the export folder from
  // disk now), but it is still the wrong thing to propose. With no Drive mount
  // the picker opens at This PC and the person chooses it knowingly or not at all.
  if (profile) candidates.push(join(profile, 'Google Drive'));

  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Drive letters Google Drive Desktop commonly mounts on. */
const DRIVE_LETTERS = ['G', 'H', 'I', 'J', 'K'];

/**
 * Does this folder look like one a sync client keeps in the cloud?
 *
 * ## Why this WARNS and never blocks
 *
 * It is a heuristic and cannot be anything else: Drive can be mounted on a
 * letter not listed here, and plenty of people sync with OneDrive, Dropbox or a
 * mapped network share instead. A false negative is certain eventually, and
 * refusing a folder on the strength of one would lock somebody out of a setup
 * that works perfectly well. So the caller states the consequence and lets the
 * person decide.
 *
 * ## What the consequence actually IS
 *
 * NOT "Claude cannot read it". That was true until the server learned to read
 * the export folder from disk, and it was the whole bug — a local folder gave a
 * green, working export that Claude had no path to. Repeating that warning now
 * would be a warning about something that no longer happens.
 *
 * What remains true is narrower and worth saying plainly: a folder outside a
 * synced one is visible to THIS COMPUTER ONLY. A colleague cannot see it, and
 * neither can Claude on the web.
 *
 * @param {string} folder
 * @returns {boolean} True when the path sits inside something that looks synced.
 */
export function looksDriveSynced(folder) {
  if (typeof folder !== 'string' || folder.trim() === '') return false;

  const path = folder.replace(/\//g, '\\').toLowerCase();

  // A Drive letter root: "G:\Shared drives\..." or "G:\My Drive\...".
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter.toLowerCase()}:\\`;
    if (!path.startsWith(root)) continue;
    const rest = path.slice(root.length);
    if (rest.startsWith('shared drives') || rest.startsWith('my drive')) return true;
  }

  // Or a synced folder under the profile, which is how Drive, OneDrive and
  // Dropbox all present themselves when they are not given a drive letter.
  return /\\(google drive|onedrive[^\\]*|dropbox)\\/.test(`${path}\\`);
}

/** Single-quote for PowerShell, where the escape for a quote is doubling it. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Merge export settings into the .env file, preserving everything else in it.
 *
 * Line-based rather than parsed and re-serialised: a .env may carry comments
 * and hand-edited values, and rewriting the whole file would quietly lose them.
 *
 * @param {string} packageRoot
 * @param {Record<string, string>} settings
 * @returns {string} the path written
 */
export function writeEnvSettings(packageRoot, settings) {
  const path = join(packageRoot, '.env');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  // `''.split()` yields `['']`, which would put a blank first line in a brand-new
  // file. Cosmetic, but this file gets opened by the people we are writing it for.
  const lines = existing === '' ? [] : existing.split(/\r?\n/);

  for (const [key, value] of Object.entries(settings)) {
    const line = `${key}=${value}`;
    const at = lines.findIndex((candidate) => candidate.trimStart().startsWith(`${key}=`));
    if (at === -1) lines.push(line);
    else lines[at] = line;
  }

  // One trailing newline, however many the file had.
  const text = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  writeFileSync(path, text, 'utf8');
  return path;
}

/**
 * How the scheduled task should start the export WITHOUT flashing a window.
 *
 * A task that runs "only when the user is logged on" runs its action in the
 * user's session, and a `.bat` is a console program — so Windows creates a
 * console window for it. Once a minute, all day, that is intolerable.
 *
 * `-WindowStyle Hidden` does not fix it: the window is created and then hidden,
 * which still flashes. Windows Script Host can start a process with its window
 * hidden from the outset, which is the only approach that produces no flash at
 * all. See Run-Export-Hidden.vbs for why the other obvious fix — running the
 * task whether or not the user is logged on — was rejected.
 *
 * WSH is deprecated on current Windows and will not be present forever. So its
 * absence is CHECKED rather than assumed, and the fallback is the visible .bat:
 * a window every minute is annoying, an export that silently never runs is not
 * something anybody would notice.
 *
 * @returns {{command: string, arguments: string, hidden: boolean}}
 */
function launcherFor(batPath) {
  const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
  const vbs = join(dirname(batPath), 'Run-Export-Hidden.vbs');

  if (existsSync(wscript) && existsSync(vbs)) {
    const stable = writeStableLauncher(vbs);
    // `//B` is batch mode: no dialog of any kind. Without it a missing script is
    // a modal "Can not find script file" box, every run, on somebody's screen.
    if (stable !== null) return { command: wscript, arguments: `//B //Nologo "${stable}"`, hidden: true };
    return { command: wscript, arguments: `//B //Nologo "${vbs}"`, hidden: true };
  }

  return { command: batPath, arguments: '--quiet', hidden: false };
}

/**
 * Where the task's own starter lives: OUTSIDE the install folder, on purpose.
 *
 * People delete or move the folder without running Uninstall. The task then
 * pointed at a file that no longer existed, and Windows Script Host put up
 * "Can not find script file" on every run (seen on a client laptop,
 * 2026-10-09). Nothing inside a deleted folder can clean up after it, so the
 * task runs this small file instead: it starts the export while the folder is
 * there, and removes the task — and itself — once the folder has gone.
 */
export function stableLauncherPath(env = process.env) {
  const base = env.LOCALAPPDATA;
  return base ? join(base, 'TallyPrime for Claude', 'Run-Export-Task.vbs') : null;
}

/**
 * Write the starter for this install. Returns its path, or null when there is
 * nowhere to put it — the task then runs the install's own file as before.
 */
function writeStableLauncher(vbsPath) {
  const path = stableLauncherPath();
  if (path === null) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // UTF-16 with a BOM, which Windows Script Host reads natively, so an install
    // path with non-English characters in it survives.
    writeFileSync(
      path,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(stableLauncherScript(vbsPath), 'utf16le')])
    );
    return path;
  } catch {
    return null;
  }
}

/**
 * How many runs in a row must find the folder gone before the task is removed.
 *
 * More than one, because "gone" can be momentary: OneDrive re-syncing the
 * folder, a profile still loading after sign-in. A real deletion is still
 * cleaned up within the hour.
 */
export const MISSING_RUNS_BEFORE_REMOVAL = 3;

/** The starter's VBScript. Exported for the test. */
export function stableLauncherScript(vbsPath) {
  const quoted = (text) => `"${String(text).replace(/"/g, '""')}"`;
  return [
    "' TallyPrime for Claude - scheduled task starter. Written by Setup.",
    "' Runs the export while its folder exists; once the folder has been deleted",
    "' or moved, removes the scheduled task and this file. See exportSetup.mjs.",
    'Option Explicit',
    'Dim shell, fso, target, marker, drive, misses, stream',
    'Set shell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `target = ${quoted(vbsPath)}`,
    'marker = WScript.ScriptFullName & ".missing"',
    '',
    'If fso.FileExists(target) Then',
    '  If fso.FileExists(marker) Then fso.DeleteFile marker, True',
    '  WScript.Quit shell.Run("wscript.exe //B //Nologo """ & target & """", 0, True)',
    'End If',
    '',
    "' A drive that is not there right now (unplugged, not yet mapped) proves",
    "' nothing about the folder, so it is never counted as a deletion.",
    'drive = fso.GetDriveName(target)',
    'If drive = "" Then WScript.Quit 1',
    'If Not fso.DriveExists(drive) Then WScript.Quit 1',
    'If Not fso.GetDrive(drive).IsReady Then WScript.Quit 1',
    '',
    'misses = 0',
    'On Error Resume Next',
    'If fso.FileExists(marker) Then misses = CInt(fso.OpenTextFile(marker).ReadLine)',
    'On Error GoTo 0',
    'misses = misses + 1',
    `If misses < ${String(MISSING_RUNS_BEFORE_REMOVAL)} Then`,
    '  Set stream = fso.CreateTextFile(marker, True)',
    '  stream.WriteLine CStr(misses)',
    '  stream.Close',
    '  WScript.Quit 1',
    'End If',
    '',
    `shell.Run "schtasks.exe /Delete /TN ${quoted(TASK_NAME).replace(/"/g, '""')} /F", 0, True`,
    'On Error Resume Next',
    'fso.DeleteFile marker, True',
    'fso.DeleteFile WScript.ScriptFullName, True',
    'WScript.Quit 0',
    '',
  ].join('\r\n');
}

/**
 * How often the scheduled task wakes, in minutes.
 *
 * Fifteen, down from five on 2026-10-07 after people reported their laptops
 * lagging. Each wake starts wscript, cmd and two Node processes — about 1.5s of
 * CPU, and antivirus software inspects every one of those launches — and asks
 * TallyPrime for every voucher's ID. Twelve of those an hour, all day, was a
 * cost paid for a spreadsheet nobody reads within five minutes of an edit.
 *
 * Existing installs move to this on their next run: see ensureTaskInterval.
 */
export const EXPORT_INTERVAL_MINUTES = 15;

/**
 * Register (or re-register) the scheduled task.
 *
 * Returns `{ok, detail}` rather than throwing: a machine where a policy forbids
 * creating tasks must still finish setup with a working connector, and be told
 * plainly that the automatic export is the part that did not happen.
 *
 * `hidden` in the result says whether it will run without a visible window, so
 * Setup can tell the user which they are getting rather than promising silence
 * it may not be able to deliver.
 *
 * @param {{batPath: string, everyMinutes: number}} options
 */
export function registerTask({ batPath, everyMinutes, now = new Date() }) {
  const xmlPath = join(tmpdir(), `tally-export-task-${String(now.getTime())}.xml`);
  const launcher = launcherFor(batPath);

  try {
    // UTF-16 with a BOM. `schtasks /Create /XML` rejects UTF-8 on some builds
    // with an unhelpful "The task XML is malformed", and the declaration below
    // has to match the actual encoding or it fails the same way.
    // The byte-order mark written as BYTES rather than as a character. Verified
    // 2026-08-19: a UTF-8 file, with or without its own BOM, is refused with
    // "The task XML is malformed. (1,40)::ERROR: unable to switch the encoding",
    // so this is required rather than defensive. Bytes, because a literal U+FEFF
    // in source is invisible to whoever reads this next.
    writeFileSync(
      xmlPath,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(taskXml({ launcher, everyMinutes, now }), 'utf16le'),
      ])
    );

    execFileSync(
      'schtasks.exe',
      [
        '/Create',
        '/TN',
        TASK_NAME,
        '/XML',
        xmlPath,
        // Update rather than fail when Setup is run a second time.
        '/F',
      ],
      { stdio: 'pipe' }
    );
    return { ok: true, detail: null, hidden: launcher.hidden };
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    return { ok: false, detail, hidden: false };
  } finally {
    try {
      rmSync(xmlPath, { force: true });
    } catch {
      // A temp file left behind is not worth reporting.
    }
  }
}

/**
 * The task definition, written out in full rather than left to `schtasks`.
 *
 * ## Why not the one-line `/SC MINUTE /MO 1` form
 *
 * Because of what it defaults to. Inspected on a real registration, `schtasks`
 * wrote `DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` as **true** —
 * so on a laptop the export stops the moment somebody unplugs it, and resumes
 * whenever they happen to plug it back in. Nothing announces that. The workbook
 * simply stops advancing, and the only thing that would ever say so is the
 * doctor's age check, days later. An accountant working from a laptop is the
 * normal case, not the exception, so this is the single most important setting
 * on the task.
 *
 * The other three are smaller but real:
 *
 * - **`StartWhenAvailable`** — run a start that was missed, rather than waiting
 *   for the next one. This is what makes the schedule pick itself up after the
 *   machine has been asleep or switched off.
 * - **`ExecutionTimeLimit`** — one hour. `MultipleInstancesPolicy` is
 *   `IgnoreNew`, which is the overlap guard we want, but it has a sharp edge: a
 *   single hung run would block EVERY later run until it ended, and the default
 *   limit is 72 hours. An hour is far longer than the slowest measured export
 *   (27s) and far shorter than a working day.
 * - **`Repetition` with no `Duration`** — repeat indefinitely. This one
 *   `schtasks` already got right, and it is written explicitly so a future edit
 *   cannot quietly bound it.
 */
function taskXml({ launcher, everyMinutes, now }) {
  // Local time with no timezone, which is what Task Scheduler expects. Seconds
  // are zeroed so the trigger sits on a minute boundary.
  const startBoundary =
    `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:00`;

  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    // Fixed text with nothing needing escaping, so it is a plain string. What
    // somebody sees if they open Task Scheduler and wonder what this is.
    '    <Description>Exports TallyPrime data to an Excel workbook. Wakes on a schedule, asks ' +
      'TallyPrime whether anything changed, and only writes a file when it has (plus once a day ' +
      'regardless).</Description>',
    '  </RegistrationInfo>',
    '  <Principals>',
    '    <Principal id="Author">',
    // InteractiveToken: runs only while the user is logged on. Required — the
    // toast needs a desktop, and a run under a service account cannot see the
    // user's mapped Google Drive folder.
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    // The two that matter most on a laptop.
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    // Never gate on the machine being idle: this has to run while somebody is
    // working in TallyPrime, which is the opposite of idle.
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Triggers>',
    '    <TimeTrigger>',
    `      <StartBoundary>${startBoundary}</StartBoundary>`,
    '      <Repetition>',
    `        <Interval>PT${String(everyMinutes)}M</Interval>`,
    // No <Duration>, which means forever. A duration here would silently end
    // the schedule after that long.
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(launcher.command)}</Command>`,
    // --quiet either way: there is no console to print to when the scheduler
    // runs this. The news goes to the folder and to a toast instead. When the
    // hidden launcher is in use it supplies that flag itself.
    `      <Arguments>${escapeXml(launcher.arguments)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ].join('\r\n');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Remove the task. Used when someone turns the scheduled export off. */
export function removeTask() {
  try {
    execFileSync('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'pipe' });
    return { ok: true, detail: null };
  } catch (error) {
    return { ok: false, detail: String(error?.stderr ?? error?.message ?? error).trim() };
  }
}

/**
 * Move an install registered at a shorter interval onto EXPORT_INTERVAL_MINUTES.
 *
 * Updates replace the code, never the task, so without this every install
 * already out there would keep waking every five minutes forever. Only a task
 * that EXISTS is touched — somebody who declined the schedule does not get one
 * — and only one waking more often than the current interval.
 *
 * Returns whether it re-registered. Never throws: this runs at the end of an
 * export, and a schedule it could not change is the schedule that was working.
 */
export function ensureTaskInterval({ batPath, installRoot }) {
  try {
    const xml = execFileSync('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/XML'], {
      stdio: 'pipe',
    }).toString('utf8');
    const plan = taskUpgradePlan(xml, installRoot, readStableLauncher());
    if (plan === null) return false;

    const result = registerTask({ batPath, everyMinutes: plan.everyMinutes });
    if (!result.ok) return false;
    writeEnvSettings(installRoot, {
      TALLY_EXPORT_INTERVAL_MINUTES: String(EXPORT_INTERVAL_MINUTES),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a registered task needs re-registering, and at what interval. Pure,
 * for the test.
 *
 * Two reasons: it wakes more often than EXPORT_INTERVAL_MINUTES, or it does not
 * yet run the stable starter, which is what lets a deleted folder clean up its
 * own task. Only a task belonging to THIS install is touched: another copy's
 * task is that copy's business. A longer interval somebody chose is kept.
 *
 * @returns {{everyMinutes: number} | null}
 */
export function taskUpgradePlan(xml, installRoot, launcherText) {
  if (!taskBelongsTo(xml, installRoot, launcherText)) return null;
  const { command, usesStable } = taskAction(xml);

  const interval = /<Interval>PT(?:(\d+)H)?(?:(\d+)M)?<\/Interval>/.exec(xml);
  const current = interval === null ? null : Number(interval[1] ?? 0) * 60 + Number(interval[2] ?? 0);
  const everyMinutes = Math.max(current ?? EXPORT_INTERVAL_MINUTES, EXPORT_INTERVAL_MINUTES);

  // The fallback .bat launcher has no starter to move to; only the interval applies.
  const canUseStable = command.toLowerCase().endsWith('wscript.exe');
  if (everyMinutes === current && (usesStable || !canUseStable)) return null;
  return { everyMinutes };
}

/**
 * Does the registered task run THIS install? Directly, or through the stable
 * starter, in which case the starter's own text names the install it starts.
 * Shared with Uninstall, which must not remove another copy's task.
 */
export function taskBelongsTo(xml, installRoot, launcherText = readStableLauncher()) {
  const { command, args, usesStable } = taskAction(xml);
  const root = withSep(installRoot).toLowerCase();
  return usesStable
    ? (launcherText ?? '').toLowerCase().includes(root)
    : `${command} ${args}`.toLowerCase().includes(root);
}

function taskAction(xml) {
  const args = decodeXml(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1] ?? '');
  const command = decodeXml(/<Command>([^<]*)<\/Command>/.exec(xml)?.[1] ?? '');
  const stable = stableLauncherPath();
  const usesStable = stable !== null && args.toLowerCase().includes(stable.toLowerCase());
  return { command, args, usesStable };
}

/** A folder path ending in its separator, so "Tally" never matches "Tally (old)". */
function withSep(path) {
  return /[\\/]$/.test(path) ? path : `${path}\\`;
}

function readStableLauncher() {
  const path = stableLauncherPath();
  try {
    return path === null ? null : readFileSync(path).toString('utf16le');
  } catch {
    return null;
  }
}

function decodeXml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Is the task registered? Used by the doctor, which must never change anything. */
export function taskExists() {
  try {
    execFileSync('schtasks.exe', ['/Query', '/TN', TASK_NAME], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
