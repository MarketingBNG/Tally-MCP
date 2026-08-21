import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { MockTallyServer, fixture, makeDeps } from '../tools/harness.js';
import { runExport } from '../../src/export/run.js';
import { collectCompany } from '../../src/export/collect.js';

/**
 * A whole export, against the mock, with the fixtures the tool tests use.
 *
 * This is the test that would catch a tab wired to the wrong fetch, a workbook
 * that will not open, or a run that reports success having written nothing —
 * none of which the pure table tests can see, because they never leave memory.
 */

let mock: MockTallyServer;
let port: number;
let folder: string;

const COMPANY = 'EXAMPLE TRADING PRIVATE LIMITED';

/**
 * The company list, with a book year that CONTAINS the day-book fixture.
 *
 * Written here rather than taken from `company-list.xml`, whose year runs
 * 2021-22 while the voucher fixture is dated 2026. The export takes no period
 * argument — it exports the company's own year — so with the shipped fixture
 * every voucher is correctly filtered out and the tab is legitimately empty,
 * which would make this test prove nothing about the voucher path.
 */
const COMPANY_LIST = [
  '<ENVELOPE><BODY><DATA><COLLECTION>',
  `<COMPANY NAME="${COMPANY}" RESERVEDNAME="">`,
  `<NAME TYPE="String">${COMPANY}</NAME>`,
  '<STARTINGFROM TYPE="Date">20260401</STARTINGFROM>',
  '<ENDINGAT TYPE="Date">20260731</ENDINGAT>',
  '<CURRENCYNAME TYPE="String">$</CURRENCYNAME>',
  '<COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>',
  '</COMPANY>',
  '</COLLECTION></DATA></BODY></ENVELOPE>',
].join('');

function serve(): void {
  mock.reset();
  // Order matters only in that later registrations win; each of these matches a
  // distinct request, keyed on the collection or report the request names.
  mock.onBodyContaining('List of Companies', { body: COMPANY_LIST });
  mock.onBodyContaining('VoucherAlterIds', { body: '<ENVELOPE><VOUCHER><MASTERID>1</MASTERID><ALTERID>7</ALTERID></VOUCHER></ENVELOPE>' });
  mock.onBodyContaining('LedgerAlterIds', { body: '<ENVELOPE><LEDGER><MASTERID>2</MASTERID><ALTERID>3</ALTERID></LEDGER></ENVELOPE>' });
  mock.onBodyContaining('Trial Balance', { body: fixture('trial-balance.xml') });
  mock.onBodyContaining('Profit and Loss', { body: fixture('profit-loss.xml') });
  mock.onBodyContaining('Balance Sheet', { body: fixture('balance-sheet.xml') });
  mock.onBodyContaining('Stock Summary', { body: fixture('stock-summary.xml') });
  mock.onBodyContaining('Godown Summary', { body: fixture('godown-summary.xml') });
  mock.onBodyContaining('<TYPE>Group</TYPE>', { body: fixture('groups.xml') });
  mock.onBodyContaining('<TYPE>VoucherType</TYPE>', { body: fixture('voucher-types.xml') });
  mock.onBodyContaining('<TYPE>StockItem</TYPE>', { body: fixture('stock-items-populated.xml') });
  mock.onBodyContaining('<TYPE>Ledger</TYPE>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('day-book.xml') });
  mock.onBodyContaining('<TYPE>Currency</TYPE>', { body: '<ENVELOPE></ENVELOPE>' });
}

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
  folder = mkdtempSync(join(tmpdir(), 'tally-e2e-'));
});

afterAll(async () => {
  await mock.stop();
  rmSync(folder, { recursive: true, force: true });
});

describe('collecting one company', () => {
  it('reads every part of the books through the tools\' own fetch paths', async () => {
    serve();
    const data = await collectCompany(makeDeps(port), COMPANY, new Date('2026-08-19T12:00:00Z'));

    // Tally's own spelling, which is what the Manifest quotes.
    expect(data.company.name).toBe(COMPANY);
    expect(data.vouchers.length).toBeGreaterThan(0);
    expect(data.ledgers.length).toBeGreaterThan(0);
    expect(data.trialBalance.rows.length).toBeGreaterThan(0);
    expect(data.balanceSheet.rows.length).toBeGreaterThan(0);
  });
});

describe('a whole run', () => {
  it('writes a workbook that opens, under a folder named for the company', async () => {
    serve();
    const deps = makeDeps(port, { TALLY_EXPORT_FOLDER: folder });
    const outcomes = await runExport(deps, deps.config, [COMPANY], new Date());

    expect(outcomes[0]?.status).toBe('exported');
    expect(outcomes[0]?.rows).toBeGreaterThan(0);

    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(outcomes[0]?.workbookPath ?? '');

    const names: string[] = [];
    book.eachSheet((sheet) => names.push(sheet.name));

    // The two tabs without which the rest is unreadable, first and second.
    expect(names[0]).toBe('Contents');
    expect(names[1]).toBe('Manifest');
    expect(names).toEqual(
      expect.arrayContaining([
        'Trial balance',
        'Voucher entries',
        'Vouchers',
        'Tally defaults',
        'Not in this workbook',
      ])
    );
  });

  it('leaves the status file, the log, the state and one archive copy', () => {
    const companyFolder = join(folder, COMPANY);
    const entries = readdirSync(companyFolder);

    expect(entries.some((name) => name.startsWith('LAST RUN OK'))).toBe(true);
    expect(entries).toContain('run-log.txt');
    expect(entries).toContain('export-state.json');
    expect(readdirSync(join(companyFolder, 'Archive'))).toHaveLength(1);
  });

  it('does NO work and writes NO file when nothing changed', async () => {
    serve();
    const deps = makeDeps(port, { TALLY_EXPORT_FOLDER: folder });
    const before = readdirSync(join(folder, COMPANY, 'Archive')).length;

    const outcomes = await runExport(deps, deps.config, [COMPANY], new Date());

    expect(outcomes[0]?.status).toBe('unchanged');
    expect(outcomes[0]?.workbookPath).toBeNull();
    expect(readdirSync(join(folder, COMPANY, 'Archive'))).toHaveLength(before);
  });

  it('exports again once a voucher DISAPPEARS — the case a maximum cannot see', async () => {
    serve();
    // The highest ALTERID is unchanged; a record simply stopped existing. A
    // fingerprint built on the maximum would report "nothing changed" here and
    // keep serving a voucher that is gone.
    mock.onBodyContaining('VoucherAlterIds', {
      body:
        '<ENVELOPE><VOUCHER><MASTERID>1</MASTERID><ALTERID>7</ALTERID></VOUCHER>' +
        '<VOUCHER><MASTERID>9</MASTERID><ALTERID>4</ALTERID></VOUCHER></ENVELOPE>',
    });

    const deps = makeDeps(port, { TALLY_EXPORT_FOLDER: folder });
    const added = await runExport(deps, deps.config, [COMPANY], new Date());
    expect(added[0]?.status).toBe('exported');

    // Now remove the record that is NOT the maximum. Maximum: still 7.
    mock.onBodyContaining('VoucherAlterIds', {
      body: '<ENVELOPE><VOUCHER><MASTERID>1</MASTERID><ALTERID>7</ALTERID></VOUCHER></ENVELOPE>',
    });

    const removed = await runExport(deps, deps.config, [COMPANY], new Date());
    expect(removed[0]?.status).toBe('exported');
    expect(removed[0]?.reason).toMatch(/books changed/);
  });

  it('refuses a company TallyPrime does not have open, by name', async () => {
    serve();
    const deps = makeDeps(port, { TALLY_EXPORT_FOLDER: folder });
    await expect(runExport(deps, deps.config, ['NOT A COMPANY LTD'], new Date())).resolves.toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });

  it('names the failure plainly when the workbook cannot be replaced', async () => {
    serve();
    const deps = makeDeps(port, { TALLY_EXPORT_FOLDER: folder, TALLY_EXPORT_FORCE: 'true' });

    // Stand something in the workbook's place that a rename cannot overwrite.
    // The point is the MESSAGE: an accountant has to be able to act on it.
    const workbook = join(folder, COMPANY, `${COMPANY}.xlsx`);
    rmSync(workbook, { force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(workbook, { recursive: true });
    writeFileSync(join(workbook, 'in the way.txt'), 'x', 'utf8');

    const outcomes = await runExport(deps, deps.config, [COMPANY], new Date());

    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.reason).toBe('the workbook is open in Excel');

    // The previous run's data is KEPT rather than thrown away, and the folder
    // says what happened without anyone opening a file.
    const entries = readdirSync(join(folder, COMPANY));
    expect(entries.some((name) => name.startsWith('LAST RUN FAILED'))).toBe(true);
    expect(entries.some((name) => name.startsWith('Could not replace'))).toBe(true);
  });

  it('leaves ONE kept file however many times the replacement is blocked', async () => {
    // The bug this pins: the kept file used to carry a timestamp. The books
    // still differ from the last successful export, so every minute retries,
    // fails identically, and leaves another ~250KB file. Measured before the
    // fix: two files in two minutes. Over a working day with the workbook left
    // open in Excel that is ~1,400 files and ~350MB, every one syncing to Drive.
    serve();
    const deps = makeDeps(port, { TALLY_EXPORT_FOLDER: folder, TALLY_EXPORT_FORCE: 'true' });
    const companyFolder = join(folder, COMPANY);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Re-block it each time: a successful run would clear the obstruction.
      const workbook = join(companyFolder, `${COMPANY}.xlsx`);
      rmSync(workbook, { force: true, recursive: true });
      const { mkdirSync } = await import('node:fs');
      mkdirSync(workbook, { recursive: true });
      writeFileSync(join(workbook, 'in the way.txt'), 'x', 'utf8');

      await runExport(deps, deps.config, [COMPANY], new Date());
    }

    const kept = readdirSync(companyFolder).filter((name) => name.startsWith('Could not replace'));
    expect(kept).toHaveLength(1);
  });

  it('always leaves exactly ONE status file, replacing any earlier one', async () => {
    // Two things pinned here. First, the folder must never accumulate status
    // files — the name carries the outcome and the time, so it changes every
    // run. Second, and the reason the order matters: the new one is written
    // BEFORE the old ones are removed. Clearing first and then failing to write
    // would leave the folder saying nothing at all, at exactly the moment
    // somebody is looking at it wondering what happened.
    serve();
    const deps = makeDeps(port, { TALLY_EXPORT_FOLDER: folder, TALLY_EXPORT_FORCE: 'true' });
    const companyFolder = join(folder, COMPANY);

    // Clear the obstruction an earlier test in this file leaves behind, so this
    // one is about the status file rather than about that.
    rmSync(join(companyFolder, `${COMPANY}.xlsx`), { force: true, recursive: true });

    // A stale one from a run that happened days ago.
    writeFileSync(
      join(companyFolder, 'LAST RUN FAILED - TallyPrime was not open - 2020-01-01 0900.txt'),
      'stale',
      'utf8'
    );

    await runExport(deps, deps.config, [COMPANY], new Date());

    const status = readdirSync(companyFolder).filter((name) => name.startsWith('LAST RUN '));
    expect(status).toHaveLength(1);
    expect(status[0]).toMatch(/^LAST RUN OK/);
  });

  it('refuses to run at all with no export folder configured', async () => {
    const deps = makeDeps(port);
    await expect(runExport(deps, deps.config, [COMPANY], new Date())).rejects.toThrow(
      /No export folder is configured/
    );
  });
});
