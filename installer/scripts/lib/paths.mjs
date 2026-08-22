import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finding the folder that holds the server.
 *
 * These scripts run in two different layouts, and hardcoding a relative hop
 * cannot satisfy both:
 *
 *   Shipped folder                    Source checkout
 *   ------------------------------    ------------------------------
 *   TallyPrime for Claude/            tally-mcp/
 *     Setup.bat                         installer/
 *     scripts/setup.mjs                   Setup.bat
 *     scripts/lib/paths.mjs               scripts/setup.mjs
 *     dist/                               scripts/lib/paths.mjs
 *     package.json                      dist/
 *                                       package.json
 *
 * From scripts/lib/, the root is two levels up when shipped and three in the
 * checkout. So walk up instead of counting: the root is the nearest ancestor
 * holding package.json. That keeps the scripts runnable in place during
 * development, which matters — testing the doctor against the live Tally from
 * the checkout is what caught two wrong-diagnosis bugs before release.
 */

/**
 * @param {string} startDir Directory to search upward from.
 * @returns {string|null} The package root, or null if no ancestor qualifies.
 */
export function findPackageRoot(startDir) {
  let current = startDir;
  const { root } = parse(current);

  while (true) {
    if (existsSync(join(current, 'package.json'))) return current;
    if (current === root) return null;

    const parent = dirname(current);
    // Defensive: dirname() is idempotent at the top of some UNC paths, which
    // would otherwise spin here forever.
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Is this folder somewhere Windows will delete?
 *
 * Windows lets you double-click a .bat while still *viewing* a zip. It silently
 * extracts to a temp folder and runs it from there. Setup would then register a
 * path under AppData\Local\Temp that Windows later cleans up: it reports
 * success, works that day, and breaks days later with no visible cause. That is
 * the worst failure mode in the whole install, so it is refused up front.
 *
 * Deliberately narrow. Only genuine temp locations are matched — a folder the
 * user chose that merely has "temp" in the name must not be refused, because a
 * false refusal blocks a install that would have worked.
 *
 * @param {string} path Folder to judge.
 * @param {Record<string, string|undefined>} [env] Defaults to process.env.
 * @returns {{temporary: boolean, reason?: string}}
 */
export function isTemporaryLocation(path, env = process.env) {
  const target = normalizeForCompare(path);

  // The Windows zip viewer extracts to %LOCALAPPDATA%\Temp\Temp1_<name>.zip\.
  // Matched by name because it is the specific signature of "ran from the zip",
  // which deserves a clearer explanation than a generic temp folder.
  if (/(^|\/)temp\d+_[^/]*/i.test(target)) {
    return { temporary: true, reason: 'zip' };
  }

  const candidates = [
    env.TEMP,
    env.TMP,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Temp') : undefined,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = normalizeForCompare(candidate);
    if (base === '') continue;
    // Segment-aware: C:/Temporary must not match C:/Temp.
    if (target === base || target.startsWith(`${base}/`)) {
      return { temporary: true, reason: 'temp' };
    }
  }

  return { temporary: false };
}

/** Windows paths differ by slash and case without differing. */
function normalizeForCompare(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The package root for the caller, resolved from its own location.
 *
 * @param {string} moduleUrl Pass `import.meta.url` from the calling module.
 * @returns {string} Package root. Falls back to the module's own directory,
 *   so callers always get a usable path and report a missing-files error
 *   themselves rather than crashing here.
 */
export function packageRootFor(moduleUrl) {
  const here = dirname(fileURLToPath(moduleUrl));
  return findPackageRoot(here) ?? here;
}

/**
 * The folder that survives an update, as opposed to the one that is replaced.
 *
 * An install that can update itself keeps the versioned payload in `app\` and
 * everything durable one level above it:
 *
 *   TallyPrime for Claude/        <- the INSTALL root: stable across versions
 *     Setup.bat, node/, launch.mjs
 *     .env                        <- the user's settings
 *     run-log.txt, update-state.json
 *     app/                        <- the PACKAGE root: replaced on every update
 *       package.json, dist/, scripts/, node_modules/
 *
 * The distinction is not cosmetic. `.env` holds the export folder somebody chose
 * and the schedule they agreed to; if it lived inside `app\` every update would
 * silently reset it, the exporter would come back up with no folder configured,
 * and the workbook would stop refreshing while still sitting there looking
 * current. So state is addressed from here and code from `packageRootFor`.
 *
 * A source checkout and an older flat install have no `app\` layer, and there
 * the two roots are the same folder — which is why this is derived rather than
 * assumed.
 *
 * @param {string} moduleUrl Pass `import.meta.url` from the calling module.
 * @returns {string} The stable install root.
 */
export function installRootFor(moduleUrl) {
  return installRootOf(packageRootFor(moduleUrl));
}

/**
 * The install root for a known package root.
 *
 * Separate from `installRootFor` so it can be tested without a real module on
 * disk, and so a caller that already resolved its package root does not resolve
 * it twice.
 *
 * @param {string} packageRoot
 * @returns {string}
 */
export function installRootOf(packageRoot) {
  const name = packageRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  // `app.next` appears here only if something ran a staged payload in place,
  // which nothing should — but resolving it to the same root is the harmless
  // answer, and pointing at a folder inside the payload is not.
  return name === 'app' || name === 'app.next' ? dirname(packageRoot) : packageRoot;
}

/**
 * Can this install actually write to its own folder?
 *
 * Tested rather than inferred from the path. A folder under Program Files is the
 * common case — a standard user cannot write there — but a read-only network
 * share, a locked-down managed machine and a folder someone made read-only all
 * fail the same way, and no list of paths would catch them.
 *
 * It matters because this install keeps state beside itself: the `.env` holding
 * the export folder, the run log, and the staged next version an update unpacks.
 * Without write access Setup fails partway and updates can never land, so it is
 * worth one file create and delete to say so before anything is changed.
 *
 * @param {string} dir Folder to test.
 * @returns {boolean}
 */
export function isWritable(dir) {
  const probe = join(dir, `.tally-write-probe-${String(process.pid)}`);
  try {
    writeFileSync(probe, '', 'utf8');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every place Claude Desktop might keep claude_desktop_config.json.
 *
 * THERE ARE TWO, and writing only the documented one is why a connector can be
 * installed successfully and never appear.
 *
 * The MSIX build — the one Windows installs now, and what the Microsoft Store
 * ships — is packaged, so its %APPDATA% is virtualised into its own package
 * container. It reads:
 *
 *   %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude *
 * The older unpackaged build, and every tutorial and doc page, uses:
 *
 *   %APPDATA%\Claude *
 * Claude Desktop's own "Edit Config" button still opens the second one even on
 * the MSIX build, so a person can edit a file, see their change saved, restart,
 * and find nothing — which is exactly the failure this install kept hitting.
 *
 * Both are returned, existing ones first. The caller writes to every location
 * that is already there, because a machine can carry both builds and there is no
 * reliable way to know from outside which one the user actually launches. Writing
 * two small JSON files is far cheaper than guessing wrong.
 *
 * @param {Record<string, string|undefined>} [env] Defaults to process.env.
 * @returns {{path: string, kind: 'packaged'|'legacy', present: boolean}[]}
 */
export function claudeConfigCandidates(env = process.env) {
  const out = [];
  const local = env.LOCALAPPDATA;
  const appData = env.APPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Roaming') : undefined);

  if (local) {
    out.push({
      kind: 'packaged',
      dir: join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'),
    });
  }
  if (appData) out.push({ kind: 'legacy', dir: join(appData, 'Claude') });

  return out
    .map((entry) => ({
      path: join(entry.dir, 'claude_desktop_config.json'),
      kind: entry.kind,
      present: existsSync(entry.dir),
    }))
    .sort((a, b) => Number(b.present) - Number(a.present));
}

/**
 * The locations Setup should actually write.
 *
 * Every candidate whose folder already exists — that folder existing is the only
 * honest evidence that build has been run. If none has, the legacy path is
 * created, because it is the documented default and an unpackaged install is
 * still perfectly possible.
 *
 * @param {Record<string, string|undefined>} [env] Defaults to process.env.
 * @returns {{path: string, kind: 'packaged'|'legacy', present: boolean}[]}
 */
export function claudeConfigTargets(env = process.env) {
  const candidates = claudeConfigCandidates(env);
  const present = candidates.filter((entry) => entry.present);
  if (present.length > 0) return present;
  return candidates.filter((entry) => entry.kind === 'legacy');
}
