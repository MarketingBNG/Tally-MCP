import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Stamp the changelog with the version being released.
 *
 * Run by npm's `version` lifecycle, after package.json has been bumped and
 * before the release commit is made — so the version number and its release
 * notes land in the same commit and cannot drift apart.
 *
 * Why this is worth automating: the version an install reports comes from
 * package.json (see src/version.ts), and it is the first thing asked in a
 * support conversation. Once accountants have copies installed, "what changed
 * in 0.2.0" has to have an answer, and a changelog whose newest entry still
 * says "unreleased" cannot provide one.
 *
 * The convention it relies on: the top section of CHANGELOG.md is headed
 * `## <version> — unreleased` while work accumulates. That heading is rewritten
 * to the released version and today's date.
 */

/** Heading for a section still being written. Matches an em or plain dash. */
const UNRELEASED_HEADING = /^##[^\n]*[—-]\s*unreleased\s*$/im;

/**
 * Rewrite the unreleased heading as a released one.
 *
 * Pure so it can be tested without a filesystem: the release path runs once per
 * version and is the worst place to discover a regex that does not match.
 *
 * @param {string} changelog Current CHANGELOG.md contents.
 * @param {string} version Version being released, e.g. "0.2.0".
 * @param {string} date ISO calendar date, e.g. "2026-08-12".
 * @returns {{status: 'stamped'|'already-stamped'|'no-heading', text: string}}
 */
export function stampChangelog(changelog, version, date) {
  const heading = `## ${version} — `;

  // Idempotent: a re-run must not stamp a second heading or change the date.
  const stamped = changelog
    .split('\n')
    .some((line) => line.startsWith(heading) && /\d{4}-\d{2}-\d{2}\s*$/.test(line));
  if (stamped) return { status: 'already-stamped', text: changelog };

  if (!UNRELEASED_HEADING.test(changelog)) {
    return { status: 'no-heading', text: changelog };
  }

  return {
    status: 'stamped',
    text: changelog.replace(UNRELEASED_HEADING, `${heading}${date}`),
  };
}

/** Local calendar date, ISO-shaped. Releases are dated where they are cut. */
export function todayIso(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * CLI mode, invoked by `npm version`.
 *
 * The entry check compares full file URLs — matching on a basename silently
 * never fires on Windows, where argv[1] is a backslash path.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const changelogPath = join(root, 'CHANGELOG.md');

  const version = readVersion(root);
  const date = todayIso();
  const result = stampChangelog(readFileSync(changelogPath, 'utf8'), version, date);

  if (result.status === 'already-stamped') {
    console.log(`CHANGELOG.md already documents ${version}.`);
  } else if (result.status === 'no-heading') {
    console.error(
      `CHANGELOG.md has no "## <version> — unreleased" heading to stamp as ${version}.`
    );
    console.error('');
    console.error('Add one above the newest released section, describing what changed in plain');
    console.error('English for an accountant, then run the version command again.');
    process.exitCode = 1;
  } else {
    writeFileSync(changelogPath, result.text);
    console.log(`CHANGELOG.md stamped: ${version} — ${date}`);
  }
}

/** @param {string} root */
function readVersion(root) {
  // npm sets this during the version lifecycle; the manifest is the fallback so
  // the script also works when run by hand.
  const fromEnv = process.env.npm_package_version;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    console.error('package.json has no version to stamp.');
    process.exit(1);
  }
  return manifest.version;
}
