import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - plain ESM release script, no type declarations by design.
import { stampChangelog, todayIso } from '../../scripts/stamp-changelog.mjs';

/**
 * The release path runs once per version, which makes it the worst place to
 * discover a regex that does not match. In particular the real CHANGELOG.md
 * heading uses an em dash, and a pattern written with a plain hyphen would fail
 * silently on exactly the file it exists to edit — so the last test here runs
 * against the committed changelog itself rather than a fixture.
 */

interface Result {
  status: 'stamped' | 'already-stamped' | 'no-heading';
  text: string;
}

// The import is untyped by design, so the annotation here is what gives the
// assertions below a shape to check against.
const stamp = (text: string, version = '0.2.0', date = '2026-09-01'): Result =>
  stampChangelog(text, version, date);

describe('stampChangelog', () => {
  it('rewrites an unreleased heading as the released version and date', () => {
    const result = stamp('# Changelog\n\n## 0.2.0 — unreleased\n\nNotes.\n');

    expect(result.status).toBe('stamped');
    expect(result.text).toContain('## 0.2.0 — 2026-09-01');
    expect(result.text).not.toContain('unreleased');
  });

  it('stamps the version being released even when the heading names an older one', () => {
    // `npm version minor` bumps package.json before this runs, so the heading
    // left over from development can carry the previous number.
    const result = stamp('## 0.1.0 — unreleased\n');
    expect(result.text).toContain('## 0.2.0 — 2026-09-01');
  });

  it('is idempotent — a re-run neither restamps nor duplicates', () => {
    const once = stamp('## 0.2.0 — unreleased\n');
    const twice = stamp(once.text, '0.2.0', '2026-12-25');

    expect(twice.status).toBe('already-stamped');
    expect(twice.text).toBe(once.text);
    expect(twice.text).toContain('2026-09-01');
  });

  it('refuses rather than guessing when there is no unreleased heading', () => {
    const result = stamp('# Changelog\n\n## 0.1.0 — 2026-08-12\n\nShipped.\n');

    expect(result.status).toBe('no-heading');
    expect(result.text).toBe('# Changelog\n\n## 0.1.0 — 2026-08-12\n\nShipped.\n');
  });

  it('leaves released sections below it untouched', () => {
    const result = stamp('## 0.2.0 — unreleased\n\nNew.\n\n## 0.1.0 — 2026-08-12\n\nOld.\n');
    expect(result.text).toContain('## 0.1.0 — 2026-08-12');
    expect(result.text).toContain('Old.');
  });

  it('matches the heading in the real CHANGELOG.md, em dash included', () => {
    const changelog = readFileSync(
      fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url)),
      'utf-8'
    );
    // Either it still has an unreleased section to stamp, or the current
    // version is already stamped. "no-heading" would mean the release flow is
    // broken against the actual file.
    expect(stamp(changelog).status).not.toBe('no-heading');
  });
});

describe('todayIso', () => {
  it('formats a local date, zero-padded', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('uses the local calendar date rather than UTC', () => {
    // Late-evening local time is already tomorrow in UTC; a release cut on the
    // 12th must be dated the 12th.
    const lateLocal = new Date(2026, 7, 12, 23, 30);
    expect(todayIso(lateLocal)).toBe('2026-08-12');
  });
});
