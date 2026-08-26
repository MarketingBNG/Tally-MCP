/**
 * Apply a staged update while Claude is closed, so nobody has to be told to
 * restart it.
 *
 * ## Why this exists beside launch.mjs, which already promotes
 *
 * A staged payload can only be swapped in when nothing is holding `app\` open,
 * and until now the only such moment was Claude Desktop starting the server —
 * see launch.mjs. That is fine for somebody who quits Claude most days, and no
 * use at all for somebody who leaves it running for weeks. Those installs sit on
 * a downloaded update indefinitely, which reads to the user as "the update never
 * arrived" and is indistinguishable from a broken updater.
 *
 * The scheduled export task already wakes this machine up regularly and runs
 * with the user's rights. Most of those runs happen while Claude is closed —
 * overnight, at lunch, after a reboot. That is a promotion window nobody has to
 * be asked for, and this file is what uses it.
 *
 * ## Why it is at the ROOT and imports nothing from app\
 *
 * Because it is renaming `app\`. Node holds an open handle on every module it
 * imports, and Windows will not rename a directory containing an open file — so
 * a promoter that lived under app\, or that imported one line from it, would
 * lock the very folder it is trying to move and fail every time.
 *
 * That is also why Run-Export.bat runs this BEFORE it starts export.mjs rather
 * than after: at that point the export has not opened anything under app\ yet.
 * The export then runs the version that was just promoted, which is the correct
 * order anyway.
 *
 * The cost is that the payload checks below are duplicated from launch.mjs
 * rather than shared. That duplication is deliberate and already the rule here:
 * the payload is the thing being replaced, so it cannot be trusted to vet
 * itself.
 *
 * ## Fail closed, and never fail the export
 *
 * Every uncertainty means "do not promote": Claude might be running, the staged
 * folder might be incomplete, a rename might lose a race with an antivirus
 * scanner. A skipped promotion costs one more export interval on the old
 * version, and launch.mjs will still do it at the next Claude start. A wrong one
 * costs an accountant a working tool.
 *
 * Nothing here throws to the caller and nothing is written to stdout beyond the
 * one line the export log records.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = 'app';
const NEXT = 'app.next';
const PREVIOUS = 'app.previous';

/**
 * Is Claude Desktop up?
 *
 * Asked of Windows rather than inferred from a lock, because "the rename failed"
 * and "Claude is open" are different facts and only the second one is worth
 * waiting for the next run to retry.
 *
 * Both executable names are matched: the ordinary installer ships `Claude.exe`,
 * and the packaged (MSIX) build has been seen running under the same name from a
 * different path, so the name is the reliable half. tasklist prints an "INFO: No
 * tasks..." line when nothing matches, which is why this looks for the name
 * rather than for any output at all.
 *
 * Returns true when it cannot tell. An unanswerable question must not become
 * permission to move somebody's install.
 */
export function claudeIsRunning(runTasklist = defaultTasklist) {
  try {
    const output = runTasklist();
    if (typeof output !== 'string') return true;
    return /claude(?:-desktop)?\.exe/i.test(output);
  } catch {
    // tasklist missing, blocked by policy, or timed out. Assume the worst.
    return true;
  }
}

function defaultTasklist() {
  return execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], {
    encoding: 'utf-8',
    timeout: 10000,
    windowsHide: true,
  });
}

/**
 * The same four things launch.mjs checks, plus a readable version.
 *
 * The version is required here and not there because this promoter runs with
 * nobody watching: launch.mjs promoting an unreadable payload at least happens
 * in front of somebody who just opened Claude and can be told. A 3am promotion
 * that leaves Check-Tally reporting "version unknown" is the kind of thing that
 * gets reported weeks later as "it broke on its own", so it is refused instead.
 * That is also what update.mjs's payloadIsComplete requires before staging.
 */
function isCompletePayload(dir) {
  if (versionOf(dir) === null) return false;
  return [
    join(dir, 'package.json'),
    join(dir, 'dist', 'index.js'),
    join(dir, 'node_modules'),
    join(dir, 'scripts', 'export.mjs'),
  ].every((path) => existsSync(path));
}

function versionOf(dir) {
  try {
    return String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).version);
  } catch {
    return null;
  }
}

/**
 * Rename through the transient locks Windows hands out at random.
 *
 * Same reasoning as launch.mjs: antivirus and the search indexer open freshly
 * written files for a moment, and a rename in that window fails with EPERM
 * though nothing is wrong. Fewer attempts than launch.mjs uses, because there
 * the user is waiting for a server to start and here the next attempt is simply
 * the next scheduled run.
 */
function renameWithRetry(from, to, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES';
      if (!transient || attempt >= attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 100);
    }
  }
}

function patchState(root, changes) {
  const path = join(root, 'update-state.json');
  let state = {};
  try {
    if (existsSync(path)) state = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    state = {};
  }
  try {
    writeFileSync(path, `${JSON.stringify({ ...state, ...changes }, null, 2)}\n`, 'utf-8');
  } catch {
    // The rotation is what matters; losing the bookkeeping is survivable.
  }
}

/**
 * Replace whatever note is in the folder with one naming the version now in use.
 *
 * The same file names launch.mjs writes and clears, so the two cannot leave a
 * stale "UPDATE READY" sitting beside an install that has already updated.
 */
function writeUpdatedNote(root, version) {
  try {
    for (const entry of readdirSync(root)) {
      if (/^(UPDATE READY|UPDATED|UPDATE FAILED) - .*\.txt$/.test(entry)) {
        rmSync(join(root, entry), { force: true });
      }
    }
    writeFileSync(
      join(root, `UPDATED - now on version ${version ?? 'unknown'}.txt`),
      [
        `TallyPrime for Claude has updated itself to version ${version ?? 'unknown'}.`,
        '',
        'Nothing needs doing. This note is here so the change is not invisible:',
        'if you are checking a figure against one you took out earlier, it may have',
        'come from the previous version.',
        '',
        'What changed in each version is listed at:',
        '  https://github.com/MarketingBNG/Tally-MCP/blob/main/CHANGELOG.md',
        '',
        'This file is replaced by the next update and can be deleted at any time.',
        '',
      ].join('\r\n'),
      'utf-8'
    );
  } catch {
    // A note is never worth failing a promotion over.
  }
}

/**
 * Promote `app.next` if, and only if, this is a safe moment to.
 *
 * Returns a small record for the export log. Never throws.
 *
 * @param {object} options
 * @param {string} options.root The install folder holding app\ and app.next\.
 * @param {() => boolean} [options.isClaudeRunning] Injected for testing.
 */
export function promoteIfIdle({ root, isClaudeRunning = () => claudeIsRunning() }) {
  const next = join(root, NEXT);
  const app = join(root, APP);
  const previous = join(root, PREVIOUS);

  if (!existsSync(next)) return { promoted: null, reason: 'nothing staged' };

  /*
   * Asked only once there is something to promote. tasklist costs a process
   * spawn, and on the overwhelming majority of runs there is no update waiting,
   * so paying for it every minute would be a real cost for no information.
   */
  if (isClaudeRunning()) return { promoted: null, reason: 'Claude is open' };

  if (!isCompletePayload(next)) {
    // Same verdict launch.mjs reaches, and for the same reason: promoting a
    // half-extracted folder swaps a working install for one that cannot start.
    rmSync(next, { recursive: true, force: true });
    patchState(root, { staged: null, stagedAt: null, lastFailure: 'the staged update was incomplete' });
    return { promoted: null, reason: 'the staged update was incomplete' };
  }

  // A staged folder with no app\ beside it should be impossible, but promoting
  // into a gap is the one case that leaves nothing runnable at all.
  if (!existsSync(app)) {
    try {
      renameWithRetry(next, app);
    } catch (error) {
      return { promoted: null, reason: `could not restore the install: ${message(error)}` };
    }
    const restored = versionOf(app);
    patchState(root, { staged: null, stagedAt: null, promotedAt: new Date().toISOString() });
    return { promoted: restored, reason: 'restored' };
  }

  try {
    rmSync(previous, { recursive: true, force: true });
    renameWithRetry(app, previous);
  } catch (error) {
    /*
     * Something still holds the current install. Claude was reported closed, so
     * this is most likely a Claude that started in the last few milliseconds, or
     * an export from the previous run that has not finished exiting.
     *
     * Nothing has moved. The next scheduled run tries again, and launch.mjs
     * still promotes at the next Claude start regardless, so no path is lost.
     */
    return { promoted: null, reason: `the current version is in use: ${message(error)}` };
  }

  try {
    renameWithRetry(next, app);
  } catch (error) {
    // Put it back rather than leave the install headless.
    try {
      renameWithRetry(previous, app);
    } catch {
      // Nothing further can be done from here without making it worse. app\ is
      // absent and app.previous\ holds the working copy; the branch above
      // restores from app.next\ on the next run, and launch.mjs has the same
      // recovery at the next Claude start.
    }
    return { promoted: null, reason: `the swap failed, kept the current version: ${message(error)}` };
  }

  const now = versionOf(app);
  patchState(root, { staged: null, stagedAt: null, promotedAt: new Date().toISOString() });
  writeUpdatedNote(root, now);

  /*
   * No toast.
   *
   * By definition Claude is closed and very likely nobody is at the machine — a
   * banner fired at 3am is gone by morning and tells nobody anything. The note
   * on disk is the durable half and is what Check-Tally reads. launch.mjs raises
   * the toast when it promotes, because there somebody has just opened Claude.
   */
  return { promoted: now, reason: 'promoted' };
}

function message(error) {
  return String(error?.message ?? error);
}

// Run as a script by Run-Export.bat, imported as a module by the tests.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = dirname(fileURLToPath(import.meta.url));
  let result;
  try {
    result = promoteIfIdle({ root });
  } catch (error) {
    // Belt-and-braces. promoteIfIdle is written not to throw, and an export must
    // not fail because a promotion did.
    result = { promoted: null, reason: `promotion could not run: ${message(error)}` };
  }
  if (result.promoted !== null) {
    process.stderr.write(`[promote] updated to version ${result.promoted} while Claude was closed\n`);
  }
  process.exit(0);
}
