import { join } from 'node:path';

/**
 * Turning a TallyPrime company name into a Windows folder name.
 *
 * A company name is Tally's text and Windows folder names are not. Four things
 * go wrong, and each of them is a real install failing on a client's name
 * rather than a hypothetical:
 *
 * - **Illegal characters.** `\ / : * ? " < > |` cannot appear in a Windows path
 *   component, and a trailing dot or space is silently stripped by the shell in
 *   some places and rejected in others. `AGBV Nutrition GmbH - (from 1-Jan-24)`
 *   happens to be legal; the next client's name may not be.
 * - **Reserved device names.** `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9` and
 *   `LPT1`-`LPT9` cannot be folder names at all, with or without an extension.
 * - **Path length.** Company folder + `Archive\` + a dated filename repeating
 *   the company name can pass 260 characters inside a deep Drive path.
 * - **Collision.** Two companies can sanitise to the same folder. That is the
 *   failure that mixes two clients' books in one place, so the second gets a
 *   disambiguating suffix rather than overwriting the first.
 *
 * ## The folder name is not the company name
 *
 * Once sanitised it is a LABEL. Tally's exact spelling is what the Manifest
 * carries and what a reader or Claude should quote. Nothing in this file may be
 * used to identify a company back to TallyPrime.
 */

/** Characters Windows refuses in a path component. */
// eslint-disable-next-line no-control-regex -- control characters are precisely what Windows rejects here
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Device names Windows reserves, with or without an extension. */
const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${String(i + 1)}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${String(i + 1)}`),
]);

/**
 * How much of a company name a folder may carry.
 *
 * Not a Windows rule — a budget. The dated archive filename repeats the name
 * inside the folder that already carries it, so the name is effectively spent
 * twice; capping the folder leaves room for the rest of the path.
 */
const MAX_FOLDER_NAME = 80;

/** How much of a company name a FILENAME may carry. Shorter, for the same reason. */
const MAX_FILE_NAME = 60;

/**
 * Windows' classic path limit. Long-path support exists but is off by default
 * on most machines and cannot be relied on in an accounting office.
 */
export const MAX_PATH = 260;

/**
 * Sanitise one company name into a path component.
 *
 * Returns the label only — collision handling needs to see every company at
 * once and lives in `assignFolderNames` below.
 */
export function sanitiseComponent(name: string, maxLength = MAX_FOLDER_NAME): string {
  let value = name.replace(ILLEGAL, '-');

  // Collapse the runs a replacement can create, so "A: B" does not become
  // "A- B" on one name and "A-- B" on a near-identical one.
  value = value.replace(/-{2,}/g, '-').replace(/\s{2,}/g, ' ').trim();

  // Trailing dots and spaces are stripped by Windows itself, which would make
  // two distinct names collide invisibly. Strip them here so the collision is
  // visible to the code that resolves collisions.
  value = value.replace(/[. ]+$/, '');

  if (value.length > maxLength) {
    value = value.slice(0, maxLength).replace(/[. ]+$/, '');
  }

  // A reserved device name is refused whatever follows a dot, so the guard is
  // on the stem rather than the whole string.
  const stem = value.split('.')[0]?.toUpperCase() ?? '';
  if (RESERVED.has(stem)) value = `${value} (company)`;

  // A name made entirely of illegal characters survives the steps above as a
  // string of separators — `///` becomes `-`, which is a LEGAL folder name and
  // therefore worse than an empty one: it would be created, silently, and read
  // as a label. So the test is for a name with nothing in it worth reading, not
  // merely for an empty string. The Manifest inside carries the real name.
  if (!/[\p{L}\p{N}]/u.test(value)) value = 'Company';

  return value;
}

/**
 * Assign one folder name per company, resolving collisions deterministically.
 *
 * ## The suffix must not depend on the order Tally listed them
 *
 * It used to be the company's POSITION in the caller's list. That is a trap:
 * TallyPrime is not promised to return its company list in a stable order — the
 * fingerprint code is built on exactly that assumption — so two companies whose
 * names collide could swap positions between runs and therefore SWAP FOLDERS.
 * Client A's books would start being written into the folder holding client B's,
 * which is precisely the failure this collision handling exists to prevent.
 *
 * So the names are sorted first, and the suffix comes from the position in that
 * sorted order. The same SET of companies now yields the same mapping however
 * Tally happened to list them.
 */
export function assignFolderNames(companyNames: readonly string[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const taken = new Set<string>();

  // Sorted, so the mapping is a property of the set rather than of the order it
  // arrived in. Plain code-point order: it only has to be deterministic and
  // locale-independent, not pretty.
  const ordered = [...companyNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  ordered.forEach((name, index) => {
    const base = sanitiseComponent(name);
    let candidate = base;
    // Still colliding means two names differ only in something sanitising
    // erased. Walk until free rather than overwrite: a folder holding the wrong
    // client's books is worse than an ugly name.
    let bump = index;
    while (taken.has(candidate.toLowerCase())) {
      bump += 1;
      candidate = sanitiseComponent(`${base} (${String(bump)})`);
    }
    taken.add(candidate.toLowerCase());
    assigned.set(name, candidate);
  });

  return assigned;
}

/** Filename-safe local timestamp: `2026-08-19 1805`. */
export function stampFor(when: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}${pad(when.getMinutes())}`
  );
}

/** The paths one company's output occupies under the export folder. */
export interface CompanyPaths {
  folder: string;
  workbook: string;
  /**
   * The smaller companion holding the current book year only.
   *
   * Named "…- current year only.xlsx" rather than taking over the plain name.
   * The plain name has always meant the whole history, and quietly narrowing
   * what it contains is how somebody answers a question about last year from a
   * file that no longer has it.
   */
  currentYearWorkbook: string;
  /**
   * Where the per-tab CSVs go — a SUBFOLDER, not the company folder.
   *
   * Thirty-five loose .csv files beside the workbook would bury the two files a
   * person actually opens. These are for a reader fetching one table at a time.
   */
  csvFolder: string;
  archiveFolder: string;
  archiveWorkbook: string;
  statePath: string;
  logPath: string;
  lockPath: string;
  /** The folder LABEL, for a log line. Never the company's identity. */
  label: string;
}

/**
 * Where one company's output goes.
 *
 * Throws with a plain message when the archive path would exceed Windows'
 * limit. That is deliberate: an opaque OS error at rename time, after a
 * twenty-second fetch, is the worst place to discover a path problem.
 */
export function companyPaths(
  exportFolder: string,
  companyName: string,
  folderLabel: string,
  when: Date
): CompanyPaths {
  const folder = join(exportFolder, folderLabel);
  const fileStem = sanitiseComponent(companyName, MAX_FILE_NAME);
  const workbook = join(folder, `${fileStem}.xlsx`);
  const currentYearWorkbook = join(folder, `${fileStem} - current year only.xlsx`);
  const csvFolder = join(folder, 'Tables (CSV)');
  const archiveFolder = join(folder, 'Archive');
  const archiveWorkbook = join(archiveFolder, `${fileStem} ${stampFor(when)}.xlsx`);

  if (archiveWorkbook.length > MAX_PATH) {
    throw new Error(
      `The folder you chose is too deep for this company's name. The archive copy would need ` +
        `${String(archiveWorkbook.length)} characters and Windows allows ${String(MAX_PATH)}.\n\n` +
        `What to do: pick an export folder closer to the top of the drive — something like ` +
        `C:\\TallyExports or a short folder inside Google Drive — and run Setup again.\n\n` +
        `The path it tried to use was:\n  ${archiveWorkbook}`
    );
  }

  return {
    folder,
    workbook,
    currentYearWorkbook,
    csvFolder,
    archiveFolder,
    archiveWorkbook,
    statePath: join(folder, 'export-state.json'),
    logPath: join(folder, 'run-log.txt'),
    lockPath: join(folder, 'export.lock'),
    label: folderLabel,
  };
}
