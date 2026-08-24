import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Remove Windows' "this came from the internet" mark from the install folder.
 *
 * THE BUG THIS FIXES
 *
 * A user downloads the zip in a browser, right-clicks, "Extract All". Explorer
 * copies the zip's mark of the web onto EVERY file it writes out — an alternate
 * data stream called `Zone.Identifier` holding `ZoneId=3`. From then on, every
 * time Windows launches one of those files it first shows:
 *
 *     Open File - Security Warning
 *     The publisher could not be verified. Are you sure you want to run
 *     this software?                                    [Run]  [Cancel]
 *
 * Fine once, at Setup. Intolerable afterwards, because the scheduled export
 * runs Run-Export-Hidden.vbs every minute: the launcher is hidden, but this
 * dialog is drawn by Windows itself and is not, so a marked install throws a
 * modal box on the user's desktop once a minute forever. (It is worst when
 * TallyPrime is closed — nobody clicks Run, so nothing consumes the queue and
 * the boxes stack up.)
 *
 * A code-signing certificate would also fix it and is the right answer
 * eventually. This does not need one: an unmarked file is not "unverified
 * software from the internet", it is a local file, and Windows launches it
 * without comment. It is exactly what right-click → Properties → Unblock, or
 * PowerShell's Unblock-File, does — applied to the whole folder, without
 * asking a non-technical user to do it file by file.
 *
 * WHY unlink OF A STREAM PATH
 *
 * `fs.unlinkSync('C:\\...\\Run-Export.bat:Zone.Identifier')` deletes the stream
 * and leaves the file alone: Windows resolves `file:stream` natively, so no
 * PowerShell child process is needed (and Unblock-File is unavailable anyway
 * when the machine's execution policy is locked down). A file with no such
 * stream — the normal case on a re-run — fails with ENOENT and is skipped.
 */

/**
 * Extensions Windows' attachment manager actually gates on launch. Data files
 * carry the mark too, but nobody executes a .json, so walking past them keeps
 * this to a few hundred syscalls instead of tens of thousands under
 * node_modules.
 */
const LAUNCHABLE = new Set([
  '.bat',
  '.cmd',
  '.com',
  '.exe',
  '.js',
  '.jse',
  '.lnk',
  '.mjs',
  '.msi',
  '.ps1',
  '.reg',
  '.scr',
  '.vbe',
  '.vbs',
  '.wsf',
]);

/**
 * Strip Zone.Identifier from every launchable file under `root`.
 *
 * Never throws. A folder that cannot be read, or a file whose stream cannot be
 * deleted because something holds it open, is skipped: the point is to remove
 * as many dialogs as possible, and a partial success is worth having. Setup
 * must not fail over cosmetics.
 *
 * @returns {{ cleared: number, failed: number }} counts, for the caller to report.
 */
export function unblockTree(root) {
  const result = { cleared: 0, failed: 0 };
  walk(root, result);
  return result;
}

/** Marker saying this install has already been swept. See unblockOnce. */
const DONE_MARKER = '.unblocked';

/**
 * The same sweep, but at most once per install, and cheap enough to sit on the
 * five-minute export path.
 *
 * ## WHY THE EXPORT DOES THIS AND NOT ONLY SETUP
 *
 * Setup clears the mark, and launch.mjs clears it after an update. Neither
 * reaches the installs that HAVE this problem today, and the reason is worth
 * writing down because it is easy to get wrong twice:
 *
 *   - Setup has already been run on those machines. Nobody is going to tell a
 *     hundred accountants to run it again.
 *   - launch.mjs at the folder root is the PREVIOUS version's copy during a
 *     promotion — the new one is only copied over afterwards, by syncBootFiles.
 *     So the repair added there does not run until the release AFTER the one
 *     that adds it. And syncBootFiles will not incidentally fix it either: it
 *     skips files whose contents are unchanged, which is exactly what
 *     Run-Export.bat and Run-Export-Hidden.vbs are.
 *
 * The exporter, by contrast, lives inside `app/` and is therefore the NEW code
 * the moment a version lands. It also runs every five minutes in the session
 * that is seeing the dialogs. So this is where the repair actually bites.
 *
 * The marker keeps it to one sweep ever: a few hundred syscalls once, not every
 * five minutes forever.
 *
 * @returns {{ cleared: number, failed: number, skipped: boolean }}
 */
export function unblockOnce(root) {
  const marker = join(root, DONE_MARKER);
  if (existsSync(marker)) return { cleared: 0, failed: 0, skipped: true };

  const result = unblockTree(root);

  try {
    writeFileSync(
      marker,
      [
        'Windows marks files that came from a downloaded zip, and then asks',
        'permission every time one of them runs. That mark has been removed from',
        'this folder. This file records that it was done, so it is not repeated.',
        '',
        'Deleting this file is harmless: it just means the check runs once more.',
        '',
      ].join('\r\n'),
      'utf8'
    );
  } catch {
    // An unwritable folder means this runs again next time. Wasteful, not wrong,
    // and never worth failing an export over.
  }

  return { ...result, skipped: false };
}

function walk(dir, result) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Symlinks are not followed: a junction into the export folder on a shared
    // drive is not ours to rewrite, and a loop would hang Setup.
    if (entry.isDirectory()) {
      walk(path, result);
    } else if (entry.isFile() && LAUNCHABLE.has(extname(entry.name).toLowerCase())) {
      clearMark(path, result);
    }
  }
}

function clearMark(path, result) {
  try {
    unlinkSync(`${path}:Zone.Identifier`);
    result.cleared += 1;
  } catch (error) {
    // ENOENT is the normal, boring case: the file was never marked, or a
    // previous run already cleared it. Anything else — a lock, a permission —
    // is counted so Setup can say the folder is not fully clean.
    if (error?.code !== 'ENOENT') result.failed += 1;
  }
}
