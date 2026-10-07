import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priorYearFolder, priorYearStore } from '../../src/export/priorYears.js';

/**
 * Earlier years kept between export runs. The rules that matter: a refresh
 * never serves a saved year, a reuse never serves a stale one, and a refresh
 * leaves only what it wrote.
 */

const folders: string[] = [];
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'tally-prior-'));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const response = { body: '<ENVELOPE>FY24</ENVELOPE>', repairs: ['fixed one'] };

describe('the earlier-years store', () => {
  it('serves back exactly what was saved, on a reuse run', () => {
    const folder = scratch();
    priorYearStore(folder, 'refresh').write('request A', response);
    expect(priorYearStore(folder, 'reuse').read('request A')).toEqual(response);
    expect(priorYearStore(folder, 'reuse').read('request B')).toBeNull();
  });

  it('never serves a saved year on a refresh run', () => {
    const folder = scratch();
    priorYearStore(folder, 'refresh').write('request A', response);
    expect(priorYearStore(folder, 'refresh').read('request A')).toBeNull();
  });

  it('refuses a copy older than two days, when the daily refresh has not run', () => {
    const folder = scratch();
    priorYearStore(folder, 'refresh').write('request A', response);
    const old = new Date('2026-10-01T00:00:00Z');
    for (const entry of readdirSync(folder)) utimesSync(join(folder, entry), old, old);
    expect(priorYearStore(folder, 'reuse', new Date('2026-10-07T00:00:00Z')).read('request A')).toBeNull();
  });

  it('leaves only the years a refresh wrote', () => {
    const folder = scratch();
    priorYearStore(folder, 'refresh').write('old year', response);
    const store = priorYearStore(folder, 'refresh');
    store.write('request A', response);
    store.finish();
    expect(readdirSync(folder)).toHaveLength(1);
    expect(priorYearStore(folder, 'reuse').read('request A')).toEqual(response);
  });

  it('keeps each company and export folder apart', () => {
    expect(priorYearFolder('X', 'A Ltd')).not.toBe(priorYearFolder('X', 'B Ltd'));
    expect(priorYearFolder('X', 'A Ltd')).not.toBe(priorYearFolder('Y', 'A Ltd'));
  });
});
