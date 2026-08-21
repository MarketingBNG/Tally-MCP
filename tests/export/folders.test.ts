import { describe, it, expect } from 'vitest';
import { assignFolderNames, companyPaths, sanitiseComponent } from '../../src/export/folders.js';
import { EMPTY_STATE, exportIsDue, type Fingerprint } from '../../src/export/fingerprint.js';
import { plainReason } from '../../src/export/run.js';

/**
 * A company name is Tally's text and a Windows folder name is not.
 *
 * Every case here is a real name failing rather than a hypothetical: the one
 * that matters most is the COLLISION, because that is the failure that mixes
 * two clients' books in one folder.
 */

describe('sanitising a company name', () => {
  it('replaces the characters Windows refuses', () => {
    expect(sanitiseComponent('ACME: Trading / Export * Ltd')).toBe('ACME- Trading - Export - Ltd');
  });

  it('leaves a legal name alone', () => {
    expect(sanitiseComponent('AGBV Nutrition GmbH - (from 1-Jan-24)')).toBe(
      'AGBV Nutrition GmbH - (from 1-Jan-24)'
    );
  });

  it('suffixes a reserved device name, which cannot be a folder at all', () => {
    expect(sanitiseComponent('CON')).toBe('CON (company)');
    expect(sanitiseComponent('LPT1')).toBe('LPT1 (company)');
    // ...and does so even with an extension, which Windows also refuses.
    expect(sanitiseComponent('NUL.books')).toBe('NUL.books (company)');
  });

  it('strips a trailing dot or space, which Windows would strip invisibly', () => {
    expect(sanitiseComponent('ACME Ltd.')).toBe('ACME Ltd');
    expect(sanitiseComponent('ACME Ltd ')).toBe('ACME Ltd');
  });

  it('never returns an empty name, whatever it was given', () => {
    expect(sanitiseComponent('///')).toBe('Company');
    expect(sanitiseComponent('')).toBe('Company');
  });

  it('truncates without leaving a trailing dot behind', () => {
    expect(sanitiseComponent('A'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe('collisions', () => {
  it('gives the second company its own folder rather than overwriting the first', () => {
    // Two DIFFERENT companies whose names sanitise identically. Without this,
    // one folder would hold two clients' books.
    const assigned = assignFolderNames(['ACME: Ltd', 'ACME/ Ltd']);
    const folders = [...assigned.values()];
    expect(new Set(folders).size).toBe(2);
  });

  it('is stable: the same list assigns the same folders every time', () => {
    const names = ['ACME: Ltd', 'ACME/ Ltd', 'Other Co'];
    expect([...assignFolderNames(names).values()]).toEqual([...assignFolderNames(names).values()]);
  });

  it('gives the same company the same folder however TallyPrime ordered the list', () => {
    // The bug this pins. The suffix used to come from the company's POSITION in
    // the caller's list, and TallyPrime is not promised to list companies in a
    // stable order. Two colliding names swapping places would swap FOLDERS —
    // one client's books written into the folder holding another's.
    const names = ['ACME: Ltd', 'ACME/ Ltd', 'Other Co'];
    const forward = assignFolderNames(names);
    const reversed = assignFolderNames([...names].reverse());
    const shuffled = assignFolderNames(['Other Co', 'ACME/ Ltd', 'ACME: Ltd']);

    for (const name of names) {
      expect(reversed.get(name), `${name} moved when the list was reversed`).toBe(
        forward.get(name)
      );
      expect(shuffled.get(name), `${name} moved when the list was shuffled`).toBe(
        forward.get(name)
      );
    }
  });

  it('still gives every company a folder of its own after sorting', () => {
    const assigned = assignFolderNames(['A: X', 'A/ X', 'A* X']);
    expect(new Set(assigned.values()).size).toBe(3);
  });
});

describe('paths', () => {
  const when = new Date('2026-08-19T18:05:00');

  it('puts the workbook and its Archive under one folder per company', () => {
    const paths = companyPaths('C:\\Drive', 'ACME Ltd', 'ACME Ltd', when);
    expect(paths.folder).toContain('ACME Ltd');
    expect(paths.workbook).toMatch(/ACME Ltd\.xlsx$/);
    expect(paths.archiveWorkbook).toMatch(/Archive[\\/]ACME Ltd 2026-08-19 1805\.xlsx$/);
  });

  it('refuses a path that will not fit, with a message rather than an OS error', () => {
    expect(() =>
      companyPaths(`C:\\${'deep\\'.repeat(40)}`, 'A Long Company Name Ltd', 'A Long Company Name Ltd', when)
    ).toThrow(/too deep for this company's name/);
  });
});

describe('deciding whether to export', () => {
  const fingerprint = (digest: string): Fingerprint => ({
    digest,
    voucherPairs: 10,
    ledgerPairs: 5,
    skeletonBlocks: 1,
  });

  it('exports on the first run, when nothing is known', () => {
    expect(exportIsDue(EMPTY_STATE, fingerprint('a'), '2026-08-19', false)).toEqual({
      due: true,
      reason: 'first-run',
    });
  });

  it('exports when the fingerprint moved', () => {
    const state = { ...EMPTY_STATE, digest: 'a', archivedOn: '2026-08-19' };
    expect(exportIsDue(state, fingerprint('b'), '2026-08-19', false).reason).toBe('changed');
  });

  it('does NOT export when nothing changed and today is already archived', () => {
    const state = { ...EMPTY_STATE, digest: 'a', archivedOn: '2026-08-19' };
    expect(exportIsDue(state, fingerprint('a'), '2026-08-19', false).due).toBe(false);
  });

  it("exports once a day even when nothing changed, so the as-at stamp advances", () => {
    const state = { ...EMPTY_STATE, digest: 'a', archivedOn: '2026-08-18' };
    expect(exportIsDue(state, fingerprint('a'), '2026-08-19', false).reason).toBe('daily');
  });

  it('exports when forced, whatever the fingerprint says', () => {
    const state = { ...EMPTY_STATE, digest: 'a', archivedOn: '2026-08-19' };
    expect(exportIsDue(state, fingerprint('a'), '2026-08-19', true).reason).toBe('forced');
  });
});

describe('diagnosing a failure in words an accountant can act on', () => {
  it('names TallyPrime being closed', () => {
    expect(plainReason(new Error('Could not reach TallyPrime at http://127.0.0.1:9000.'))).toBe(
      'TallyPrime was not open'
    );
  });

  it('names the workbook being open', () => {
    expect(plainReason(new Error('something has it open — almost always Excel'))).toBe(
      'the workbook is open in Excel'
    );
  });

  it('does NOT blame Excel for a folder that cannot be written', () => {
    // Both situations produce EPERM. Checking the workbook first would send
    // somebody off to close a file that was never the problem.
    const error = new Error(
      'The export folder could not be reached or created:\n  Q:\\gone\n\n' +
        'Technical detail: Error: EPERM: operation not permitted, mkdir'
    );
    expect(plainReason(error)).toBe('the export folder is missing or cannot be written to');
  });

  it('falls back to something honest rather than inventing a cause', () => {
    expect(plainReason(new Error('something nobody anticipated'))).toBe(
      'something unexpected went wrong'
    );
  });
});
