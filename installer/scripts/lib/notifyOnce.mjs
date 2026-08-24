import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toast } from './notify.mjs';

/**
 * The notification that is raised ONCE PER INSTALL and then never again.
 *
 * ## WHY THIS IS NOT THE CHANGE-OF-STATE RULE
 *
 * A failure DURING a company's export — the workbook open in Excel, a folder
 * gone — follows a change-of-state rule in export.mjs: first one notifies,
 * repeats go to the log, recovery notifies. That is right, because those are
 * faults and a fault that comes back is news each time.
 *
 * A failure BEFORE any company is reached is almost always "TallyPrime was not
 * open", and that is NOT a fault. Tally is closed every evening, every weekend,
 * and all day on the machines of people who open it only when they need it.
 * Under a change-of-state rule that produces a notification per working day,
 * forever, about the software behaving normally. Two things then go wrong, and
 * the second is the serious one:
 *
 *   1. It is an interruption nobody asked for, on a schedule nobody chose.
 *   2. It teaches the user that notifications from this tool are noise. The
 *      next one they swipe away unread is the export that has actually been
 *      failing for a fortnight.
 *
 * So this says it once — including, in the toast itself, that it will not be
 * repeated and what to do — and is then silent permanently. The record is NEVER
 * cleared on recovery. That is the decision, not an oversight: "we already told
 * them" outlives the condition.
 *
 * ## WHAT DOES NOT STOP
 *
 * The scheduled task. It keeps running every five minutes, and against a closed
 * Tally that costs a refused TCP connection — about a fifth of a second, no
 * window, no toast. That is what makes the silence safe: the workbook starts
 * refreshing again BY ITSELF the moment Tally is opened, with nobody having to
 * remember that they once dismissed a message. A run started by hand still
 * prints everything, because somebody is standing there watching it.
 */

/** The file recording what has already been said. One reason per line. */
export const TOLD_FILE_NAME = 'notifications-sent.txt';

/**
 * A header so somebody who opens the file can tell what it is, and that
 * deleting it is safe. Not a reason, so it never matches one.
 */
const HEADER = [
  '# Notifications this install has already raised, one per line.',
  '# They are not repeated. Delete this file to be told about them again.',
  '',
].join('\n');

/**
 * Raise `reason` as a toast unless it has been raised before.
 *
 * Never throws: a notification is never worth failing an export over, and the
 * durable record of a failed run is the `LAST RUN FAILED - ...` file and
 * run-log.txt, neither of which depends on this.
 *
 * @param {object} args
 * @param {string} args.installRoot  - where the record is kept; local, writable.
 * @param {string} [args.exportFolder] - checked for the pre-0.8.7 record only.
 * @param {string} args.reason - the plain-English cause, e.g. 'TallyPrime was not open'.
 * @param {(title: string, message: string) => unknown} [args.raise] - seam for tests.
 * @returns {boolean} true if a notification was raised now.
 */
export function notifyOnce({ installRoot, exportFolder, reason, raise = toast }) {
  try {
    if (alreadyTold({ installRoot, exportFolder, reason })) return false;

    // Recorded BEFORE the toast is attempted, not after. A toast that fails is
    // a nuisance; a record that fails to be written is this firing every five
    // minutes forever, which is the entire thing being avoided.
    record(installRoot, reason);

    raise(
      'TallyPrime export paused',
      `${reason}, so the spreadsheet was not refreshed. You will not be told again. ` +
        'It refreshes by itself once TallyPrime is open, or double-click Run-Export ' +
        'in the TallyPrime for Claude folder whenever you want it now.'
    );
    return true;
  } catch {
    return false;
  }
}

/** Has this exact reason been raised before, on this install? */
export function alreadyTold({ installRoot, exportFolder, reason }) {
  if (read(join(installRoot, TOLD_FILE_NAME)).split(/\r?\n/).includes(reason)) return true;

  /*
   * The pre-0.8.7 record: a single-line `last-failure.txt` in the export
   * folder. Still consulted, because an install that predates the move has
   * already had its one notification and must not be given another.
   *
   * Why it moved out of there: that folder is typically a Google Drive shared
   * drive. It can be offline — in which case the old code threw before raising
   * anything, so the user got no notification at all — and it is SHARED, so one
   * machine's record silenced a different machine's notification. The install
   * folder is local, always writable, and one per install.
   */
  if (!exportFolder) return false;
  return read(join(exportFolder, 'last-failure.txt')).trim() === reason;
}

function record(installRoot, reason) {
  const path = join(installRoot, TOLD_FILE_NAME);
  const existing = read(path) || HEADER;
  writeFileSync(path, `${existing.replace(/\r?\n+$/, '')}\n${reason}\n`, 'utf8');
}

/** Contents, or ''. A missing file is the ordinary case here, not an error. */
function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
