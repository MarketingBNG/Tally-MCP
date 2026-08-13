import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain ESM helper, shipped without type declarations because
// it must run under the bundled Node runtime with no build step.
import { buildFreshness } from '../../installer/scripts/lib/buildFreshness.mjs';

/**
 * Claude Desktop launches dist/index.js, never the TypeScript, so a forgotten
 * build leaves the previous server running with no symptom at all — a whole
 * tool once existed in src/, passed its tests, and was invisible to every
 * client. These tests pin the two answers that matter: stale must be detected,
 * and a shipped folder (no src/) must stay silent rather than alarm an
 * accountant about a build step they do not have.
 */

let sandbox: string;

/** Set an explicit mtime so ordering is asserted, not raced. */
function writeAt(path: string, contents: string, epochSeconds: number): void {
  writeFileSync(path, contents);
  utimesSync(path, epochSeconds, epochSeconds);
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tally-freshness-'));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function scaffold(name: string): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, 'src', 'tools'), { recursive: true });
  mkdirSync(join(root, 'dist', 'tools'), { recursive: true });
  return root;
}

describe('buildFreshness', () => {
  it('reports stale when a source file is newer than the newest build output', () => {
    const root = scaffold('stale');
    writeAt(join(root, 'dist', 'index.js'), '//built', 1_000_000);
    writeAt(join(root, 'src', 'tools', 'query.ts'), 'export const a = 1;', 2_000_000);

    const result = buildFreshness(root) as { status: string; detail?: string };
    expect(result.status).toBe('stale');
    // The message must name the file, or "run a build" is the only actionable
    // part and the developer cannot tell which change is missing.
    expect(result.detail).toContain('query.ts');
  });

  it('reports fresh when the build is newer than every source file', () => {
    const root = scaffold('fresh');
    writeAt(join(root, 'src', 'tools', 'query.ts'), 'export const a = 1;', 1_000_000);
    writeAt(join(root, 'dist', 'tools', 'query.js'), '//built', 2_000_000);

    expect((buildFreshness(root) as { status: string }).status).toBe('fresh');
  });

  it('reports missing when there is no build at all', () => {
    const root = join(sandbox, 'never-built');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeAt(join(root, 'src', 'index.ts'), 'export const a = 1;', 1_000_000);

    expect((buildFreshness(root) as { status: string }).status).toBe('missing');
  });

  it('stays silent in a shipped folder, which has dist/ but no src/', () => {
    const root = join(sandbox, 'shipped');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeAt(join(root, 'dist', 'index.js'), '//built', 1_000_000);

    expect((buildFreshness(root) as { status: string }).status).toBe('not-applicable');
  });

  it('ignores files that are not TypeScript sources or compiled JavaScript', () => {
    // A newer README or .env in src/ is not a reason to rebuild.
    const root = scaffold('irrelevant-files');
    writeAt(join(root, 'src', 'index.ts'), 'export const a = 1;', 1_000_000);
    writeAt(join(root, 'dist', 'index.js'), '//built', 2_000_000);
    writeAt(join(root, 'src', 'notes.md'), '# later', 3_000_000);

    expect((buildFreshness(root) as { status: string }).status).toBe('fresh');
  });
});
