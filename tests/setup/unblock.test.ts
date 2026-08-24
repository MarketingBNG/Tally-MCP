import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain ESM helper, shipped without type declarations because
// it must run under the bundled Node runtime with no build step.
import { unblockOnce, unblockTree } from '../../installer/scripts/lib/unblock.mjs';

/**
 * The mark of the web is an NTFS alternate data stream, so these tests are
 * Windows-only in the same way the staging tests in update.test.ts are: on
 * Linux `file:Zone.Identifier` is just a filename with a colon in it and the
 * whole mechanism being tested does not exist.
 *
 * What is being pinned is small and worth pinning anyway: a marked launcher
 * loses its mark, a re-run reports nothing left to do, and the walk never
 * throws on a folder it cannot read — Setup must not fail over this.
 */

let sandbox: string;
const roots: string[] = [];

function mark(path: string) {
  writeFileSync(path, 'x');
  writeFileSync(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
}

const marked = (path: string) => existsSync(`${path}:Zone.Identifier`);

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'unblock-'));
  roots.push(sandbox);
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('clearing the download mark', () => {
  it('clears it from launchers at any depth, and leaves the files themselves', () => {
    mkdirSync(join(sandbox, 'app', 'scripts'), { recursive: true });
    const bat = join(sandbox, 'Run-Export.bat');
    const vbs = join(sandbox, 'Run-Export-Hidden.vbs');
    const deep = join(sandbox, 'app', 'scripts', 'export.mjs');
    [bat, vbs, deep].forEach(mark);

    expect(unblockTree(sandbox)).toEqual({ cleared: 3, failed: 0 });
    expect([bat, vbs, deep].map(marked)).toEqual([false, false, false]);
    expect([bat, vbs, deep].every(existsSync)).toBe(true);
  });

  it('is silent on a second run, so Setup does not narrate a no-op', () => {
    mark(join(sandbox, 'Setup.bat'));
    unblockTree(sandbox);

    expect(unblockTree(sandbox)).toEqual({ cleared: 0, failed: 0 });
  });

  it('walks past files Windows never launches', () => {
    const notes = join(sandbox, 'READ ME FIRST.txt');
    mark(notes);

    expect(unblockTree(sandbox)).toEqual({ cleared: 0, failed: 0 });
    expect(marked(notes)).toBe(true);
  });

  it('reports nothing rather than throwing when the folder is not there', () => {
    expect(unblockTree(join(sandbox, 'gone'))).toEqual({ cleared: 0, failed: 0 });
  });

  it('sweeps once and then costs nothing, so it can sit on the five-minute path', () => {
    mark(join(sandbox, 'Run-Export.bat'));

    expect(unblockOnce(sandbox)).toEqual({ cleared: 1, failed: 0, skipped: false });

    // The second call does not even walk the tree — that is the whole point of
    // the marker, since the exporter calls this every five minutes.
    mark(join(sandbox, 'Setup.bat'));
    expect(unblockOnce(sandbox)).toEqual({ cleared: 0, failed: 0, skipped: true });
    expect(marked(join(sandbox, 'Setup.bat'))).toBe(true);
  });

  it('leaves a marker saying what happened and that deleting it is safe', () => {
    unblockOnce(sandbox);

    const marker = readFileSync(join(sandbox, '.unblocked'), 'utf8');
    expect(marker).toContain('Windows marks files');
    expect(marker).toContain('harmless');
  });
});
