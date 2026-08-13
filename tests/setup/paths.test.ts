import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain ESM helper, shipped without type declarations because
// it must run under the bundled Node runtime with no build step.
import { findPackageRoot, isTemporaryLocation } from '../../installer/scripts/lib/paths.mjs';

/**
 * The installer scripts sit at different depths in the source checkout than in
 * the folder a user unzips, so the package root is found by walking up rather
 * than by counting directories. These tests pin both layouts, because getting
 * this wrong means Setup registers a path that does not exist — and the user
 * sees nothing at all go wrong until Claude silently fails to connect.
 */

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tally-paths-'));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('findPackageRoot', () => {
  it('finds the root from the shipped layout (scripts/lib is 2 deep)', () => {
    // TallyPrime for Claude/{package.json, scripts/lib}
    const root = join(sandbox, 'shipped');
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');

    expect(findPackageRoot(join(root, 'scripts', 'lib'))).toBe(root);
  });

  it('finds the root from the source checkout (installer/scripts/lib is 3 deep)', () => {
    // tally-mcp/{package.json, installer/scripts/lib}
    const root = join(sandbox, 'checkout');
    mkdirSync(join(root, 'installer', 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}');

    expect(findPackageRoot(join(root, 'installer', 'scripts', 'lib'))).toBe(root);
  });

  it('stops at the nearest package.json, not the outermost one', () => {
    // A nested package.json must win, or the installer would resolve to some
    // parent folder that merely happens to be a package.
    const outer = join(sandbox, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(join(inner, 'scripts'), { recursive: true });
    writeFileSync(join(outer, 'package.json'), '{"name":"outer"}');
    writeFileSync(join(inner, 'package.json'), '{"name":"inner"}');

    expect(findPackageRoot(join(inner, 'scripts'))).toBe(inner);
  });

  it('returns null when no ancestor holds a package.json', () => {
    // Walks to the filesystem root and gives up rather than looping.
    const orphan = join(sandbox, 'orphan', 'a', 'b');
    mkdirSync(orphan, { recursive: true });

    // The sandbox itself has no package.json, and neither does tmp.
    expect(findPackageRoot(orphan)).toBeNull();
  });
});

/**
 * The guard against installing from a folder Windows will delete.
 *
 * Both directions matter. Missing a real temp folder means the install breaks
 * days later with no visible cause; falsely flagging a folder the user chose
 * blocks an install that would have worked. The second is the reason this is
 * matched narrowly rather than by looking for "temp" anywhere in the path.
 */
describe('isTemporaryLocation', () => {
  const ENV = {
    TEMP: 'C:\\Users\\Anita\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\Anita\\AppData\\Local\\Temp',
    LOCALAPPDATA: 'C:\\Users\\Anita\\AppData\\Local',
  };

  it('flags the Windows zip viewer folder, with the zip reason', () => {
    const path = 'C:\\Users\\Anita\\AppData\\Local\\Temp\\Temp1_TallyPrime-for-Claude.zip';

    expect(isTemporaryLocation(path, ENV)).toEqual({ temporary: true, reason: 'zip' });
  });

  it('flags anything inside the temp folder', () => {
    const path = 'C:\\Users\\Anita\\AppData\\Local\\Temp\\somewhere\\TallyPrime for Claude';

    expect(isTemporaryLocation(path, ENV).temporary).toBe(true);
  });

  it('accepts Documents, the folder we tell people to use', () => {
    const path = 'C:\\Users\\Anita\\Documents\\TallyPrime for Claude';

    expect(isTemporaryLocation(path, ENV)).toEqual({ temporary: false });
  });

  it('accepts Downloads — awkward, but not deleted by Windows', () => {
    const path = 'C:\\Users\\Anita\\Downloads\\TallyPrime for Claude';

    expect(isTemporaryLocation(path, ENV).temporary).toBe(false);
  });

  it('does not flag a folder that merely starts with the temp path\'s name', () => {
    // C:\...\Temporary is not inside C:\...\Temp.
    const path = 'C:\\Users\\Anita\\AppData\\Local\\Temporary\\TallyPrime for Claude';

    expect(isTemporaryLocation(path, ENV).temporary).toBe(false);
  });

  it('does not flag a folder the user named with "temp" in it', () => {
    // A false refusal blocks a working install, so this must stay allowed.
    const path = 'C:\\Users\\Anita\\Documents\\temp files\\TallyPrime for Claude';

    expect(isTemporaryLocation(path, ENV).temporary).toBe(false);
  });

  it('ignores case and slash direction, as Windows does', () => {
    const path = 'c:/USERS/Anita/appdata/local/temp/TallyPrime for Claude';

    expect(isTemporaryLocation(path, ENV).temporary).toBe(true);
  });

  it('does not crash when the temp variables are missing', () => {
    expect(isTemporaryLocation('C:\\Tally', {}).temporary).toBe(false);
  });
});

describe('findPackageRoot (edge)', () => {
  it('returns null for an orphan folder', () => {
    // Walks to the filesystem root and gives up rather than looping.
    const orphan = join(sandbox, 'orphan', 'a', 'b');
    mkdirSync(orphan, { recursive: true });

    // The sandbox itself has no package.json, and neither does tmp.
    expect(findPackageRoot(orphan)).toBeNull();
  });
});
