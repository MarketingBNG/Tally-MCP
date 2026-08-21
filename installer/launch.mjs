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

import { existsSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
 * Promote a staged payload, if there is one.
 *
 * Returns the version string promoted, or null. Every failure path leaves the
 * install exactly as it was: the renames are ordered so that `app` is only ever
 * absent for the instant between two of them, and the second is retried in the
 * only way that can help — by putting the first one back.
 */
function promote() {
  if (!existsSync(NEXT)) return null;

  // A staged folder with no app/ beside it should be impossible, but promoting
  // into a gap is the one case where a crash leaves nothing runnable at all.
  if (!existsSync(APP)) {
    renameSync(NEXT, APP);
    return 'restored';
  }

  try {
    rmSync(PREVIOUS, { recursive: true, force: true });
    renameSync(APP, PREVIOUS);
  } catch (error) {
    // Something still holds the current install — most likely an export that is
    // mid-run. Nothing has moved, so leaving it for the next start is safe.
    note(`update deferred, the current version is in use: ${String(error?.message ?? error)}`);
    return null;
  }

  try {
    renameSync(NEXT, APP);
  } catch (error) {
    // Put it back rather than leave the install headless.
    renameSync(PREVIOUS, APP);
    note(`update failed, kept the current version: ${String(error?.message ?? error)}`);
    return null;
  }

  return 'promoted';
}

/** Import a payload's server, or null if it cannot even be loaded. */
async function start(payloadDir) {
  const entry = join(payloadDir, 'dist', 'index.js');
  if (!existsSync(entry)) return { ok: false, error: `no server at ${entry}` };
  try {
    await import(pathToFileURL(entry).href);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.stack ?? error) };
  }
}

const promoted = promote();
if (promoted !== null) {
  patchState({ staged: null, stagedAt: null, promotedAt: new Date().toISOString() });
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
  patchState({ rolledBackAt: new Date().toISOString(), refuse: readVersion(broken) });
  rmSync(broken, { recursive: true, force: true });

  started = await start(APP);
}

if (!started.ok) {
  note(`could not start the server: ${started.error}`);
  process.exit(1);
}

/** A payload's version, for the refusal record. Best effort by design. */
function readVersion(payloadDir) {
  try {
    return String(JSON.parse(readFileSync(join(payloadDir, 'package.json'), 'utf-8')).version);
  } catch {
    return null;
  }
}
