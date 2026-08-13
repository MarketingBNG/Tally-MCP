import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRootFor } from './paths.mjs';

/**
 * Is dist/ older than src/?
 *
 * This exists because of a real incident. Claude Desktop launches
 * `dist/index.js`, never the TypeScript, so editing `src/` and forgetting to
 * build leaves the old server running with no visible symptom: the tools list
 * is simply the one from the last build. A whole tool (`tally_query_masters`)
 * was registered in source, passing its tests, and absent from every client for
 * days. Nothing failed — which is exactly why it went unnoticed.
 *
 * Comparing newest-mtime is deliberately cruder than tracking real
 * dependencies. It cannot produce a false "fresh" (any edit moves an mtime
 * forward), and a false "stale" costs one unnecessary `npm run build`. Those are
 * the right way round for a check whose whole job is to stop silent staleness.
 *
 * In a shipped folder there is no `src/`, so this reports `not-applicable`
 * rather than inventing a problem for an accountant to worry about.
 *
 * @param {string} packageRoot Folder holding package.json.
 * @returns {{status: 'fresh'|'stale'|'missing'|'not-applicable', detail?: string}}
 */
export function buildFreshness(packageRoot) {
  const srcDir = join(packageRoot, 'src');
  const distDir = join(packageRoot, 'dist');

  // No src/ means this is a shipped payload, where the question is meaningless.
  if (!existsSync(srcDir)) return { status: 'not-applicable' };

  const newestSource = newestMtime(srcDir, '.ts');
  if (newestSource === null) return { status: 'not-applicable' };

  if (!existsSync(distDir)) {
    return { status: 'missing', detail: 'dist/ does not exist — the server has never been built.' };
  }

  const newestBuilt = newestMtime(distDir, '.js');
  if (newestBuilt === null) {
    return { status: 'missing', detail: 'dist/ holds no compiled JavaScript.' };
  }

  if (newestSource.mtimeMs > newestBuilt.mtimeMs) {
    return {
      status: 'stale',
      detail:
        `${newestSource.file} was changed after the last build ` +
        `(newest built file: ${newestBuilt.file}).`,
    };
  }

  return { status: 'fresh' };
}

/**
 * Newest file with the given extension anywhere under `dir`.
 *
 * @param {string} dir
 * @param {string} extension
 * @returns {{file: string, mtimeMs: number}|null}
 */
function newestMtime(dir, extension) {
  /** @type {{file: string, mtimeMs: number}|null} */
  let newest = null;

  /** @param {string} current */
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // An unreadable directory is not worth failing a diagnostic over.
      return;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(extension)) continue;

      try {
        const { mtimeMs } = statSync(full);
        if (newest === null || mtimeMs > newest.mtimeMs) {
          newest = { file: entry.name, mtimeMs };
        }
      } catch {
        // Skip a file that vanished mid-walk.
      }
    }
  };

  walk(dir);
  return newest;
}

/**
 * CLI mode: `npm run check:build`. Exits non-zero when a rebuild is needed, so
 * it can gate anything that matters.
 *
 * The entry check compares full file URLs. Matching on a basename silently
 * never fires on Windows, where argv[1] is a backslash path.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildFreshness(packageRootFor(import.meta.url));

  if (result.status === 'fresh') {
    console.log('dist/ is up to date with src/.');
  } else if (result.status === 'not-applicable') {
    console.log('No src/ directory here — nothing to compare.');
  } else {
    console.error(`dist/ is out of date: ${result.detail ?? ''}`);
    console.error('Run  npm run build  and restart Claude Desktop.');
    process.exitCode = 1;
  }
}
