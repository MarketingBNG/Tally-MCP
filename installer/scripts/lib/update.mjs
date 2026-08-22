import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Updating an install without making anybody reinstall it.
 *
 * ## The problem this solves
 *
 * Every copy of this thing is a folder somebody unzipped once. Before this
 * existed, a new version meant sending a 42MB zip and talking a non-technical
 * person through replacing a folder, so installs drifted: the maintainer's own
 * Claude Desktop copy sat two versions behind for weeks without anybody
 * noticing. A tool an accountant relies on cannot depend on that going well.
 *
 * ## Why it stages rather than installs
 *
 * Claude Desktop launches the server and HOLDS IT OPEN for the whole session,
 * and Windows will not let you overwrite a running executable. So an in-place
 * update cannot be done while Desktop is up, which is most of the working day.
 *
 * Instead: download beside the running copy, verify it, and leave it for the
 * next Desktop start to pick up (see launch.mjs). That buys two things beyond
 * dodging the file lock.
 *
 *   - **THE ACTIVE INSTALL IS NEVER TOUCHED.** Everything here writes to
 *     `app.next` and nothing else. A download that fails, a corrupt zip, a
 *     half-extracted archive, a machine that loses power mid-update — none of
 *     them can damage the copy that currently works. The worst outcome of a
 *     failed update is that no update happens, which is the correct worst
 *     outcome.
 *   - **The version changes at a boundary somebody can see.** An auditor citing
 *     a figure needs to know which version produced it. Swapping underneath a
 *     running session would make that unanswerable; swapping at a restart is a
 *     moment the user chose.
 *
 * ## Fail closed, always
 *
 * Every check here refuses rather than guesses: an unparseable version, a
 * missing checksum, a digest that does not match, an archive whose contents are
 * not the shape expected. Unverified code is never unpacked into place. The cost
 * of refusing is a stale install that still works and says so; the cost of
 * guessing is arbitrary code running against somebody's books.
 */

/** Where releases come from. Public repo, so no token and no auth to expire. */
export const RELEASES_API = 'https://api.github.com/repos/MarketingBNG/Tally-MCP/releases/latest';

/** The checksum file a release must carry before anything from it is unpacked. */
export const CHECKSUM_ASSET = 'SHA256SUMS.txt';

/**
 * Parse `x.y.z` into comparable numbers, or null if it is not that shape.
 *
 * Deliberately strict. A version this cannot read is treated as "no update
 * available" rather than compared loosely — a wrong comparison either installs
 * a downgrade or silently never updates, and both are worse than doing nothing.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** -1 if a is older, 0 if equal, 1 if a is newer. Null if either is unreadable. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;

  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return 0;
}

/**
 * Should this install fetch anything?
 *
 * Pure, so the awkward cases are settled by a test rather than discovered on
 * somebody's machine. The reason is returned alongside because it goes in the
 * run log, and "already staged" is a different fact from "already current".
 */
export function chooseUpdate({ installed, latest, staged = null, refuse = null }) {
  if (parseVersion(installed) === null) {
    return { act: false, reason: 'installed-version-unreadable' };
  }
  if (parseVersion(latest) === null) {
    return { act: false, reason: 'published-version-unreadable' };
  }

  // Not newer than what is running. Covers equal AND older: a release that has
  // been pulled must never walk an install backwards.
  if (compareVersions(latest, installed) <= 0) {
    return { act: false, reason: 'already-current' };
  }

  // Already downloaded and waiting. Re-fetching 42MB every hour until somebody
  // restarts Desktop would be the kind of background traffic that gets a tool
  // uninstalled.
  if (staged !== null && compareVersions(latest, staged) <= 0) {
    return { act: false, reason: 'already-staged' };
  }

  // This exact version was promoted once, failed to start, and was rolled back
  // by launch.mjs. Downloading it again would re-break the install at every
  // restart, so it is refused until a LATER version supersedes it.
  if (refuse !== null && compareVersions(latest, refuse) === 0) {
    return { act: false, reason: 'refused-after-rollback' };
  }

  return { act: true, reason: 'newer-available', version: latest.trim().replace(/^v/, '') };
}

/**
 * Pull the version and the two asset URLs out of a GitHub release payload.
 *
 * Returns null rather than throwing on anything unexpected: this runs inside an
 * hourly background task, and a GitHub response shape nobody anticipated must
 * degrade to "no update today", never to a failed export.
 */
export function parseRelease(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  if (payload.draft === true || payload.prerelease === true) return null;

  const version = parseVersion(payload.tag_name);
  if (version === null) return null;

  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const zip = assets.find((a) => typeof a?.name === 'string' && /^TallyPrime-for-Claude-.*\.zip$/.test(a.name));
  const sums = assets.find((a) => a?.name === CHECKSUM_ASSET);

  // No checksum, no update. The whole verification story rests on this file, so
  // a release published without one is treated as not published at all rather
  // than trusted because it came over HTTPS.
  if (zip === undefined || sums === undefined) return null;
  if (typeof zip.browser_download_url !== 'string' || typeof sums.browser_download_url !== 'string') return null;

  return {
    version: String(payload.tag_name).replace(/^v/, ''),
    zipName: zip.name,
    zipUrl: zip.browser_download_url,
    checksumUrl: sums.browser_download_url,
  };
}

/**
 * Find one file's expected digest in a `sha256sum`-style listing.
 *
 * Accepts the two spacings the common tools emit (`hash  name` and `hash *name`)
 * and matches on the base name, because the file may have been generated with a
 * path prefix that will not match how it is being downloaded.
 */
export function digestFor(sumsText, fileName) {
  if (typeof sumsText !== 'string') return null;

  for (const raw of sumsText.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(raw.trim());
    if (match === null) continue;
    const name = match[2].split(/[\\/]/).pop();
    if (name === fileName) return match[1].toLowerCase();
  }
  return null;
}

/**
 * The two folder names this module needs. `app.previous` is deliberately absent:
 * rollback is launch.mjs's job and it owns that name, so declaring it here as
 * well would invite the two to drift apart.
 */
export const APP = 'app';
export const NEXT = 'app.next';

/**
 * A plain file saying an update is waiting, written where somebody will see it.
 *
 * The toast is ephemeral and easy to miss — Focus assist and Do Not Disturb
 * suppress banners outright, and the code that raises one deliberately swallows
 * its own failures, so nothing reports a notification that never arrived. The
 * exporter already learned this and leaves a `LAST RUN FAILED ...` file beside
 * the spreadsheets; this is the same idea for updates.
 *
 * It sits in the install folder, which is the folder people already open to run
 * Setup or Check-Tally, and it is removed once the update has been applied.
 */
export function updateMarkerPath(packageRoot, version) {
  return join(packageRoot, `UPDATE READY - version ${version}.txt`);
}

/** Remove any update marker, whatever version it names. */
export function clearUpdateMarkers(packageRoot) {
  try {
    for (const name of readdirSync(packageRoot)) {
      if (/^UPDATE READY - version .*\.txt$/.test(name)) {
        rmSync(join(packageRoot, name), { force: true });
      }
    }
  } catch {
    // Best effort: a stale marker is untidy, never harmful.
  }
}

/** Where the staged-version marker lives, beside the folders it describes. */
export function statePath(packageRoot) {
  return join(packageRoot, 'update-state.json');
}

/** Read the marker, tolerating absence and corruption alike. */
export function readUpdateState(packageRoot) {
  const path = statePath(packageRoot);
  const empty = { staged: null, refuse: null, stagedAt: null, lastCheckedAt: null, lastFailure: null };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      staged: typeof parsed.staged === 'string' ? parsed.staged : null,
      refuse: typeof parsed.refuse === 'string' ? parsed.refuse : null,
      stagedAt: typeof parsed.stagedAt === 'string' ? parsed.stagedAt : null,
      lastCheckedAt: typeof parsed.lastCheckedAt === 'string' ? parsed.lastCheckedAt : null,
      lastFailure: typeof parsed.lastFailure === 'string' ? parsed.lastFailure : null,
    };
  } catch {
    // A truncated write from a power cut. Forgetting is correct: the folders on
    // disk are the truth, and the next check simply re-stages.
    return empty;
  }
}

export function writeUpdateState(packageRoot, state) {
  writeFileSync(statePath(packageRoot), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/** The version an unpacked payload folder reports, or null if it is not one. */
export function versionOf(payloadDir) {
  const manifest = join(payloadDir, 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf-8'));
    return parseVersion(parsed.version) === null ? null : String(parsed.version);
  } catch {
    return null;
  }
}

/**
 * Is this folder a complete payload, or a half-extracted one?
 *
 * Checked before a staged folder is ever promoted. An archive that stopped
 * halfway leaves something that looks like an install and is not one, and the
 * failure would land at Desktop start — the least diagnosable moment there is.
 */
export function payloadIsComplete(payloadDir) {
  if (versionOf(payloadDir) === null) return false;
  return [
    join(payloadDir, 'dist', 'index.js'),
    join(payloadDir, 'node_modules'),
    join(payloadDir, 'scripts', 'export.mjs'),
  ].every((path) => existsSync(path));
}

/**
 * Extract a zip using what Windows already has.
 *
 * Windows 10 1803 and later ship bsdtar as `System32\tar.exe`, which reads zips
 * and is far quicker than the PowerShell route on a 40MB archive. It is invoked
 * by ABSOLUTE PATH on purpose: a machine with Git installed has GNU tar earlier
 * on PATH, and GNU tar cannot read a zip at all — it treats `C:\...` as a remote
 * host and fails with "Cannot connect to C". Resolving through PATH would make
 * this work or not depending on what else somebody had installed.
 *
 * Expand-Archive is the fallback for anything older. Neither adds a dependency,
 * which matters: this runs from a bundled Node with production dependencies
 * only, on a machine where npm may not exist at all.
 */
function extractZip(zipPath, intoDir) {
  mkdirSync(intoDir, { recursive: true });

  const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (existsSync(bsdtar)) {
    execFileSync(bsdtar, ['-xf', zipPath, '-C', intoDir], { stdio: 'pipe' });
    return;
  }

  const quote = (value) => value.replace(/'/g, "''");
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${quote(zipPath)}' -DestinationPath '${quote(intoDir)}' -Force`,
    ],
    { stdio: 'pipe' }
  );
}

/**
 * The payload inside an extracted archive.
 *
 * Three places are tried, because the archive's shape is not the payload's shape:
 *
 *   TallyPrime-for-Claude-x.y.z.zip
 *     TallyPrime for Claude/        <- wrapper, so unzipping by hand is tidy
 *       node/, launch.mjs, *.bat    <- the stable root, NOT the payload
 *       app/                        <- THE PAYLOAD: what app.next must become
 *
 * The wrapper exists so that unzipping into a Downloads folder does not spray
 * files everywhere, and `app/` exists so an update is a folder rename. Together
 * they put what is being staged two levels down, which is why this searches
 * rather than assuming — the layout has already moved once, and a hardcoded hop
 * would have failed silently again.
 *
 * Found rather than assumed also means renaming the release folder cannot break
 * every install at once.
 */
function payloadWithin(extractedDir) {
  const candidates = [extractedDir];

  for (const entry of readdirSync(extractedDir)) {
    const child = join(extractedDir, entry);
    if (!statSync(child).isDirectory()) continue;
    // The wrapper itself, then the payload folder inside it.
    candidates.push(child, join(child, APP));
  }

  return candidates.find((path) => existsSync(path) && payloadIsComplete(path)) ?? null;
}

/**
 * Download, verify and stage a new version. Never touches the running copy.
 *
 * Returns `{ staged: version }` on success, or `{ error: reason }` — this is
 * called from the hourly export task, where an exception would turn "no update
 * today" into "the export failed".
 */
export async function stageUpdate({ packageRoot, release, fetchImpl = fetch }) {
  const scratch = mkdtempSync(join(tmpdir(), 'tally-update-'));

  try {
    const sumsResponse = await fetchImpl(release.checksumUrl, { redirect: 'follow' });
    if (!sumsResponse.ok) return { error: `checksum download failed (HTTP ${String(sumsResponse.status)})` };
    const expected = digestFor(await sumsResponse.text(), release.zipName);
    if (expected === null) return { error: `${CHECKSUM_ASSET} does not list ${release.zipName}` };

    const zipResponse = await fetchImpl(release.zipUrl, { redirect: 'follow' });
    if (!zipResponse.ok) return { error: `download failed (HTTP ${String(zipResponse.status)})` };
    const bytes = Buffer.from(await zipResponse.arrayBuffer());

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
      // Not a retryable condition. Either the release was rebuilt without the
      // checksum being refreshed, or something rewrote the bytes in transit.
      return { error: 'the download did not match its published checksum, so it was discarded' };
    }

    const zipPath = join(scratch, release.zipName);
    writeFileSync(zipPath, bytes);

    const extracted = join(scratch, 'unpacked');
    extractZip(zipPath, extracted);

    const payload = payloadWithin(extracted);
    if (payload === null) return { error: 'the archive did not contain a complete install' };

    const staged = versionOf(payload);
    if (compareVersions(staged, release.version) !== 0) {
      return { error: `the archive reports version ${String(staged)} but the release says ${release.version}` };
    }

    // Only now does anything land beside the live install, and it lands by a
    // single rename of an already-verified folder — so `app.next` is either
    // absent or complete, and never briefly half-written.
    const target = join(packageRoot, NEXT);
    rmSync(target, { recursive: true, force: true });
    renameSync(payload, target);

    return { staged };
  } catch (error) {
    return { error: `update could not be staged: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The whole hourly check, in one call that cannot throw.
 *
 * Returns a small record for the run log. `acted` is true only when something
 * new is now waiting on disk, which is what decides whether the user is told.
 */
export async function checkForUpdate({
  packageRoot,
  installed,
  fetchImpl = fetch,
  now = new Date(),
  minIntervalMinutes = 0,
}) {
  const state = readUpdateState(packageRoot);

  /*
   * Two callers now ask this question: the hourly export task, and the server at
   * Desktop startup. Both are wanted — the startup one is the only thing that
   * reaches an install where the export was never scheduled — but without a
   * floor between them, opening Claude just after the task ran would download
   * the same 40MB twice.
   *
   * A timestamp is the whole mechanism. It is deliberately not a lock: the cost
   * of the rare double-check is one wasted download, and the cost of a stale
   * lock file is an install that stops updating forever.
   */
  if (minIntervalMinutes > 0 && state.lastCheckedAt !== null) {
    const since = (now.getTime() - Date.parse(state.lastCheckedAt)) / 60000;
    if (Number.isFinite(since) && since >= 0 && since < minIntervalMinutes) {
      return { acted: false, reason: 'checked recently' };
    }
  }

  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tally-mcp-updater' },
    });
    /*
     * Stamp the clock whenever GitHub actually ANSWERED, including when the
     * answer is useless — an HTTP error, or a release published without its
     * checksum file. Without this the interval never engages on those paths and
     * every startup re-asks, which is the one way this could become a nuisance
     * to somebody who has done nothing wrong.
     *
     * A network that could not be reached at all is deliberately NOT stamped:
     * that is a laptop on a train, and it should check again as soon as it can
     * rather than sitting out the next hour.
     */
    const stamp = () => writeUpdateState(packageRoot, { ...state, lastCheckedAt: now.toISOString() });

    if (!response.ok) {
      stamp();
      return { acted: false, reason: `release check failed (HTTP ${String(response.status)})` };
    }

    const release = parseRelease(await response.json());
    if (release === null) {
      stamp();
      return { acted: false, reason: 'no usable release published' };
    }

    const decision = chooseUpdate({
      installed,
      latest: release.version,
      staged: state.staged,
      refuse: state.refuse,
    });
    if (!decision.act) {
      // Stamped even when there is nothing to do — otherwise the interval above
      // never engages on a healthy install, which is the common case.
      stamp();
      return { acted: false, reason: decision.reason, latest: release.version };
    }

    const result = await stageUpdate({ packageRoot, release, fetchImpl });
    if (result.error !== undefined) {
      writeUpdateState(packageRoot, {
        ...state,
        lastCheckedAt: now.toISOString(),
        lastFailure: result.error,
      });
      return { acted: false, reason: result.error, latest: release.version };
    }

    writeUpdateState(packageRoot, {
      staged: result.staged,
      stagedAt: now.toISOString(),
      lastCheckedAt: now.toISOString(),
      lastFailure: null,
    });

    // The durable half of the news. See updateMarkerPath.
    try {
      clearUpdateMarkers(packageRoot);
      writeFileSync(
        updateMarkerPath(packageRoot, result.staged),
        [
          `Version ${result.staged} has been downloaded and is ready.`,
          '',
          'It will start being used the next time you FULLY QUIT Claude and open',
          'it again — right-click the Claude icon near the clock and choose Quit.',
          'Closing the window is not enough.',
          '',
          'Nothing needs to be installed by hand, and this file disappears once',
          'the new version is in use.',
          '',
        ].join('\r\n'),
        'utf-8'
      );
    } catch {
      // The toast and Check-Tally still carry it.
    }

    return { acted: true, reason: 'staged', staged: result.staged, latest: release.version };
  } catch (error) {
    // Offline, DNS failure, a firewall swallowing github.com. All ordinary, and
    // none of them is worth a word to the user.
    return { acted: false, reason: `could not reach the update service: ${error instanceof Error ? error.message : String(error)}` };
  }
}
