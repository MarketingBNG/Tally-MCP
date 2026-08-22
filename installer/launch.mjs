/**
 * What Claude Desktop actually launches.
 *
 * ## Why there is an indirection at all
 *
 * Desktop's config names one command and one script, and that path has to keep
 * working across every future version. So the path it names is THIS file, which
 * never changes, and the version that answers questions lives in `app/` beside
 * it. Updating is then a folder rename rather than a config edit — which matters
 * because editing `claude_desktop_config.json` on somebody's machine is the part
 * of Setup most likely to go wrong, and doing it on every release would multiply
 * that risk by the number of releases.
 *
 * ## The rotation, and why it happens HERE
 *
 * `app.next` is a complete, checksum-verified payload that the hourly task
 * downloaded (see scripts/lib/update.mjs). It cannot be swapped in while Desktop
 * is running, because Desktop holds the current `app/` open. This file runs at
 * the one moment nothing is holding it: the instant Desktop starts the server,
 * before anything is imported.
 *
 * ## What happens when a new version is broken
 *
 * The previous payload is kept as `app.previous` rather than deleted, and if the
 * promoted version cannot even be imported, this file puts it back and starts
 * the old one instead. That is the difference between a bad release being an
 * inconvenience and being a client with no working tool and no way back — an
 * accountant cannot be asked to unzip a folder to recover from our mistake.
 *
 * A rollback is recorded in `update-state.json` so the next update check does
 * not immediately re-stage the version that just failed.
 */

import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP = join(ROOT, 'app');
const NEXT = join(ROOT, 'app.next');
const PREVIOUS = join(ROOT, 'app.previous');
const STATE = join(ROOT, 'update-state.json');

/**
 * Everything here writes to stderr, never stdout.
 *
 * stdout IS the MCP protocol channel. A single stray line on it corrupts the
 * transport and Desktop reports the server as broken, which would make an
 * update note the cause of the very failure it was describing.
 */
const note = (message) => process.stderr.write(`[launch] ${message}\n`);

function patchState(changes) {
  let state = {};
  try {
    if (existsSync(STATE)) state = JSON.parse(readFileSync(STATE, 'utf-8'));
  } catch {
    state = {};
  }
  try {
    writeFileSync(STATE, `${JSON.stringify({ ...state, ...changes }, null, 2)}\n`, 'utf-8');
  } catch {
    // A read-only folder or a locked file. The rotation already happened and is
    // what matters; losing the bookkeeping is survivable.
  }
}

/**
 * Does this folder hold everything a working payload needs?
 *
 * The same four things update.mjs checks, kept in step with it by hand. A
 * shorter list would let a broken folder through; a longer one would refuse a
 * good payload after a future reorganisation, which is the worse mistake — it
 * would strand every install on its current version with no way to say why.
 */
function isCompletePayload(dir) {
  return [
    join(dir, 'package.json'),
    join(dir, 'dist', 'index.js'),
    join(dir, 'node_modules'),
    join(dir, 'scripts', 'export.mjs'),
  ].every((path) => existsSync(path));
}

/**
 * Rename, retrying briefly through the locks Windows hands out at random.
 *
 * Observed while testing promotion: EPERM renaming a folder that had just been
 * written, with nothing actually using it. Antivirus and the search indexer both
 * open freshly created files for a moment, and a rename during that window fails
 * even though nothing is wrong. Measured to clear well inside a second.
 *
 * Without this, a promotion loses the race, gives up, and the update simply does
 * not happen — which looks exactly like an update that was never downloaded, and
 * would recur every restart on a machine with an eager scanner.
 *
 * Synchronous by necessity: this runs before the server starts, and the whole
 * point is that no other code touches these folders in between.
 */
function renameWithRetry(from, to, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES';
      if (!transient || attempt >= attempts) throw error;
      // 100ms, 200ms, 300ms, 400ms. Blocking, and deliberately so.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 100);
    }
  }
}

/**
 * Promote a staged payload, if there is one.
 *
 * Returns the version string promoted, or null. Every failure path leaves the
 * install exactly as it was: the renames are ordered so that `app` is only ever
 * absent for the instant between two of them, and the second is retried in the
 * only way that can help — by putting the first one back.
 */
function promote() {
  if (!existsSync(NEXT)) return null;

  /*
   * Verify before promoting, even though the updater already verified before
   * staging.
   *
   * The check there was of the DOWNLOAD; this is a check of what is on disk now.
   * Between the two sits a rename, a possible power cut, an antivirus quarantine
   * and anything else that can empty a folder. Promoting a half-payload swaps a
   * working install for one that cannot start, and it would do so at Desktop
   * launch — the least diagnosable moment there is. Deliberately duplicated
   * rather than inlined from the payload's own code, because the payload is the
   * thing being replaced and cannot be trusted to vet itself.
   */
  if (!isCompletePayload(NEXT)) {
    note('a staged update was incomplete and has been discarded');
    rmSync(NEXT, { recursive: true, force: true });
    patchState({ staged: null, stagedAt: null, lastFailure: 'the staged update was incomplete' });
    return null;
  }

  // A staged folder with no app/ beside it should be impossible, but promoting
  // into a gap is the one case where a crash leaves nothing runnable at all.
  if (!existsSync(APP)) {
    renameWithRetry(NEXT, APP);
    return 'restored';
  }

  try {
    rmSync(PREVIOUS, { recursive: true, force: true });
    renameWithRetry(APP, PREVIOUS);
  } catch (error) {
    // Something still holds the current install — most likely an export that is
    // mid-run. Nothing has moved, so leaving it for the next start is safe.
    note(`update deferred, the current version is in use: ${String(error?.message ?? error)}`);
    return null;
  }

  try {
    renameWithRetry(NEXT, APP);
  } catch (error) {
    // Put it back rather than leave the install headless.
    renameWithRetry(PREVIOUS, APP);
    note(`update failed, kept the current version: ${String(error?.message ?? error)}`);
    return null;
  }

  return 'promoted';
}

/**
 * Say what version is now in use, in a way that outlives a missed notification.
 *
 * A version change is not a detail here. Figures an accountant cited last week
 * came out of a particular version, so the moment it changes has to be visible
 * afterwards, not only in a banner that may have been suppressed. One file,
 * replaced each time rather than accumulated, beside Setup and Check-Tally.
 *
 * @param {string} name File name to write.
 * @param {string[]} lines Body, one line each.
 */
function writeNote(name, lines) {
  try {
    clearNotes();
    writeFileSync(join(ROOT, name), `${lines.join('\r\n')}\r\n`, 'utf-8');
  } catch {
    // A note is never worth failing a launch over.
  }
}

/** Remove every note this install writes, so only the newest is ever present. */
function clearNotes() {
  try {
    for (const entry of readdirSync(ROOT)) {
      if (/^(UPDATE READY|UPDATED|UPDATE FAILED) - .*\.txt$/.test(entry)) {
        rmSync(join(ROOT, entry), { force: true });
      }
    }
  } catch {
    // A stale note is untidy, never harmful.
  }
}

/** Raise a notification without blocking the launch. Best effort throughout. */
async function notify(title, message) {
  try {
    const { toastDetached } = await import(
      pathToFileURL(join(APP, 'scripts', 'lib', 'notify.mjs')).href
    );
    toastDetached(title, message);
  } catch {
    // The note on disk carries the same news and needs no Windows API.
  }
}

/**
 * Refresh the files that live OUTSIDE the payload, from copies inside it.
 *
 * Without this, `launch.mjs` and the .bat launchers are frozen at whatever
 * version was manually installed, because promotion only swaps `app/`. That
 * leaves the worst possible gap: a bug in THIS file — the one that performs
 * updates — would be the one thing an update could never fix, and every install
 * would need a human to reinstall it by hand.
 *
 * So each release carries canonical copies in `app/boot/`, and they are copied
 * out after a successful promotion. Byte-compared first, so the normal case
 * writes nothing at all.
 *
 * Replacing this very file while it runs is safe: Node has already read it, and
 * the new copy simply takes effect at the next start — which is exactly the
 * cadence everything else here works on. `node.exe`, `.env` and the update
 * bookkeeping are never touched, because only what the packager puts in `boot/`
 * is eligible.
 */
function syncBootFiles() {
  const bootDir = join(APP, 'boot');
  if (!existsSync(bootDir)) return;

  for (const name of readdirSync(bootDir)) {
    const from = join(bootDir, name);
    const to = join(ROOT, name);
    try {
      if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
      copyFileSync(from, to);
      note(`refreshed ${name}`);
    } catch (error) {
      // One file failing must not stop the others, and none of them is worth
      // failing the launch over — the server is about to start regardless.
      note(`could not refresh ${name}: ${String(error?.message ?? error)}`);
    }
  }
}

/**
 * Import a payload's server.
 *
 * `attempt` exists for the rollback path, and it is not decoration. Node caches
 * a module by its resolved URL — INCLUDING one that threw — so after a rollback
 * puts the previous version back at the same path, a plain re-import replays the
 * cached rejection rather than loading the file now on disk. The server would
 * stay down until somebody restarted Claude a second time, which is precisely
 * the manual step the rollback exists to avoid. A query suffix makes it a
 * different URL and therefore a fresh load.
 *
 * Measured: without the suffix the restored version failed to start every time.
 */
async function start(payloadDir, attempt = 0) {
  const entry = join(payloadDir, 'dist', 'index.js');
  if (!existsSync(entry)) return { ok: false, error: `no server at ${entry}` };
  try {
    const url = pathToFileURL(entry).href + (attempt > 0 ? `?reload=${String(attempt)}` : '');
    await import(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.stack ?? error) };
  }
}

/**
 * Look for a new version once per Desktop session, in the background.
 *
 * ## Why here, when the hourly export task already checks
 *
 * Because that task only exists if somebody set up the spreadsheet export. An
 * install that only uses the live connector never wakes on a schedule, so before
 * this it could never learn about a new version — the one case where a copy
 * stays stranded forever. Desktop starting the server is the one event every
 * install has in common.
 *
 * ## Three rules it must not break
 *
 * - NOTHING ON STDOUT. That is the MCP protocol channel; one stray byte and
 *   Desktop reports the server as broken.
 * - NOTHING BLOCKING. It is started after the server is already serving, and it
 *   is never awaited, so a slow or hanging network cannot delay a single answer.
 * - NOTHING FATAL. Every failure is swallowed. Being offline is the normal state
 *   of a laptop, not an error worth surfacing.
 *
 * The one-hour floor stops this and the hourly task both downloading the same
 * release when Claude happens to be opened just after a scheduled run.
 */
function checkForUpdatesInBackground() {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const { checkForUpdate } = await import(
          pathToFileURL(join(APP, 'scripts', 'lib', 'update.mjs')).href
        );
        const installed = readVersion(APP);
        if (installed === null) return;

        const result = await checkForUpdate({
          packageRoot: ROOT,
          installed,
          minIntervalMinutes: 60,
        });
        if (!result.acted) return;

        note(`version ${result.staged} is ready for the next restart`);

        /*
         * Tell the user, here as well as from the exporter.
         *
         * The exporter's notification only reaches installs that set up the
         * spreadsheet. Everyone else would have an update silently appear and
         * silently apply at some later restart, with nothing to explain why the
         * version number moved. Detached, because a blocking toast would stall
         * the server's event loop for as long as PowerShell takes.
         */
        const { toastDetached } = await import(
          pathToFileURL(join(APP, 'scripts', 'lib', 'notify.mjs')).href
        );
        toastDetached(
          'TallyPrime for Claude has an update ready',
          `Version ${result.staged} will be used the next time you fully quit and reopen Claude.`
        );
      } catch {
        // Offline, a firewall, a payload without the updater. All ordinary.
      }
    })();
  }, 5000);

  // Never hold the process open on this account. The server decides how long it
  // lives; a pending update check must not extend that by a single second.
  timer.unref?.();
}

const promoted = promote();
if (promoted !== null) {
  patchState({ staged: null, stagedAt: null, promotedAt: new Date().toISOString() });
  // After promotion, so the launchers on disk match the version now active.
  syncBootFiles();

  // Told, not just done. The "waiting" note is replaced by one naming the
  // version now in use — otherwise the only evidence a version changed is the
  // number in Check-Tally, which nobody thinks to compare against yesterday's.
  const now = readVersion(APP);
  writeNote(`UPDATED - now on version ${now ?? 'unknown'}.txt`, [
    `TallyPrime for Claude has updated itself to version ${now ?? 'unknown'}.`,
    '',
    'Nothing needs doing. This note is here so the change is not invisible:',
    'if you are checking a figure against one you took out earlier, it may have',
    'come from the previous version.',
    '',
    'What changed in each version is listed at:',
    '  https://github.com/MarketingBNG/Tally-MCP/blob/main/CHANGELOG.md',
    '',
    'This file is replaced by the next update and can be deleted at any time.',
  ]);
  void notify(
    'TallyPrime for Claude has updated',
    `Now running version ${now ?? 'a newer version'}. Nothing to do.`
  );
}

let started = await start(APP);

// The promoted version could not start. This is the case the whole rollback
// exists for, and it must be handled without a human present.
if (!started.ok && promoted === 'promoted' && existsSync(PREVIOUS)) {
  note(`the new version failed to start, rolling back: ${started.error}`);

  const broken = `${APP}.broken`;
  rmSync(broken, { recursive: true, force: true });
  renameSync(APP, broken);
  renameSync(PREVIOUS, APP);

  // Remember what failed, so the hourly check does not download it again on a
  // loop and re-break the install every restart.
  const failedVersion = readVersion(broken);
  patchState({ rolledBackAt: new Date().toISOString(), refuse: failedVersion });
  rmSync(broken, { recursive: true, force: true });

  // The MOST important of these to say out loud. Everything still works, but on
  // the older version, and somebody expecting a fix that shipped in the newer
  // one needs to know it is not there.
  const kept = readVersion(APP);
  writeNote(`UPDATE FAILED - staying on version ${kept ?? 'unknown'}.txt`, [
    `Version ${failedVersion ?? 'a new version'} would not start, so it was undone.`,
    '',
    `This copy is working normally on version ${kept ?? 'the previous version'}.`,
    'Nothing is broken and nothing needs doing.',
    '',
    'That version will not be tried again. The next release replaces it.',
    'If you were waiting on something that was supposed to arrive in it, tell',
    'whoever set this up for you and show them this file.',
  ]);
  void notify(
    'TallyPrime for Claude: update undone',
    `Version ${failedVersion ?? 'the new version'} would not start. Still working on ${kept ?? 'the previous version'}.`
  );

  started = await start(APP, 1);
}

if (!started.ok) {
  note(`could not start the server: ${started.error}`);
  process.exit(1);
}

// LAST, and only once the server is answering. See the notes above.
checkForUpdatesInBackground();

/** A payload's version, for the refusal record. Best effort by design. */
function readVersion(payloadDir) {
  try {
    return String(JSON.parse(readFileSync(join(payloadDir, 'package.json'), 'utf-8')).version);
  } catch {
    return null;
  }
}
