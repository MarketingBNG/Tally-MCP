import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadEnvFile,
  markFolderRetired,
  moveExportData,
  readEnvSetting,
  writeEnvSettings,
} from '../../installer/scripts/lib/exportSetup.mjs';

/**
 * Changing the export folder, which is the second-most likely thing anybody
 * does to this feature after setting it up.
 *
 * The hazard is not the change itself — it is what gets left behind. An orphaned
 * workbook is a real spreadsheet with real figures in a folder somebody
 * bookmarked, and it looks exactly like a current one. If the old folder was
 * inside Google Drive it is still syncing, so Claude pointed at it answers from
 * books that stopped updating, with an as-at stamp nobody thought to check.
 */

let root: string;
const created: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tally-setup-'));
  created.push(root);
});

afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

describe('the .env file', () => {
  it('round-trips a setting', () => {
    writeEnvSettings(root, { TALLY_EXPORT_FOLDER: 'G:\\Shared drives\\Books' });
    expect(readEnvSetting(root, 'TALLY_EXPORT_FOLDER')).toBe('G:\\Shared drives\\Books');
  });

  it('keeps a path with spaces intact, unquoted', () => {
    writeEnvSettings(root, { TALLY_EXPORT_FOLDER: 'C:\\Two Words\\And Three More' });
    expect(readEnvSetting(root, 'TALLY_EXPORT_FOLDER')).toBe('C:\\Two Words\\And Three More');
  });

  it('changes one setting without disturbing the others', () => {
    writeEnvSettings(root, { TALLY_EXPORT_FOLDER: 'C:\\old', LOG_LEVEL: 'debug' });
    writeEnvSettings(root, { TALLY_EXPORT_FOLDER: 'C:\\new' });

    expect(readEnvSetting(root, 'TALLY_EXPORT_FOLDER')).toBe('C:\\new');
    expect(readEnvSetting(root, 'LOG_LEVEL')).toBe('debug');
  });

  it('preserves comments and hand-edited lines', () => {
    // A .env somebody has been editing by hand. Re-serialising a parsed object
    // would quietly lose all of this.
    writeFileSync(
      join(root, '.env'),
      '# our settings\nTALLY_PORT=9000\n\n# why we raised this\nTALLY_TIMEOUT_MS=60000\n',
      'utf8'
    );
    writeEnvSettings(root, { TALLY_EXPORT_FOLDER: 'C:\\books' });

    const text = readFileSync(join(root, '.env'), 'utf8');
    expect(text).toContain('# our settings');
    expect(text).toContain('# why we raised this');
    expect(text).toContain('TALLY_TIMEOUT_MS=60000');
    expect(text).toContain('TALLY_EXPORT_FOLDER=C:\\books');
  });

  it('does not update a setting hidden behind a comment', () => {
    writeFileSync(join(root, '.env'), '#TALLY_EXPORT_FOLDER=C:\\commented out\n', 'utf8');
    expect(readEnvSetting(root, 'TALLY_EXPORT_FOLDER')).toBeNull();
  });

  it('reports an absent or empty setting as null, never as an empty string', () => {
    expect(readEnvSetting(root, 'TALLY_EXPORT_FOLDER')).toBeNull();
    writeFileSync(join(root, '.env'), 'TALLY_EXPORT_FOLDER=\n', 'utf8');
    expect(readEnvSetting(root, 'TALLY_EXPORT_FOLDER')).toBeNull();
  });
});

describe('loading settings regardless of the working directory', () => {
  /**
   * The bug this pins, observed on the real scheduled task on 2026-08-19: Task
   * Scheduler runs an action with the working directory set to
   * `C:\Windows\System32`, and `dotenv` looks for `.env` in the working
   * directory. So the task fired on the minute, exited 1, and reported "No
   * export folder has been chosen yet" — every minute, on an install that was
   * correctly configured.
   */
  const guard: string[] = [];

  function track(key: string): void {
    guard.push(key);
  }

  afterAll(() => {
    for (const key of guard) delete process.env[key];
  });

  it('reads the .env by absolute path, not from the working directory', () => {
    writeEnvSettings(root, { TALLY_EXPORT_FOLDER_TEST_A: 'C:\\books' });
    track('TALLY_EXPORT_FOLDER_TEST_A');

    const applied = loadEnvFile(root);

    expect(applied).toContain('TALLY_EXPORT_FOLDER_TEST_A');
    expect(process.env.TALLY_EXPORT_FOLDER_TEST_A).toBe('C:\\books');
  });

  it('does NOT override a variable already set in the real environment', () => {
    // Somebody who set a variable for one run meant it.
    process.env.TALLY_EXPORT_FOLDER_TEST_B = 'from the environment';
    track('TALLY_EXPORT_FOLDER_TEST_B');
    writeEnvSettings(root, { TALLY_EXPORT_FOLDER_TEST_B: 'from the file' });

    loadEnvFile(root);

    expect(process.env.TALLY_EXPORT_FOLDER_TEST_B).toBe('from the environment');
  });

  it('skips comments and blank lines rather than importing nonsense', () => {
    writeFileSync(
      join(root, '.env'),
      '# a comment\n\n#TALLY_EXPORT_FOLDER_TEST_C=commented\nnot-a-setting\n',
      'utf8'
    );
    expect(loadEnvFile(root)).toEqual([]);
    expect(process.env.TALLY_EXPORT_FOLDER_TEST_C).toBeUndefined();
  });

  it('is a no-op with no .env at all, which is normal under Claude Desktop', () => {
    expect(loadEnvFile(root)).toEqual([]);
  });
});

describe('moving the export to a new folder', () => {
  /** An old folder as the exporter would have left it, plus a foreign file. */
  function populate(old: string): void {
    const company = join(old, 'ACME LTD');
    mkdirSync(join(company, 'Archive'), { recursive: true });
    writeFileSync(join(company, 'ACME LTD.xlsx'), 'current workbook', 'utf8');
    writeFileSync(join(company, 'Archive', 'ACME LTD 2026-08-01 1800.xlsx'), 'archived', 'utf8');
    writeFileSync(join(company, 'export-state.json'), '{"digest":"abc"}', 'utf8');
    writeFileSync(join(company, 'run-log.txt'), 'a line', 'utf8');
    writeFileSync(join(company, 'LAST RUN OK - 2026-08-19 1805.txt'), 'ok', 'utf8');
    writeFileSync(join(old, 'run-log.txt'), 'top level log', 'utf8');
  }

  it('brings each company across with its Archive, then removes the original', () => {
    const old = join(root, 'old');
    const to = join(root, 'new');
    populate(old);

    const result = moveExportData(old, to);

    expect(result.moved).toEqual(expect.arrayContaining(['ACME LTD', 'run-log.txt']));
    expect(result.failed).toEqual([]);

    // Arrived, contents and all.
    expect(readFileSync(join(to, 'ACME LTD', 'ACME LTD.xlsx'), 'utf8')).toBe('current workbook');
    expect(
      readFileSync(join(to, 'ACME LTD', 'Archive', 'ACME LTD 2026-08-01 1800.xlsx'), 'utf8')
    ).toBe('archived');
    // The state file too — without it the next run would export unnecessarily.
    expect(existsSync(join(to, 'ACME LTD', 'export-state.json'))).toBe(true);

    // And gone from the old place, so there is only ONE copy of these books.
    expect(existsSync(join(old, 'ACME LTD'))).toBe(false);
    expect(result.oldFolderRemoved).toBe(true);
  });

  it('LEAVES FILES IT DID NOT CREATE, and does not remove the folder holding them', () => {
    // The case that matters most. Somebody picks `G:\Shared drives\Accounts`,
    // which also holds other people's work. "Delete the old folder" would take
    // all of it — and inside Google Drive, from everyone it is shared with.
    const old = join(root, 'old');
    populate(old);
    mkdirSync(join(old, 'Payroll scans'), { recursive: true });
    writeFileSync(join(old, 'Payroll scans', 'march.pdf'), 'not ours', 'utf8');
    writeFileSync(join(old, 'working notes.docx'), 'not ours either', 'utf8');

    const result = moveExportData(old, join(root, 'new'));

    expect(result.left).toEqual(expect.arrayContaining(['Payroll scans', 'working notes.docx']));
    expect(existsSync(join(old, 'Payroll scans', 'march.pdf'))).toBe(true);
    expect(existsSync(join(old, 'working notes.docx'))).toBe(true);
    // Still there, because it is not empty and not ours to remove.
    expect(result.oldFolderRemoved).toBe(false);
    // Never copied anywhere either — moving a folder must not scatter files.
    expect(existsSync(join(root, 'new', 'working notes.docx'))).toBe(false);
  });

  it('does not claim a folder that merely looks like a company folder', () => {
    // Recognition is by the state file the exporter writes, not by having an
    // .xlsx in it. An accountant's own folder of spreadsheets is not ours.
    const old = join(root, 'old');
    mkdirSync(join(old, 'Client workpapers'), { recursive: true });
    writeFileSync(join(old, 'Client workpapers', 'ACME LTD.xlsx'), 'theirs', 'utf8');

    const result = moveExportData(old, join(root, 'new'));

    expect(result.left).toEqual(['Client workpapers']);
    expect(result.moved).toEqual([]);
    expect(existsSync(join(old, 'Client workpapers', 'ACME LTD.xlsx'))).toBe(true);
  });

  it('overwrites a same-named file already at the destination', () => {
    const old = join(root, 'old');
    const to = join(root, 'new');
    populate(old);
    mkdirSync(join(to, 'ACME LTD'), { recursive: true });
    writeFileSync(join(to, 'ACME LTD', 'ACME LTD.xlsx'), 'stale', 'utf8');

    moveExportData(old, to);

    expect(readFileSync(join(to, 'ACME LTD', 'ACME LTD.xlsx'), 'utf8')).toBe('current workbook');
  });

  it('is a no-op when the old folder has gone, rather than throwing', () => {
    const result = moveExportData(join(root, 'never-existed'), join(root, 'new'));
    expect(result).toEqual({ moved: [], left: [], failed: [], oldFolderRemoved: false });
  });

  it('creates the destination if it is not there yet', () => {
    const old = join(root, 'old');
    populate(old);
    const to = join(root, 'deep', 'nested', 'new');

    moveExportData(old, to);

    expect(existsSync(join(to, 'ACME LTD', 'ACME LTD.xlsx'))).toBe(true);
  });
});

describe('retiring the folder the export has left', () => {
  it('leaves a note saying the spreadsheet in there is frozen', () => {
    const old = join(root, 'old');
    mkdirSync(old);
    writeFileSync(join(old, 'ACME LTD.xlsx'), 'pretend workbook', 'utf8');

    expect(markFolderRetired(old, join(root, 'new'), new Date('2026-08-19T10:00:00'))).toBe(true);

    const note = readdirSync(old).find((name) => name.startsWith('THIS FOLDER IS NO LONGER'));
    expect(note).toBe('THIS FOLDER IS NO LONGER UPDATED - 2026-08-19.txt');

    const text = readFileSync(join(old, note ?? ''), 'utf8');
    // The three things it has to say, or it is not worth writing.
    expect(text).toMatch(/frozen/i);
    expect(text).toMatch(/do not point Claude at it/i);
    expect(text).toMatch(/NOTHING HAS BEEN DELETED/);
    // And where the export went, so this is a signpost rather than a dead end.
    expect(text).toContain(join(root, 'new'));
  });

  it('DELETES NOTHING — client data is never removed by the installer', () => {
    const old = join(root, 'old');
    mkdirSync(join(old, 'ACME LTD', 'Archive'), { recursive: true });
    writeFileSync(join(old, 'ACME LTD', 'ACME LTD.xlsx'), 'workbook', 'utf8');
    writeFileSync(join(old, 'ACME LTD', 'Archive', 'ACME LTD 2026-08-01 1800.xlsx'), 'old', 'utf8');
    writeFileSync(join(old, 'someone-elses-notes.docx'), 'not ours', 'utf8');

    markFolderRetired(old, join(root, 'new'), new Date());

    expect(existsSync(join(old, 'ACME LTD', 'ACME LTD.xlsx'))).toBe(true);
    expect(existsSync(join(old, 'ACME LTD', 'Archive', 'ACME LTD 2026-08-01 1800.xlsx'))).toBe(true);
    // A folder somebody chose may hold things we did not put there.
    expect(existsSync(join(old, 'someone-elses-notes.docx'))).toBe(true);
  });

  it('reports false rather than throwing when the old folder has gone', () => {
    // A drive that is not connected, or a folder already deleted. Failing to
    // leave a note must not fail the change of setting.
    expect(markFolderRetired(join(root, 'never-existed'), join(root, 'new'), new Date())).toBe(
      false
    );
  });
});
