import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markFoldersFailed } from '../../src/export/run.js';

/**
 * A failing export must say so in the folder somebody READS.
 *
 * The status file is written per company from inside the export, so a run that
 * dies before reaching any company left every folder carrying the note from the
 * last run that worked. Observed on a live install: two days of failures every
 * five minutes, and the shared drive still said `LAST RUN OK`, beside a workbook
 * nobody had refreshed. The person reading that file is not the person whose
 * machine raised the notification.
 */

let root: string;
const roots: string[] = [];
const NOW = new Date('2026-08-24T09:15:00Z');

/** A folder that a real export has visited — that is what export-state.json means. */
function companyFolder(name: string, lastStatus?: string) {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'export-state.json'), '{}', 'utf8');
  writeFileSync(join(folder, `${name}.xlsx`), 'workbook', 'utf8');
  if (lastStatus) writeFileSync(join(folder, lastStatus), 'previous outcome', 'utf8');
  return folder;
}

const statusFilesIn = (folder: string) =>
  readdirSync(folder).filter((name) => name.startsWith('LAST RUN '));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stale-'));
  roots.push(root);
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('marking folders when the export never started', () => {
  it('replaces a stale "OK" with the failure, in every company folder', () => {
    const a = companyFolder('Alpha Ltd', 'LAST RUN OK - 2026-08-22 1403.txt');
    const b = companyFolder('Beta GmbH', 'LAST RUN OK - 2026-08-22 1403.txt');

    markFoldersFailed(root, NOW, 'TallyPrime was not open');

    for (const folder of [a, b]) {
      const status = statusFilesIn(folder);
      expect(status).toHaveLength(1);
      expect(status[0]).toContain('LAST RUN FAILED');
      expect(status[0]).toContain('TallyPrime was not open');
    }
  });

  it('tells the reader the workbook is the older one, since that is what they have open', () => {
    const folder = companyFolder('Alpha Ltd');

    markFoldersFailed(root, NOW, 'TallyPrime was not open');

    const body = readFileSync(join(folder, statusFilesIn(folder)[0]), 'utf8');
    expect(body).toContain('did not finish');
    expect(body).toContain('last run that DID finish');
    expect(body).toContain('as-at date');
  });

  it('leaves the workbook itself untouched', () => {
    const folder = companyFolder('Alpha Ltd');

    markFoldersFailed(root, NOW, 'the export folder could not be reached');

    expect(readFileSync(join(folder, 'Alpha Ltd.xlsx'), 'utf8')).toBe('workbook');
  });

  it('ignores folders no export has ever written to', () => {
    // Someone's own subfolder in the export root is not ours to annotate.
    mkdirSync(join(root, 'Notes from the auditor'), { recursive: true });

    markFoldersFailed(root, NOW, 'TallyPrime was not open');

    expect(statusFilesIn(join(root, 'Notes from the auditor'))).toEqual([]);
  });

  it('never throws when the export root itself is gone — the usual reason it is called', () => {
    expect(() => markFoldersFailed(join(root, 'G-drive-offline'), NOW, 'unreachable')).not.toThrow();
  });
});
