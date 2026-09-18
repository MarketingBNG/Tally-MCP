import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toCsv, csvIndex, csvFileName } from '../../src/export/csv.js';
import type { Table } from '../../src/export/tables.js';
import { registerExportedBookTools } from '../../src/tools/exportedBooks.js';
import {
  MockTallyServer,
  callToolError,
  callToolOk,
  createToolRegistry,
  makeDeps,
} from './harness.js';

/**
 * The tools that answer with TallyPrime closed.
 *
 * These read files and never touch Tally, which is the whole point: the export
 * used to be readable only through Google Drive, so anyone who picked a local
 * folder in Setup got an export that ran perfectly and that Claude could not
 * open. Nothing reported a problem, because nothing was checking.
 *
 * What is tested here is mostly not "does it return the rows" — the reader's
 * own tests cover that against the real writer. It is the things that make a
 * snapshot safe to quote: that the age travels with every answer, and that an
 * empty or ambiguous folder produces an explanation somebody can act on rather
 * than a bare "no data".
 */

const created: string[] = [];

afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

function table(title: string, columns: string[], rows: string[][]): Table {
  return {
    title,
    description: `${title} rows`,
    columns: columns.map((header) => ({ header, kind: 'text' as const })),
    rows,
  };
}

function manifest(company: string, asAt: string): Table {
  return table(
    'Manifest',
    ['Section', 'Item', 'Value'],
    [
      ['Company', "Company (TallyPrime's own spelling — quote THIS, not the folder name)", company],
      ['Company', 'Currency', '$'],
      ['Company', 'As at (last successful read from TallyPrime)', asAt],
    ]
  );
}

/** Build an export folder holding the given companies, and a registry over it. */
function setup(companies: { company: string; asAt: string; tables?: Table[] }[]): {
  registry: ReturnType<typeof createToolRegistry>;
  folder: string;
} {
  const folder = mkdtempSync(join(tmpdir(), 'tally-books-'));
  created.push(folder);

  for (const entry of companies) {
    const tables = [manifest(entry.company, entry.asAt), ...(entry.tables ?? [])];
    const csvFolder = join(folder, entry.company.replace(/[\\/:*?"<>|]/g, '-'), 'Tables (CSV)');
    mkdirSync(csvFolder, { recursive: true });
    writeFileSync(join(csvFolder, 'INDEX.csv'), csvIndex(tables), 'utf8');
    for (const one of tables) {
      writeFileSync(join(csvFolder, csvFileName(one.title)), toCsv(one), 'utf8');
    }
  }

  return { registry: registryFor(folder), folder };
}

/**
 * A port nothing is listening on, so the client is real and TallyPrime is shut.
 *
 * This is the strong form of the claim these tools make. A stubbed client would
 * pass even if a tool secretly depended on Tally answering; a real client with
 * nowhere to connect means every figure below was produced with Tally closed,
 * which is the situation the whole exported-files path exists for.
 */
const CLOSED_TALLY_PORT = 65243;

function registryFor(exportFolder: string | undefined): ReturnType<typeof createToolRegistry> {
  const registry = createToolRegistry();
  // The real config loader, so the response ceiling and every other default is
  // the one the shipped server uses rather than one invented here.
  registerExportedBookTools(
    registry.server,
    makeDeps(CLOSED_TALLY_PORT, {
      ...(exportFolder === undefined ? {} : { TALLY_EXPORT_FOLDER: exportFolder }),
    })
  );
  return registry;
}

/** An as-at stamp a given number of hours before now. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe('falling back to the live books', () => {
  /**
   * The fallback exists because the files cannot answer everything — a company
   * nobody has exported, a period they do not reach. What is tested here is not
   * that Tally answers, but that the ADVICE matches reality: sending somebody to
   * open TallyPrime when it is already open wastes their time on the wrong
   * thing, and offering the live books when Tally is shut offers nothing.
   */
  it('points at the live books when TallyPrime is answering', async () => {
    const mock = new MockTallyServer();
    // The liveness probe asks for the company list; anything parseable is a
    // Tally that is answering, which is all this test turns on.
    mock.onBodyContaining('List of Companies', {
      body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
    });
    const port = await mock.start();

    try {
      const folder = mkdtempSync(join(tmpdir(), 'tally-none-'));
      created.push(folder);

      const registry = createToolRegistry();
      registerExportedBookTools(
        registry.server,
        makeDeps(port, { TALLY_EXPORT_FOLDER: folder })
      );

      const error = await callToolError(registry, 'tally_list_exported_books');

      expect(error.suggestion).toMatch(/TallyPrime IS open/);
      // And the durable repair is still named, because the live route does not
      // restore answering once Tally is closed again.
      expect(error.suggestion).toMatch(/export has not run yet/);
    } finally {
      await mock.stop();
    }
  });

  it('asks for TallyPrime to be opened, saying it was tried more than once', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tally-shut-'));
    created.push(empty);

    const error = await callToolError(registryFor(empty), 'tally_list_exported_books');

    // "Could not reach TallyPrime" alone invites the suspicion that it was
    // checked at the wrong moment, so the count is part of the message.
    expect(error.suggestion).toMatch(/tried 3 times/);
    expect(error.suggestion).toMatch(/open TallyPrime/i);
  });

  it('does not offer a fallback when the ambiguity is which company was meant', async () => {
    const { registry } = setup([
      { company: 'Alpha Ltd', asAt: hoursAgo(1) },
      { company: 'Beta Ltd', asAt: hoursAgo(1) },
    ]);

    const error = await callToolError(registry, 'tally_read_exported_table', {});

    // The live books would be no less ambiguous, so sending the user to Tally
    // would be advice that cannot help. Naming both companies can.
    expect(error.suggestion).not.toMatch(/TallyPrime IS open|open TallyPrime/i);
    expect(error.suggestion).toContain('Alpha Ltd');
  });
});

describe('listing the exported books on this computer', () => {
  it('reports each company with its age, without contacting TallyPrime', async () => {
    const { registry } = setup([{ company: 'Books Ltd', asAt: hoursAgo(2) }]);

    const data = await callToolOk(registry, 'tally_list_exported_books');
    const companies = data.companies as { company: string; freshness: string }[];

    expect(companies).toHaveLength(1);
    expect(companies[0]?.company).toBe('Books Ltd');
    // The age is the load-bearing part: a figure quoted as "now" from a file
    // written on Tuesday is the failure this whole path has to avoid.
    expect(companies[0]?.freshness).toMatch(/Quote figures as at that moment/);
    expect(data.notice).toMatch(/not from live TallyPrime/);
  });

  it('calls out a snapshot old enough that the export has probably stopped', async () => {
    const { registry } = setup([{ company: 'Books Ltd', asAt: hoursAgo(72) }]);

    const data = await callToolOk(registry, 'tally_list_exported_books');
    const companies = data.companies as { freshness: string }[];

    expect(companies[0]?.freshness).toMatch(/^STALE/);
    expect(companies[0]?.freshness).toMatch(/3 day\(s\) ago/);
  });

  it('explains an export that was never set up', async () => {
    const error = await callToolError(registryFor(undefined), 'tally_list_exported_books');

    expect(error.code).toBe('EXPORT_NOT_CONFIGURED');
    // Setup, or open Tally. Both are things the person can actually do.
    expect(error.suggestion).toMatch(/Run Setup/);
  });

  it('names the folder when it is configured but holds nothing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tally-empty-'));
    created.push(empty);

    const error = await callToolError(registryFor(empty), 'tally_list_exported_books');

    expect(error.code).toBe('EXPORT_NO_COMPANIES');
    // Naming it is what lets somebody check the right folder — and a drive that
    // is not connected looks identical to one that was emptied.
    expect(error.message).toContain(empty);
    expect(error.suggestion).toMatch(/not connected/);
  });
});

describe('reading a table from the exported books', () => {
  it('returns the catalogue when no table is named', async () => {
    const { registry } = setup([
      {
        company: 'Books Ltd',
        asAt: hoursAgo(1),
        tables: [table('Ledgers', ['Name'], [['A'], ['B']])],
      },
    ]);

    const data = await callToolOk(registry, 'tally_read_exported_table', {
      company: 'Books Ltd',
    });

    const tables = data.tables as { file: string; rows: number }[];
    expect(tables.find((entry) => entry.file === 'Ledgers.csv')?.rows).toBe(2);
  });

  it('returns the rows with the as-at stamp attached', async () => {
    const asAt = hoursAgo(1);
    const { registry } = setup([
      {
        company: 'Books Ltd',
        asAt,
        tables: [table('Ledgers', ['Name', 'Balance'], [['Smith, Jones & Co', '1000.00']])],
      },
    ]);

    const data = await callToolOk(registry, 'tally_read_exported_table', {
      company: 'Books Ltd',
      table: 'Ledgers.csv',
    });

    expect(data.rows).toEqual([['Smith, Jones & Co', '1000.00']]);
    expect(data.asAt).toBe(asAt);
    // Currency travels too — this project has already shipped dollars labelled
    // as rupees once.
    expect(data.currency).toBe('$');
  });

  it('refuses to guess which company when several are exported', async () => {
    const { registry } = setup([
      { company: 'Alpha Ltd', asAt: hoursAgo(1) },
      { company: 'Beta Ltd', asAt: hoursAgo(1) },
    ]);

    const error = await callToolError(registry, 'tally_read_exported_table', {});

    expect(error.code).toBe('EXPORT_COMPANY_NOT_FOUND');
    // Both names, so the next call can be right rather than another guess.
    expect(error.suggestion).toContain('Alpha Ltd');
    expect(error.suggestion).toContain('Beta Ltd');
  });

  it('lists what is available when the named company is not here', async () => {
    const { registry } = setup([{ company: 'Alpha Ltd', asAt: hoursAgo(1) }]);

    const error = await callToolError(registry, 'tally_read_exported_table', {
      company: 'Gamma Ltd',
    });

    expect(error.code).toBe('EXPORT_COMPANY_NOT_FOUND');
    expect(error.message).toContain('Gamma Ltd');
    expect(error.suggestion).toContain('Alpha Ltd');
  });
});
