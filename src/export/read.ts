import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reading the exported files back, from the machine they were written on.
 *
 * ## Why this exists
 *
 * The export has always been written for Google Drive to carry, and reading it
 * was Drive's job — so a folder that Drive does not sync produced an export
 * nobody could read. Every check passed: Setup said "Chosen", the scheduled
 * task ran, the workbook was real and current. Claude simply had no way to
 * reach it, and nothing anywhere said so.
 *
 * But the server runs on the SAME MACHINE that writes those files. It could
 * always have opened them. This module is that: the reading half, from disk,
 * needing no Drive, no account and no network.
 *
 * Drive remains worth using — it is what lets a colleague on another computer,
 * or Claude on the web, see the same books. It is now a SHARING choice rather
 * than the difference between working and silently broken.
 *
 * ## Why the CSVs and not the workbook
 *
 * The .xlsx is a zip of XML and costs six figures of tokens to hand over whole.
 * Beside it the export writes one CSV per tab plus an INDEX, precisely so a
 * reader can see what exists and then fetch the one table it needs. That is the
 * path taken here; the workbook is never opened.
 *
 * ## What this must never do
 *
 * Report a figure without saying when it was read. Every file here is a
 * SNAPSHOT — as at the last successful export, which may be minutes or days
 * old. A number from a stale file quoted as "now" is the failure this whole
 * export is otherwise careful to prevent, so `asAt` travels with every answer
 * and is never optional.
 */

/** The subfolder the per-tab CSVs live in. Must match `companyPaths`. */
const CSV_FOLDER = 'Tables (CSV)';

/** The catalogue a reader fetches first. */
const INDEX_FILE = 'INDEX.csv';

/** The tab carrying the company's identity, currency and as-at stamp. */
const MANIFEST_FILE = 'Manifest.csv';

/**
 * How much of one CSV may be read into memory.
 *
 * A guard, not a policy: the tables are small by design, and anything past this
 * means something has gone wrong rather than that somebody has a large company.
 * Refusing is better than a server that dies holding a 400MB string.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** One company's exported files, as found on disk. */
export interface ExportedCompany {
  /**
   * TallyPrime's own spelling, read from the Manifest.
   *
   * NOT the folder name. The folder is a sanitised label — illegal characters
   * replaced, length capped, collisions suffixed — and quoting it back at
   * somebody as their company name is how a client's books get cited under a
   * name they do not recognise.
   */
  company: string;
  /** The folder label, for a diagnostic line only. Never an identity. */
  folder: string;
  /** Absolute path to the `Tables (CSV)` folder. */
  csvFolder: string;
  /**
   * When TallyPrime was last successfully read for this company.
   *
   * Null when the Manifest does not carry it — an export from a version before
   * the stamp existed, or a file written by something else. Null means "unknown
   * age", which must be reported as such and never treated as fresh.
   */
  asAt: string | null;
  /** The currency label the Manifest records, for labelling figures. */
  currency: string | null;
}

/** One row of the INDEX: a table that can be fetched. */
export interface ExportedTable {
  file: string;
  rows: number;
  approxKb: number;
  description: string;
}

/**
 * Parse a CSV document the export wrote.
 *
 * Deliberately a real parser rather than `split(',')`. The exporter quotes any
 * field holding a comma, a quote or a newline — and ledger names, narrations
 * and addresses hold all three routinely. Splitting on commas would shift every
 * column after the first such field, which does not fail loudly: it produces a
 * table that looks fine and has amounts under the wrong headings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (char === '\n' || char === '\r') {
      // CRLF counts once.
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // Whatever the last line left unterminated. The exporter always writes a
  // trailing newline, so on its own files this adds nothing — it is here for
  // a file that has been through an editor that strips it.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Read a file, refusing anything implausibly large. */
function readGuarded(path: string): string {
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) {
    throw new Error(
      `The exported table at ${path} is ${String(Math.round(size / 1024 / 1024))}MB, which is far ` +
        'larger than an exported table should ever be. It was not read.\n\n' +
        'What to do: run the export again. If it stays this size, the file is not one the ' +
        'export wrote.'
    );
  }
  return readFileSync(path, 'utf8');
}

/**
 * Pull one value out of a Manifest by its label.
 *
 * Matched on a PREFIX, not on equality. The labels are prose written for a
 * human reader and they have been reworded between versions — "Company
 * (TallyPrime's own spelling...)" carries a parenthetical that may well change
 * again. A file on disk was written by whichever version was installed that
 * day, so an exact match would quietly stop finding the company name on older
 * exports and report them as anonymous.
 */
function manifestValue(rows: readonly string[][], labelPrefix: string): string | null {
  for (const row of rows) {
    // Manifest rows are [section, label, value].
    const label = row[1] ?? '';
    if (!label.startsWith(labelPrefix)) continue;
    const value = (row[2] ?? '').trim();
    return value === '' ? null : value;
  }
  return null;
}

/**
 * Every company the export folder holds.
 *
 * A folder counts as a company's only if it carries a readable Manifest. That
 * is the test rather than "is a subfolder", because the export folder is one a
 * person chose in a picker and may hold anything — someone's working papers, a
 * scans folder, last year's accounts. Treating those as companies would produce
 * entries that cannot be read and a list that lies about what is here.
 *
 * Returns an empty array when the export folder is absent or unreadable. That
 * is not an error at this level: an install with no export configured, or one
 * whose folder lives on a network drive that is not connected right now, is a
 * situation the CALLER has to explain in context — so it gets a plain empty
 * answer to interpret rather than an exception to catch.
 */
export function listExportedCompanies(exportFolder: string | undefined): ExportedCompany[] {
  if (exportFolder === undefined || exportFolder === '') return [];
  if (!existsSync(exportFolder)) return [];

  let entries: string[];
  try {
    entries = readdirSync(exportFolder);
  } catch {
    return [];
  }

  const found: ExportedCompany[] = [];

  for (const entry of entries) {
    const csvFolder = join(exportFolder, entry, CSV_FOLDER);
    const manifestPath = join(csvFolder, MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;

    let rows: string[][];
    try {
      rows = parseCsv(readGuarded(manifestPath));
    } catch {
      // A Manifest that cannot be read is not a company that can be answered
      // from. Leaving it out of the list is the honest answer; the caller then
      // falls back to TallyPrime rather than reading a file it cannot trust.
      continue;
    }

    const company = manifestValue(rows, 'Company (') ?? manifestValue(rows, 'Company');
    // No name means nothing here can be attributed to a company, and an
    // unattributable set of figures is worse than none.
    if (company === null) continue;

    found.push({
      company,
      folder: entry,
      csvFolder,
      asAt: manifestValue(rows, 'As at'),
      currency: manifestValue(rows, 'Currency'),
    });
  }

  // Sorted so the list is a property of what is on disk rather than of the
  // order the filesystem happened to return.
  return found.sort((a, b) => (a.company < b.company ? -1 : a.company > b.company ? 1 : 0));
}

/**
 * Find one company's exported files by name.
 *
 * Case-insensitive and trimmed, because the name reaching here came from a
 * person, or from Claude quoting a person, rather than from Tally's own bytes.
 * Exact matching on a typed name would leave a perfectly good local file unread
 * and fall through to TallyPrime for no reason.
 */
export function findExportedCompany(
  exportFolder: string | undefined,
  company: string | undefined
): ExportedCompany | null {
  const all = listExportedCompanies(exportFolder);

  if (company === undefined || company.trim() === '') {
    // One company in the folder is an unambiguous answer. Several is not, and
    // picking the first would describe the wrong client's books under no name
    // at all — the same trap `tally_get_company` avoids on the live path.
    return all.length === 1 ? (all[0] ?? null) : null;
  }

  const wanted = company.trim().toLowerCase();
  return all.find((entry) => entry.company.trim().toLowerCase() === wanted) ?? null;
}

/** The tables one company's export holds, from its INDEX. */
export function listExportedTables(target: ExportedCompany): ExportedTable[] {
  const indexPath = join(target.csvFolder, INDEX_FILE);
  if (!existsSync(indexPath)) return [];

  const rows = parseCsv(readGuarded(indexPath));
  // Row 0 is the header the exporter wrote.
  return rows.slice(1).flatMap((row) => {
    const file = (row[0] ?? '').trim();
    if (file === '') return [];
    return [
      {
        file,
        rows: Number.parseInt(row[1] ?? '', 10) || 0,
        approxKb: Number.parseInt(row[2] ?? '', 10) || 0,
        description: (row[3] ?? '').trim(),
      },
    ];
  });
}

/** One table read back, as headers plus rows. */
export interface ExportedTableData {
  file: string;
  columns: string[];
  rows: string[][];
  /** Rows in the file, whether or not they were all returned. */
  totalRows: number;
  /** True when `rows` holds fewer than `totalRows`. */
  truncated: boolean;
}

/**
 * Read one exported table.
 *
 * Paged, because a voucher-entries table on a real company runs to tens of
 * thousands of rows, and handing all of them back at once is how a response
 * ceiling gets hit at the boundary — where the failure is opaque and the whole
 * answer is lost rather than shortened.
 *
 * The filename is resolved through the INDEX rather than joined onto the path
 * directly. A name arriving from a caller is untrusted input, and `..\..\` in
 * it would otherwise read a file outside the export folder entirely.
 */
export function readExportedTable(
  target: ExportedCompany,
  file: string,
  options: { offset?: number; limit?: number } = {}
): ExportedTableData {
  const wanted = file.trim().toLowerCase();
  const known = listExportedTables(target).find((entry) => entry.file.toLowerCase() === wanted);

  if (known === undefined) {
    throw new Error(
      `This company's export has no table named "${file}".\n\n` +
        'What to do: list the tables first and use a name exactly as it appears there.'
    );
  }

  const parsed = parseCsv(readGuarded(join(target.csvFolder, known.file)));
  const columns = parsed[0] ?? [];
  const body = parsed.slice(1);

  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? 500);
  const page = body.slice(offset, offset + limit);

  return {
    file: known.file,
    columns,
    rows: page,
    totalRows: body.length,
    truncated: offset + page.length < body.length,
  };
}
