import { Decimal } from 'decimal.js';
import type { NestedRecord } from '../tally/TallyResponseParser.js';
import type { Money } from '../utils/numbers.js';
import { foldUniformFields } from '../utils/uniformFields.js';
import type { CompanyData } from './collect.js';

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

/** What one cell can hold. `null` is "Tally reported nothing", never zero. */
export type CellValue = string | number | Decimal | Date | boolean | null;

/** How a column is written into the workbook, and therefore how it reads back. */
export type ColumnKind =
  /** Text, forced to text so a ledger name beginning `=` is never a formula. */
  | 'text'
  /** Money. A number with `#,##0.00`, so a column can be summed. */
  | 'amount'
  /** A plain count. A number with no decimals. */
  | 'count'
  /** A real date with `yyyy-mm-dd`, so no locale reads 03/04 as March. */
  | 'date'
  /** A timestamp Tally wrote, kept as TEXT — see `Voucher entries` below. */
  | 'stamp'
  /** Yes/No. Written as text so a filter shows both values. */
  | 'flag';

export interface Column {
  header: string;
  kind: ColumnKind;
}

export interface Table {
  /** The sheet name. Must already satisfy Excel's rules — see `sheetName`. */
  title: string;
  /** One line for the Contents tab. What this tab holds, in plain words. */
  description: string;
  columns: Column[];
  rows: CellValue[][];
  /**
   * Said on the Contents tab when the tab is empty, so an empty tab is an
   * ANSWER rather than a gap. Null where emptiness needs no explanation.
   */
  emptyMeans?: string;
}

/**
 * Excel's sheet-name rules, applied once.
 *
 * 31 characters, and none of `[ ] : * ? / \`. A name breaking either is not a
 * warning in Excel — the file fails to open, which is the whole workbook lost
 * over a tab title.
 */
export function sheetName(title: string): string {
  const cleaned = title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return cleaned.length > 31 ? cleaned.slice(0, 31).trim() : cleaned;
}

/**
 * Row order, decided here rather than inherited from TallyPrime.
 *
 * ## Why this is not left alone
 *
 * Measured on a real workbook, Tally's own order is already reasonable —
 * vouchers came back chronologically and ledgers in case-SENSITIVE alphabetical
 * order, which is why `CASHBACK` sorted above `Cash Withdrawal`. So this is not
 * fixing a mess.
 *
 * It is about two things Tally's order cannot give:
 *
 * - **Determinism.** TallyPrime is not promised to return records in a stable
 *   order — `fingerprint.ts` already builds its digest on that basis. If the
 *   order shifted, two archive copies of identical books would differ
 *   everywhere, and comparing yesterday's workbook with today's would be
 *   useless for spotting what actually changed.
 * - **Reading it.** `CASHBACK` filed away from `Cash Withdrawal` is exactly the
 *   sort of thing that makes someone conclude a ledger is missing.
 *
 * ## What is deliberately NOT sorted
 *
 * The statement tabs — trial balance, profit and loss, balance sheet — and the
 * closing-stock reports. Their row order IS the presentation: Capital Account,
 * then Loans, then Current Liabilities, in the sequence a balance sheet is read.
 * Re-sorting those alphabetically would destroy the meaning of the document and
 * scatter each group away from its own subtotal.
 */

/**
 * Compare names the way a person reads a list: case-insensitively, but with a
 * deterministic tiebreak so two names differing only in case never swap places
 * between runs.
 */
function byName(a: string | null, b: string | null): number {
  const left = a ?? '';
  const right = b ?? '';
  const natural = left.localeCompare(right, 'en', { sensitivity: 'base', numeric: true });
  if (natural !== 0) return natural;
  // Exact comparison as the tiebreak. Without it `Sales` and `SALES` order
  // arbitrarily, and arbitrarily can mean differently on the next run.
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The voucher order every voucher-derived tab uses.
 *
 * Shared on purpose. `Vouchers`, `Voucher entries` and the five detail tabs all
 * key back to the same GUIDs, so a reader scrolling two tabs side by side is
 * entitled to find them in the same sequence — and three separate sorts would
 * eventually disagree.
 *
 * Date first, because that is how anybody reads a register. GUID last as the
 * tiebreak, since it is the only field guaranteed unique: without it, two
 * vouchers sharing a date and number would order arbitrarily.
 */
export function orderedVouchers(vouchers: readonly CompanyData['vouchers'][number][]): CompanyData['vouchers'] {
  return [...vouchers].sort((a, b) => {
    const date = (a.date ?? '').localeCompare(b.date ?? '');
    if (date !== 0) return date;
    const number = byName(a.voucherNumber, b.voucherNumber);
    if (number !== 0) return number;
    return byName(a.guid, b.guid);
  });
}

/** A `Money` as a decimal, or null. Null is not zero and must not become one. */
function amount(money: Money | null | undefined): Decimal | null {
  if (money === null || money === undefined) return null;
  try {
    return new Decimal(money.amount);
  } catch {
    // An amount Tally sent that will not parse is reported as absent rather
    // than as zero. A zero here would be a figure nobody wrote.
    return null;
  }
}

/** An ISO date string as a real Date, or null. */
function isoDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Tally's Yes/No, as the words rather than a checkbox. */
function flag(value: boolean): string {
  return value ? 'Yes' : 'No';
}

// ---------------------------------------------------------------------------
// The books
// ---------------------------------------------------------------------------

export function trialBalanceTable(data: CompanyData): Table {
  return {
    title: 'Trial balance',
    description:
      "TallyPrime's own Trial Balance. Debit and credit columns as Tally reports them — see " +
      'the Manifest for the sign convention and for the stock-at-opening caveat.',
    columns: [
      { header: 'Name', kind: 'text' },
      { header: 'Debit', kind: 'amount' },
      { header: 'Credit', kind: 'amount' },
    ],
    rows: (data.trialBalance.rows as { name: string; debit: Money | null; credit: Money | null }[]).map(
      (row) => [row.name, amount(row.debit), amount(row.credit)]
    ),
  };
}

export function ledgerBalancesTable(data: CompanyData): Table {
  return {
    title: 'Ledger balances',
    description:
      'Every ledger with its group and its opening and closing balance, from the ledger ' +
      'MASTERS. A negative balance is a debit in Tally\'s own encoding, passed through.',
    columns: [
      { header: 'Ledger', kind: 'text' },
      { header: 'Parent group', kind: 'text' },
      { header: 'Opening balance', kind: 'amount' },
      { header: 'Closing balance', kind: 'amount' },
      { header: 'Currency', kind: 'text' },
      { header: 'GSTIN', kind: 'text' },
      { header: 'Marked related party in Tally', kind: 'flag' },
    ],
    rows: [...data.ledgers].sort((a, b) => byName(a.name, b.name)).map((ledger) => [
      ledger.name,
      ledger.parent,
      amount(ledger.openingBalance),
      amount(ledger.closingBalance),
      ledger.closingBalance?.currency ?? ledger.openingBalance?.currency ?? data.currency.label,
      ledger.gstin,
      flag(ledger.isRelatedParty),
    ]),
  };
}

/**
 * Voucher-level fields that vary on THIS company, discovered rather than listed.
 *
 * Which fields a company populates is a property of the company — one with GST
 * configured carries GST fields, a payroll company carries payroll fields — so
 * the columns cannot be hardcoded. The uniform ones are relocated to the
 * `Tally defaults` tab, which is what makes this a fold rather than a filter.
 */
function varyingFieldKeys(records: readonly { fields?: Record<string, string> }[]): {
  keys: string[];
  uniform: Record<string, string>;
} {
  const fold = foldUniformFields(
    records,
    (record) => record.fields,
    (record, fields) => ({ ...record, fields })
  );

  const keys = new Set<string>();
  for (const record of fold.records) {
    for (const key of Object.keys(record.fields ?? {})) keys.add(key);
  }

  return { keys: [...keys].sort(), uniform: fold.uniformFields };
}

export function vouchersTable(data: CompanyData): Table {
  const { keys } = varyingFieldKeys(data.vouchers);
  const vouchers = orderedVouchers(data.vouchers);

  return {
    title: 'Vouchers',
    description:
      'One row per voucher. The four exclusion flags decide which vouchers belong in which ' +
      'question — read the Manifest before totalling this tab.',
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher type', kind: 'text' },
      { header: 'Voucher number', kind: 'text' },
      { header: 'Party', kind: 'text' },
      { header: 'Narration', kind: 'text' },
      { header: 'Entry lines', kind: 'count' },
      // The four traps. Named in full because a reader has to be able to filter
      // on them without knowing Tally's vocabulary.
      { header: 'Cancelled', kind: 'flag' },
      { header: 'Optional', kind: 'flag' },
      { header: 'Order voucher', kind: 'flag' },
      { header: 'Inventory voucher', kind: 'flag' },
      { header: 'Last written', kind: 'stamp' },
      { header: 'GUID', kind: 'text' },
      ...keys.map((key): Column => ({ header: key, kind: 'text' })),
    ],
    rows: vouchers.map((voucher) => [
      isoDate(voucher.date),
      voucher.voucherType,
      voucher.voucherNumber,
      voucher.partyLedgerName,
      voucher.narration,
      voucher.entries.length,
      flag(voucher.isCancelled),
      flag(voucher.isOptional),
      flag(voucher.isOrderVoucher),
      flag(voucher.isInventoryVoucher),
      voucher.lastWrittenAt,
      voucher.guid,
      ...keys.map((key) => voucher.fields?.[key] ?? null),
    ]),
  };
}

export function voucherEntriesTable(data: CompanyData): Table {
  const rows: CellValue[][] = [];

  // Same voucher order as the Vouchers tab. Entries WITHIN a voucher keep the
  // order Tally recorded them in — that is the order they were posted, and
  // re-sorting them would separate a debit from the credit it pairs with.
  for (const voucher of orderedVouchers(data.vouchers)) {
    for (const entry of voucher.entries) {
      const value = amount(entry.amount);
      // Split into two columns from Tally's OWN debit flag, not from the sign
      // of the amount. The two agree in every response observed, but the flag
      // is what Tally treats as authoritative — and a column derived from a
      // sign would silently disagree the first time they part company.
      const debit = entry.side === 'debit' ? value : null;
      const credit = entry.side === 'credit' ? value : null;

      rows.push([
        isoDate(voucher.date),
        voucher.voucherType,
        voucher.voucherNumber,
        entry.ledgerName,
        debit,
        credit,
        value,
        voucher.lastWrittenAt,
        flag(voucher.isCancelled),
        flag(voucher.isOptional),
        voucher.guid,
      ]);
    }
  }

  return {
    title: 'Voucher entries',
    description:
      'One row per LEDGER LINE — this is the expense and income detail. Debit and credit are ' +
      "split from Tally's own debit flag; \"Amount\" is the signed figure Tally sent, unmodified.",
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher type', kind: 'text' },
      { header: 'Voucher number', kind: 'text' },
      { header: 'Ledger', kind: 'text' },
      { header: 'Debit', kind: 'amount' },
      { header: 'Credit', kind: 'amount' },
      { header: 'Amount as Tally sent it', kind: 'amount' },
      // Text, not a date: Tally writes `YYYY-MM-DDTHH:MM:SS` with no timezone,
      // and turning it into a Date would attach one that nobody recorded.
      { header: 'Last written', kind: 'stamp' },
      { header: 'Voucher cancelled', kind: 'flag' },
      { header: 'Voucher optional', kind: 'flag' },
      { header: 'Voucher GUID', kind: 'text' },
    ],
    rows,
  };
}

function outstandingTable(
  title: string,
  description: string,
  side: CompanyData['receivables']
): Table {
  // Bucket labels come from the first party that has any. They are the same
  // boundaries for every party — computed once in executeOutstanding — so
  // reading them off one row is not a guess.
  const bucketLabels =
    side.rows.find((row) => row.ageing !== undefined)?.ageing?.buckets.map((b) => b.label) ?? [];

  return {
    title,
    description,
    columns: [
      { header: 'Party', kind: 'text' },
      { header: 'Group', kind: 'text' },
      { header: 'Closing balance', kind: 'amount' },
      { header: 'Bills recorded', kind: 'count' },
      ...bucketLabels.map((label): Column => ({ header: label, kind: 'amount' })),
      // The admitted gaps, carried as columns rather than buried. A bucket row
      // that silently omitted undated bills would read as a complete schedule.
      { header: 'Could not be aged (no date)', kind: 'amount' },
      { header: 'On account (no bill reference)', kind: 'amount' },
    ],
    rows: [...side.rows].sort((a, b) => byName(a.party, b.party)).map((row) => {
      const byLabel = new Map(
        (row.ageing?.buckets ?? []).map((bucket) => [bucket.label, amount(bucket.amount)])
      );
      return [
        row.party,
        row.group,
        amount(row.closingBalance),
        row.bills.length,
        ...bucketLabels.map((label) => byLabel.get(label) ?? null),
        amount(row.ageing?.undated.amount),
        amount(row.ageing?.unreferenced.amount),
      ];
    }),
    emptyMeans:
      'No ledgers were filed under the groups this side uses. That means the company files ' +
      'its parties elsewhere, not that it has none — see the Manifest warnings.',
  };
}

export function receivablesTable(data: CompanyData): Table {
  return outstandingTable(
    'Receivables',
    'Money owed TO the company, per party, with a bucketed ageing schedule. The buckets are ' +
      'BILL AGE, not days overdue — the Manifest states the basis and its coverage limit.',
    data.receivables
  );
}

export function payablesTable(data: CompanyData): Table {
  return outstandingTable(
    'Payables',
    'Money the company OWES, per party, with a bucketed ageing schedule. The buckets are ' +
      'BILL AGE, not days overdue — the Manifest states the basis and its coverage limit.',
    data.payables
  );
}

function statementTable(
  title: string,
  description: string,
  statement: CompanyData['profitLoss']
): Table {
  return {
    title,
    description,
    columns: [
      { header: 'Name', kind: 'text' },
      { header: 'Amount', kind: 'amount' },
      { header: 'Sub-amount', kind: 'amount' },
    ],
    rows: (statement.rows as { name: string; amount: Money | null; subAmount: Money | null }[]).map(
      (row) => [row.name, amount(row.amount), amount(row.subAmount)]
    ),
  };
}

export function profitLossTable(data: CompanyData): Table {
  return statementTable(
    'Profit and loss',
    'As TallyPrime presents it. Income arrives positive and expenses negative — Tally\'s own ' +
      'encoding, preserved. Nothing here is recomputed.',
    data.profitLoss
  );
}

export function balanceSheetTable(data: CompanyData): Table {
  return statementTable(
    'Balance sheet',
    'As TallyPrime presents it. Liabilities arrive positive and assets negative — Tally\'s own ' +
      'encoding, preserved. Nothing here is recomputed.',
    data.balanceSheet
  );
}

// ---------------------------------------------------------------------------
// The detail inside vouchers
// ---------------------------------------------------------------------------

/**
 * Every nested structure any voucher actually carries — found, not listed.
 *
 * ## Why this replaced a hardcoded list
 *
 * There used to be five detail tabs, each naming the Tally tags it assembled.
 * That was wrong in two ways at once, and both were invisible until the tree
 * was actually walked on live data (2026-08-20, AgEx Pharma):
 *
 * - **It only looked one level deep.** `BATCHALLOCATIONS.LIST` — which is where
 *   the GODOWN on a stock movement lives — hangs off an inventory ENTRY, not
 *   off the voucher. Forty-two of them were being dropped on a company with 42
 *   inventory lines in the workbook.
 * - **It only knew the tags somebody had thought of.** The same company also
 *   carried `ADDRESS.LIST`, `BASICBUYERADDRESS.LIST`, `BASICORDERTERMS.LIST`,
 *   `INVOICEDELNOTES.LIST` and `INVOICEORDERLIST.LIST` — delivery addresses,
 *   order terms, delivery notes — none of them in any tab.
 *
 * Which structures a company records is a property of the COMPANY, exactly as
 * the field set is. So this discovers them the same way `varyingFieldKeys`
 * discovers columns: walk what arrived, and give every structure a tab.
 *
 * The cost is nothing. These records were already fetched and parsed; the old
 * code simply threw most of them away.
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

// ---------------------------------------------------------------------------
// The masters
// ---------------------------------------------------------------------------

export function ledgersTable(data: CompanyData): Table {
  const { keys } = varyingFieldKeys(data.ledgers);

  return {
    title: 'Ledgers',
    description:
      'The ledger masters with every field that VARIES on this company. Fields holding one ' +
      'value on every ledger are on the Tally defaults tab — relocated, never dropped.',
    columns: [
      { header: 'Ledger', kind: 'text' },
      { header: 'Parent group', kind: 'text' },
      ...keys.map((key): Column => ({ header: key, kind: 'text' })),
    ],
    rows: [...data.ledgers].sort((a, b) => byName(a.name, b.name)).map((ledger) => [
      ledger.name,
      ledger.parent,
      ...keys.map((key) => ledger.fields?.[key] ?? null),
    ]),
  };
}

export function groupsTable(data: CompanyData): Table {
  return {
    title: 'Groups',
    description:
      'The chart of accounts. "Revenue group" is what makes a group a profit-and-loss group ' +
      'rather than a balance sheet one.',
    columns: [
      { header: 'Group', kind: 'text' },
      { header: 'Parent group', kind: 'text' },
      { header: 'Revenue group', kind: 'flag' },
      { header: 'Deemed positive in Tally', kind: 'flag' },
    ],
    rows: [...data.groups].sort((a, b) => byName(a.name, b.name)).map((group) => [
      group.name,
      group.parent,
      flag(group.isRevenue),
      flag(group.isDeemedPositive),
    ]),
  };
}

export function voucherTypesTable(data: CompanyData): Table {
  const rows: CellValue[][] = [];

  for (const type of [...data.voucherTypes].sort((a, b) => byName(a.name, b.name))) {
    if (type.numberingSeries.length === 0) {
      rows.push([type.name, type.parent, flag(type.isDeemedPositive), null, null, null, null]);
      continue;
    }
    for (const series of type.numberingSeries) {
      rows.push([
        type.name,
        type.parent,
        flag(type.isDeemedPositive),
        series.name,
        series.method,
        series.subMethod,
        flag(series.preventsDuplicates),
      ]);
    }
  }

  return {
    title: 'Voucher types',
    description:
      'One row per numbering series. "Family" is the built-in type this one derives from — a ' +
      'company may call its sales type anything, and only the family identifies it.',
    columns: [
      { header: 'Voucher type', kind: 'text' },
      { header: 'Family', kind: 'text' },
      { header: 'Deemed positive in Tally', kind: 'flag' },
      { header: 'Numbering series', kind: 'text' },
      { header: 'Numbering method', kind: 'text' },
      { header: 'Numbering sub-method', kind: 'text' },
      { header: 'Tally prevents duplicates', kind: 'flag' },
    ],
    rows,
  };
}

export function stockItemsTable(data: CompanyData): Table {
  const { keys } = varyingFieldKeys(data.stockItems);

  return {
    title: 'Stock items',
    description:
      'The stock masters. Quantities are strings WITH their unit, exactly as Tally formats ' +
      'them — a bare stock number without its unit is meaningless. Do not multiply quantity ' +
      'by rate; use the value column, which is Tally\'s own.',
    columns: [
      { header: 'Stock item', kind: 'text' },
      { header: 'Parent', kind: 'text' },
      { header: 'Base units', kind: 'text' },
      { header: 'Opening quantity', kind: 'text' },
      { header: 'Closing quantity', kind: 'text' },
      { header: 'Opening value', kind: 'amount' },
      { header: 'Closing value', kind: 'amount' },
      { header: 'Closing rate (rounded)', kind: 'text' },
      ...keys.map((key): Column => ({ header: key, kind: 'text' })),
    ],
    rows: [...data.stockItems].sort((a, b) => byName(a.name, b.name)).map((item) => [
      item.name,
      item.parent,
      item.baseUnits,
      item.openingBalance,
      item.closingBalance,
      amount(item.openingValue),
      amount(item.closingValue),
      item.closingRate,
      ...keys.map((key) => item.fields[key] ?? null),
    ]),
    emptyMeans:
      'This company does not maintain inventory. That is NOT a stock position of zero.',
  };
}

export function currenciesTable(data: CompanyData): Table {
  return {
    title: 'Currencies',
    description:
      'Every currency this company defines. The symbol may read "?" — TallyPrime substitutes ' +
      'it before the bytes leave, so the NAME column is the reliable one.',
    columns: [
      { header: 'Symbol', kind: 'text' },
      { header: 'Name', kind: 'text' },
      { header: 'Decimal places', kind: 'text' },
    ],
    rows: [...data.currencies].sort((a, b) => byName(a.name, b.name)).map((currency) => [
      currency.name,
      currency.formalName,
      currency.decimalPlaces,
    ]),
  };
}

export function closingStockTable(data: CompanyData): Table {
  return {
    title: 'Closing stock',
    description:
      `${data.closingStock.basis}, by ${data.closingStock.groupedBy}. A DIFFERENT BASIS from ` +
      'the Stock items tab, which reads the masters — say which you are quoting.',
    columns: [
      { header: data.closingStock.groupedBy, kind: 'text' },
      { header: 'Closing quantity', kind: 'text' },
      { header: 'Closing rate (rounded)', kind: 'text' },
      { header: 'Closing value', kind: 'amount' },
    ],
    rows: data.closingStock.rows.map((row) => [
      row.name,
      row.closingQuantity,
      row.closingRate,
      amount(row.closingValue),
    ]),
    emptyMeans:
      'This company does not maintain inventory. That is NOT a stock position of zero.',
  };
}

export function godownsTable(data: CompanyData): Table | null {
  if (data.godowns === null) return null;

  return {
    title: 'Godowns',
    description:
      `${data.godowns.basis}, by ${data.godowns.groupedBy}. Stock by storage location — the ` +
      'only location-wise view this interface can read.',
    columns: [
      { header: data.godowns.groupedBy, kind: 'text' },
      { header: 'Closing quantity', kind: 'text' },
      { header: 'Closing rate (rounded)', kind: 'text' },
      { header: 'Closing value', kind: 'amount' },
    ],
    rows: data.godowns.rows.map((row) => [
      row.name,
      row.closingQuantity,
      row.closingRate,
      amount(row.closingValue),
    ]),
    emptyMeans:
      'This company records no stock against any storage location. That is NOT a stock ' +
      'position of zero.',
  };
}

/**
 * One statement across every book year, with a Year column.
 *
 * ## Why a series rather than one tab per year
 *
 * Five years times three statements is fifteen tabs on a workbook that already
 * has thirty-five, and comparing them would mean scrolling between sheets. A
 * Year column makes "how did the gross margin move" a filter rather than a
 * hunt, and it keeps the tab count flat as the books get older.
 *
 * ## The row order is Tally's, within each year
 *
 * Same reason the single-year statement tabs are not sorted: the sequence IS the
 * document. So this groups by year — oldest first, the way a comparative is
 * read — and leaves each year's rows exactly as Tally presented them.
 *
 * A year TallyPrime could not serve is simply absent from the series, and the
 * warning saying so is on the Manifest. That is why the Year column matters
 * more than it looks: a missing year is visible as a gap in the values, not as
 * an empty row somebody has to notice.
 */
export function statementByYearTable(
  title: string,
  description: string,
  series: CompanyData['statementsByYear'],
  pick: (entry: CompanyData['statementsByYear'][number]) => CompanyData['trialBalance'] | null,
  columns: { header: string; from: (row: Record<string, Money | null>) => Money | null }[]
): Table {
  const rows: CellValue[][] = [];

  for (const entry of series) {
    const statement = pick(entry);
    if (statement === null) continue;

    for (const raw of statement.rows as (Record<string, Money | null> & { name: string })[]) {
      rows.push([
        `${entry.year.fromDate} to ${entry.year.toDate}`,
        entry.isCurrent ? 'Yes' : 'No',
        raw.name,
        ...columns.map((column) => amount(column.from(raw))),
      ]);
    }
  }

  return {
    title,
    description,
    columns: [
      { header: 'Book year', kind: 'text' },
      { header: 'Current year', kind: 'flag' },
      { header: 'Name', kind: 'text' },
      ...columns.map((column): Column => ({ header: column.header, kind: 'amount' })),
    ],
    rows,
    emptyMeans:
      'No book year could be read for this statement. That is a FAILURE rather than an absence ' +
      'of trading — check the Manifest warnings.',
  };
}

/** The three by-year series, with the columns each statement carries. */
export function statementsByYearTables(data: CompanyData): Table[] {
  const YEAR_NOTE =
    ' One row per line per BOOK YEAR, oldest first. Each year was requested with its own end ' +
    'date, which TallyPrime honours because a book year always ends on the 31st of a month. ' +
    'Figures for a prior year were NOT cross-checked against the ledger masters, because those ' +
    'describe the position today rather than then.';

  return [
    statementByYearTable(
      'Trial balance by year',
      "TallyPrime's own Trial Balance for every book year." + YEAR_NOTE,
      data.statementsByYear,
      (entry) => entry.trialBalance,
      [
        { header: 'Debit', from: (row) => row.debit ?? null },
        { header: 'Credit', from: (row) => row.credit ?? null },
      ]
    ),
    statementByYearTable(
      'Profit and loss by year',
      "TallyPrime's own Profit and Loss for every book year." + YEAR_NOTE,
      data.statementsByYear,
      (entry) => entry.profitLoss,
      [
        { header: 'Amount', from: (row) => row.amount ?? null },
        { header: 'Sub-amount', from: (row) => row.subAmount ?? null },
      ]
    ),
    statementByYearTable(
      'Balance sheet by year',
      "TallyPrime's own Balance Sheet for every book year." + YEAR_NOTE,
      data.statementsByYear,
      (entry) => entry.balanceSheet,
      [
        { header: 'Amount', from: (row) => row.amount ?? null },
        { header: 'Sub-amount', from: (row) => row.subAmount ?? null },
      ]
    ),
  ];
}

// ---------------------------------------------------------------------------
// TallyPrime's own report views
// ---------------------------------------------------------------------------

/**
 * A monthly flow report — cash flow or funds flow.
 *
 * The `Net` column is TALLY'S OWN, passed through rather than recomputed, and
 * it is not the same arithmetic on both reports: observed live it is
 * debit + credit on cash flow, and credit − debit on funds flow, where the two
 * columns are the month's opening and closing funds. Recomputing it here would
 * silently be wrong on one of them.
 */
export function monthlyFlowTable(
  title: string,
  description: string,
  statement: CompanyData['cashFlow']
): Table | null {
  if (statement === null) return null;

  return {
    title,
    description,
    columns: [
      { header: 'Month', kind: 'text' },
      { header: 'Debit', kind: 'amount' },
      { header: 'Credit', kind: 'amount' },
      { header: "Net (Tally's own figure)", kind: 'amount' },
    ],
    // Tally's own row order — the months in sequence. Sorting alphabetically
    // would file April before January and make the report unreadable.
    rows: (
      statement.rows as {
        period: string;
        debit: Money | null;
        credit: Money | null;
        net: Money | null;
      }[]
    ).map((row) => [row.period, amount(row.debit), amount(row.credit), amount(row.net)]),
    emptyMeans:
      'TallyPrime returned no rows for this report on this company. The report is valid, so ' +
      'this is an absence of data rather than a failure.',
  };
}

/**
 * One of TallyPrime's register or exception views, as it produced it.
 *
 * ## The column names are Tally's tag names, deliberately
 *
 * Everywhere else in this workbook the headings are rewritten into English.
 * Not here. These reports' column MEANINGS have never been verified — several
 * return nothing on every company measured so far — so renaming `DSPCLDRAMTA`
 * to "Debit" would be asserting something nobody has checked. The tag name is
 * honest about what it is, and the Contents tab says so.
 */
export function genericReportTable(entry: CompanyData['reports'][number]): Table {
  const rows = entry.report.rows as { name: string; amounts: Record<string, string> }[];

  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.amounts)) keys.add(key);
  const columns = [...keys].sort();

  return {
    title: entry.title,
    description:
      `${entry.report.what} From TallyPrime's own "${entry.report.reportId}" report` +
      (entry.report.verified === 'empty'
        ? ' — ROW SHAPE UNVERIFIED: Tally accepts this report but returned nothing on every ' +
          'company tested, so its column meanings have never been observed. Check any figure ' +
          'here against the report on screen in TallyPrime before relying on it.'
        : '.') +
      " Column names are TallyPrime's own tag names, not renamed columns: say which tag a " +
      'figure came from rather than calling it a debit or a credit.',
    columns: [
      { header: 'Name', kind: 'text' },
      // Amounts as TEXT, not numbers. Which of these columns is money and which
      // is a quantity, a rate or a count is exactly what is unverified — writing
      // them as numbers would invite a total nobody can justify.
      ...columns.map((key): Column => ({ header: key, kind: 'text' })),
    ],
    rows: rows.map((row) => [row.name, ...columns.map((key) => row.amounts[key] ?? null)]),
    emptyMeans:
      'TallyPrime returned no rows. For a register that means no transactions of that kind in ' +
      'the period; for an exception report it means nothing was flagged; for a feature the ' +
      'company does not use — bill-wise accounting, inventory, cost categories — it means the ' +
      'feature is unused. It does NOT mean the figure is zero.',
  };
}

/**
 * The real master lists — cost centres, units, godowns and their kin.
 *
 * These are the genuine article, unlike the "Used cost centres and godowns" tab
 * derived from voucher allocations. A cost centre that exists in TallyPrime and
 * has never been posted to appears HERE and not there, which is exactly the
 * distinction that tab has to disclaim and this one does not.
 *
 * Unreachable until 2026-08-21 — see `normalizeSimpleMasters` for what changed
 * and what is still off limits.
 */
export function simpleMasterTables(data: CompanyData): Table[] {
  return data.simpleMasters.map((entry) => {
    const keys = new Set<string>();
    for (const record of entry.records) for (const key of Object.keys(record.fields)) keys.add(key);
    const columns = [...keys].sort();

    return {
      title: entry.title,
      description:
        `TallyPrime's own ${entry.title.toLowerCase()} master list, read from the ${entry.type} ` +
        'collection. This is the DEFINED list — unlike the "Used cost centres and godowns" tab, ' +
        'which is built from voucher allocations and therefore shows only what has been posted ' +
        'to.',
      columns: [
        { header: 'Name', kind: 'text' },
        { header: 'Parent', kind: 'text' },
        ...columns.map((key): Column => ({ header: key, kind: 'text' })),
      ],
      rows: [...entry.records]
        .sort((a, b) => byName(a.name, b.name))
        .map((record) => [
          record.name,
          record.parent,
          ...columns.map((key) => record.fields[key] ?? null),
        ]),
      emptyMeans:
        `This company defines no ${entry.title.toLowerCase()}. TallyPrime served the list and it ` +
        'was empty — the feature is unused, which is NOT the same as the read having failed. A ' +
        'failed read would say so in the Manifest warnings.',
    };
  });
}

// ---------------------------------------------------------------------------
// Tally defaults
// ---------------------------------------------------------------------------

/**
 * The fields carrying the same value on every record of a collection.
 *
 * This is the tab that makes the rest readable, and it is a RELOCATION rather
 * than a filter: every value Tally sent is still in the workbook, written once
 * instead of repeated down 200 columns. Measured on a real company's year, 453
 * vouchers carried 204 populated fields of which only 33 varied — the other 171
 * were `ISDELETED: No`, `AUDITED: No`, `USEFORSERVICETAX: No` and their kind.
 *
 * `foldUniformFields` folds nothing below two records, since with one record
 * every field is trivially uniform. On such a company these values stay on the
 * record's own tab instead, which is correct and is why the note below says to
 * check both places.
 */
export function tallyDefaultsTable(data: CompanyData): Table {
  const rows: CellValue[][] = [];

  const sources: [string, readonly { fields?: Record<string, string> }[]][] = [
    ['Vouchers', data.vouchers],
    ['Ledgers', data.ledgers],
    ['Stock items', data.stockItems],
  ];

  for (const [what, records] of sources) {
    const { uniform } = varyingFieldKeys(records);
    for (const [key, value] of Object.entries(uniform).sort(([a], [b]) => a.localeCompare(b))) {
      rows.push([what, key, value, records.length]);
    }
  }

  return {
    title: 'Tally defaults',
    description:
      'Fields holding ONE value on every record of a tab, written once here instead of ' +
      'repeated on every row. They ARE present on every record in TallyPrime — look here ' +
      'before concluding a field is absent. A constant value is usually a TallyPrime default ' +
      "rather than something this company recorded, so it rarely answers a question about the " +
      "company's data.",
    columns: [
      { header: 'Tab', kind: 'text' },
      { header: 'Field', kind: 'text' },
      { header: 'Value on every record', kind: 'text' },
      { header: 'Records it applies to', kind: 'count' },
    ],
    rows,
    emptyMeans:
      'Nothing was uniform enough to relocate — every field varied, or a tab held fewer than ' +
      'two records (below which nothing is folded, since with one record every field is ' +
      'trivially uniform).',
  };
}

/**
 * What TallyPrime holds that this interface cannot read.
 *
 * Without this tab the workbook implies it is everything, and someone will read
 * a silence as a zero. Sourced from docs/coverage.md.
 */
export function notInThisWorkbookTable(): Table {
  return {
    title: 'Not in this workbook',
    description:
      'What TallyPrime holds that this interface cannot read, and why. Read this before ' +
      'concluding that something absent from the workbook does not exist in the books.',
    columns: [
      { header: 'What is missing', kind: 'text' },
      { header: 'Why', kind: 'text' },
    ],
    rows: [
      [
        "Anything dated before the company's books start",
        'The voucher tabs cover EVERY book year TallyPrime holds for this company, not just the ' +
          'current one — years before the current one are read from the Voucher Register report, ' +
          'which honours a date range where a collection does not. What is absent is only what ' +
          'the company itself does not hold: see "Company books start" on the Manifest, and ' +
          '"Dates actually seen on vouchers" for the span really present.',
      ],
      [
        'A book year TallyPrime could not serve in time',
        'A prior year is read from a report running to tens of megabytes and can time out. When ' +
          'that happens the year is EXCLUDED, and a warning saying which years were lost appears ' +
          'on the Manifest. Check those warnings before reading a quiet year as a year with no ' +
          'trading.',
      ],
      [
        'Statements for anything but the current book year',
        'TallyPrime honours a statement end date only when it falls on the 31st of a month, so ' +
          'the trial balance, profit and loss and balance sheet cover the current book year ' +
          'only. The voucher tabs reach further back; the statements do not, and tying the two ' +
          'together would compare figures covering different spans.',
      ],
      [
        'The edit log / audit trail',
        'Not served over this interface. The "Last written" stamp on Vouchers and Voucher ' +
          'entries is the LAST write, and cannot distinguish a voucher keyed in late from one ' +
          'keyed on time and altered later, nor say who wrote it.',
      ],
      [
        'Cost Centre Summary report',
        'TallyPrime accepts the report ID but has returned no rows on every company tested, so ' +
          'its row shape has never been observed. The Cost centre allocations tab carries what ' +
          'the vouchers themselves record.',
      ],
      [
        'Cost centre, cost category and godown MASTER lists',
        'Reachable only through a TallyPrime collection type this server has never observed, and ' +
          'probing an unobserved type has twice parked TallyPrime behind a modal dialog until ' +
          'somebody dismissed it. On a machine running an unattended export every minute that is ' +
          'not an acceptable risk. Cost centre ALLOCATIONS recorded on vouchers are present, on ' +
          'their own tab.',
      ],
      [
        'Budgets',
        'Both the Budget Variance and Budgets reports are rejected by TallyPrime, and the ' +
          'collection type is unknown and cannot be probed for the reason above. ' +
          'Budget-versus-actual cannot be answered from this workbook.',
      ],
      [
        'The licence edition',
        'Not exposed over this interface. Which TallyPrime edition produced these books cannot ' +
          'be read from the data.',
      ],
    ],
  };
}
