import type { NestedRecord } from '../../tally/TallyResponseParser.js';
import type { CompanyData } from '../collect.js';

/**
 * Turning normalised records into sheets — and nothing else.
 *
 * ## Pure on purpose
 *
 * No TallyPrime access, no filesystem, no clock. Every function here takes
 * records and returns `{ title, columns, rows }`, so what a column MEANS can be
 * tested against hand-built records rather than against whatever a live company
 * happens to hold. That is the difference between a test that proves the
 * `Voucher entries` debit column is a debit and a test that proves the export
 * did not crash.
 *
 * ## Human-readable is a requirement, not a polish item
 *
 * Real column headings, not Tally's tag names: `Voucher number`, never
 * `VOUCHERNUMBER`. Someone opens this in Google Sheets and reads it; so does
 * Claude, and a heading is the only thing telling either of them what a column
 * is.
 */
import {
  isoDate,
  orderedVouchers,
  sheetName,
  type CellValue,
  type Column,
  type Table,
  byName,
} from './shared.js';

/**
 * Discovering the nested structures Tally sends, and the masters actually used.
 *
 * Split out of tables.ts at 1,309 lines. This is the part that does not know its
 * own shape in advance: what structures a company records is discovered from the
 * payload rather than declared here, so the tab list differs per company.
 */

/** One structure found in the tree, with every record of it. */
interface Discovered {
  /** Full path, e.g. `ALLINVENTORYENTRIES.LIST/BATCHALLOCATIONS.LIST`. */
  path: string;
  /** Where it hung from: the voucher itself, or a ledger line. */
  origin: 'voucher' | 'entry';
  rows: {
    voucher: CompanyData['vouchers'][number];
    /** The ledger line this hung from, for entry-level structures. */
    ledger: string | null;
    record: NestedRecord;
  }[];
}

/**
 * Names a reader recognises, for the structures that have one.
 *
 * Anything not listed keeps Tally's own tag, tidied — inventing a friendly name
 * for a structure nobody has looked at would be asserting a meaning. A tag is
 * honest; a wrong label is not.
 */
const FRIENDLY_NAMES: Record<string, string> = {
  'ALLINVENTORYENTRIES.LIST': 'Inventory lines',
  'INVENTORYENTRIES.LIST': 'Inventory lines',
  'BANKALLOCATIONS.LIST': 'Bank details',
  'BILLALLOCATIONS.LIST': 'Bill allocations',
  'GSTDETAILS.LIST': 'GST breakdown',
  'STATEWISEDETAILS.LIST': 'GST state detail',
  'RATEDETAILS.LIST': 'GST rate detail',
  'COSTCENTREALLOCATIONS.LIST': 'Cost centre allocations',
  'CATEGORYALLOCATIONS.LIST': 'Cost category allocations',
  'BATCHALLOCATIONS.LIST': 'Batch and godown',
  'ACCOUNTINGALLOCATIONS.LIST': 'Inventory accounting',
  'ADDRESS.LIST': 'Addresses',
  'BASICBUYERADDRESS.LIST': 'Buyer addresses',
  'BASICORDERTERMS.LIST': 'Order terms',
  'INVOICEDELNOTES.LIST': 'Delivery notes',
  'INVOICEORDERLIST.LIST': 'Order references',
  'BASICUSERDESCRIPTION.LIST': 'Line descriptions',
  'EWAYBILLDETAILS.LIST': 'E-way bill',
  'TAXOBJECTALLOCATIONS.LIST': 'Tax allocations',
};

/**
 * Is this structure TallyPrime's own plumbing rather than the company's books?
 *
 * Two families, both found by discovery on live data:
 *
 * - `PFTDLVERSIONINFO.LIST` — TDL version metadata. 571 rows on one company,
 *   describing Tally's own definition language, not a transaction.
 * - `UDF*` — user-defined fields, identified only by a numeric id such as
 *   `_UDF_553668230`. The VALUES may well be real company data, but nothing in
 *   the export can say what the field means, so nobody can read it.
 *
 * They are NOT dropped. "Everything TallyPrime holds" was the instruction, they
 * cost 0.4% of the file, and a field whose meaning is unknown to us may be
 * perfectly well known to whoever configured it. But they are labelled and sent
 * to the end of the tab order, so thirty rows of plumbing do not sit between
 * two tabs somebody needs.
 */
function isTallyInternal(tag: string): boolean {
  return /^PFTDLVERSIONINFO|^UDF/i.test(tag);
}

/** Turn a Tally tag into a tab name: `BATCHALLOCATIONS.LIST` → `Batch allocations`. */
function tabNameFor(tag: string): string {
  const known = FRIENDLY_NAMES[tag];
  if (known !== undefined) return known;

  const bare = tag.replace(/\.LIST$/i, '');
  return bare.charAt(0) + bare.slice(1).toLowerCase();
}

/**
 * Walk every voucher's nested tree and group the records by where they sit.
 *
 * Grouped by full PATH, not by tag: `BATCHALLOCATIONS.LIST` under an inventory
 * entry and one under something else are different things, and merging them
 * would produce a tab whose rows mean two different things.
 */
export function discoverNestedStructures(data: CompanyData): Discovered[] {
  const found = new Map<string, Discovered>();

  const record = (
    path: string,
    origin: 'voucher' | 'entry',
    voucher: CompanyData['vouchers'][number],
    ledger: string | null,
    item: NestedRecord
  ): void => {
    let entry = found.get(path);
    if (entry === undefined) {
      entry = { path, origin, rows: [] };
      found.set(path, entry);
    }
    entry.rows.push({ voucher, ledger, record: item });
  };

  const walk = (
    nested: Record<string, NestedRecord[]> | undefined,
    prefix: string,
    origin: 'voucher' | 'entry',
    voucher: CompanyData['vouchers'][number],
    ledger: string | null,
    depth: number
  ): void => {
    // The parser itself stops at five levels; matching that is a guard against
    // a cyclic structure rather than a limit anybody should hit.
    if (nested === undefined || depth > 5) return;

    for (const [tag, records] of Object.entries(nested)) {
      const path = prefix === '' ? tag : `${prefix}/${tag}`;
      for (const item of records) {
        record(path, origin, voucher, ledger, item);
        walk(item.nested, path, origin, voucher, ledger, depth + 1);
      }
    }
  };

  for (const voucher of orderedVouchers(data.vouchers)) {
    walk(voucher.nested, '', 'voucher', voucher, null, 0);
    for (const entry of voucher.entries) {
      walk(entry.nested, '', 'entry', voucher, entry.ledgerName, 0);
    }
  }

  // Sorted by path so the tab order is a property of the data rather than of
  // the order Tally happened to send it — with Tally's own plumbing last, so it
  // never sits between two tabs somebody needs.
  return [...found.values()].sort((a, b) => {
    const leafOf = (path: string): string => path.split('/').pop() ?? path;
    const internal = Number(isTallyInternal(leafOf(a.path))) - Number(isTallyInternal(leafOf(b.path)));
    if (internal !== 0) return internal;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/**
 * One tab per discovered structure.
 *
 * Tab names are deduplicated here rather than left to Excel, which does not
 * merely warn on a duplicate sheet name — the file fails to open.
 */
export function nestedStructureTables(data: CompanyData): Table[] {
  const taken = new Set<string>();

  return discoverNestedStructures(data).map((structure) => {
    const tags = structure.path.split('/');
    const leaf = tags[tags.length - 1] ?? structure.path;

    let title = sheetName(tabNameFor(leaf));
    if (taken.has(title.toLowerCase())) {
      // Qualify with the parent, which is what makes it a different thing.
      const parent = tags.length > 1 ? tabNameFor(tags[tags.length - 2] ?? '') : '';
      title = sheetName(`${title} (${parent})`);
    }
    for (let bump = 2; taken.has(title.toLowerCase()); bump += 1) {
      title = sheetName(`${tabNameFor(leaf)} ${String(bump)}`);
    }
    taken.add(title.toLowerCase());

    const keys = new Set<string>();
    for (const row of structure.rows) for (const key of Object.keys(row.record.fields)) keys.add(key);
    const columns = [...keys].sort();

    return {
      title,
      description:
        (isTallyInternal(leaf)
          ? "TALLYPRIME'S OWN PLUMBING, not the company's books — a field or version record " +
            'TallyPrime keeps for itself. Kept for completeness and for anyone who configured ' +
            'these fields and knows what they mean; nothing here can say what they mean. Not ' +
            'something to answer an accounting question from. '
          : '') +
        `Recorded inside each voucher under ${structure.path}` +
        (structure.origin === 'entry'
          ? ', which hangs off the LEDGER LINE — so the Ledger column names the line it belongs to.'
          : ', which hangs off the voucher itself.') +
        ' Keyed back to the voucher by GUID.',
      columns: [
        { header: 'Voucher date', kind: 'date' },
        { header: 'Voucher type', kind: 'text' },
        { header: 'Voucher number', kind: 'text' },
        { header: 'Ledger', kind: 'text' },
        { header: 'Voucher GUID', kind: 'text' },
        ...columns.map((key): Column => ({ header: key, kind: 'text' })),
      ],
      rows: structure.rows.map((row) => [
        isoDate(row.voucher.date),
        row.voucher.voucherType,
        row.voucher.voucherNumber,
        row.ledger,
        row.voucher.guid,
        ...columns.map((key) => row.record.fields[key] ?? null),
      ]),
    };
  });
}

/**
 * The cost centres, cost categories and godowns this company actually USES.
 *
 * ## Why this is derived rather than fetched
 *
 * TallyPrime holds these as master lists, and this server cannot read them: the
 * collection types are ones it has never observed, and probing an unobserved
 * type has twice parked TallyPrime behind a modal dialog until somebody
 * dismissed it. On a machine running an unattended export every minute that is
 * not a risk worth taking for a list of names.
 *
 * But the names are already in hand. Every cost centre allocation names its
 * cost centre; every batch allocation names its godown. So the list is built
 * from the transactions, at no extra cost and no risk at all.
 *
 * ## What this list is NOT
 *
 * It is not the master list, and the tab says so in its own description. A cost
 * centre that exists in TallyPrime but has never been used on a voucher in the
 * exported period does not appear here. Reading this as "the company has these
 * four cost centres" would be wrong in exactly the direction that matters —
 * absence here means unused, never non-existent.
 */
export function usedMastersTable(data: CompanyData): Table {
  const seen = new Map<string, { kind: string; name: string; count: number }>();

  const note = (kind: string, name: string | undefined): void => {
    const trimmed = (name ?? '').trim();
    if (trimmed === '') return;
    const key = `${kind} ${trimmed}`;
    const existing = seen.get(key);
    if (existing === undefined) seen.set(key, { kind, name: trimmed, count: 1 });
    else existing.count += 1;
  };

  for (const structure of discoverNestedStructures(data)) {
    const tags = structure.path.split('/');
    const leaf = tags[tags.length - 1] ?? '';

    for (const row of structure.rows) {
      const fields = row.record.fields;

      /*
       * Each record contributes each kind AT MOST ONCE.
       *
       * An earlier version noted the structure's own kind and then also swept
       * every record for GODOWNNAME and BATCHNAME — so a batch allocation, which
       * carries both, was counted twice and "times used" was double what it
       * should be. Caught by a test asserting the count of a godown used on two
       * batch lines, which read 4.
       */
      if (leaf === 'COSTCENTREALLOCATIONS.LIST') note('Cost centre', fields.NAME);
      else if (leaf === 'CATEGORYALLOCATIONS.LIST') note('Cost category', fields.CATEGORY ?? fields.NAME);

      // Read wherever they appear rather than only on the structure named for
      // them: a batch allocation names its godown, and so does an inventory
      // line on some voucher types.
      note('Godown', fields.GODOWNNAME);
      note('Batch', fields.BATCHNAME);
    }
  }

  const rows = [...seen.values()]
    .sort((a, b) => byName(a.kind, b.kind) || byName(a.name, b.name))
    .map((entry): CellValue[] => [entry.kind, entry.name, entry.count]);

  return {
    title: 'Used cost centres and godowns',
    description:
      'Cost centres, cost categories, godowns and batches THIS COMPANY ACTUALLY USED, built from ' +
      'the allocations recorded on its vouchers. NOT the master lists: TallyPrime does not serve ' +
      'those over this interface (see the "Not in this workbook" tab), so one that exists but has ' +
      'never been used on a voucher will not appear. Absence here means UNUSED, never ' +
      'non-existent.',
    columns: [
      { header: 'Kind', kind: 'text' },
      { header: 'Name', kind: 'text' },
      { header: 'Times used', kind: 'count' },
    ],
    rows,
    emptyMeans:
      'No voucher in this company allocates to a cost centre, a godown or a batch, so there is ' +
      'nothing to list. The company may still have such masters defined and unused — this is ' +
      'built from transactions, not from the master lists.',
  };
}
