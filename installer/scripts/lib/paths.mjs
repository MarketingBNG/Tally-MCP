import { existsSync } from 'node:fs';
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
