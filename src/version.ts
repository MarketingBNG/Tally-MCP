import { createRequire } from 'node:module';

/**
 * The server version, read from package.json at startup.
 *
 * One source of truth on purpose. This number is what a user reads back to you
 * during support ("what version are you on?"), so it must be impossible for the
 * reported version and the shipped code to disagree — which is exactly what
 * happens when the number is also typed into a literal somewhere.
 *
 * Resolved relative to this module rather than to the process working
 * directory: Claude Desktop launches the server with an arbitrary cwd, so
 * anything relative to `process.cwd()` would break under the very client this
 * ships for. `../package.json` is correct from both `src/` in development and
 * `dist/` once built, since both sit one level under the package root.
 */
const require = createRequire(import.meta.url);

interface PackageManifest {
  version?: unknown;
}

function readVersion(): string {
  try {
    const manifest = require('../package.json') as PackageManifest;
    return typeof manifest.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : 'unknown';
  } catch {
    // A missing or unreadable manifest must not stop the server from starting.
    // An unknown version degrades support, losing the server breaks the user.
    return 'unknown';
  }
}

export const SERVER_VERSION: string = readVersion();
