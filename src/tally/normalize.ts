import { tallyDateToIso } from '../utils/dates.js';
import { toMoney, type Money } from '../utils/numbers.js';
import { TallyError } from './TallyError.js';
import {
  attributesOf,
  childText,
  childrenNamed,
  findAll,
  findFirst,
  isLivenessResponse,
  nestedRecordsOf,
  pairReportRows,
  parseTallyXml,
  scalarFieldsOf,
  textOf,
  assertNoTallyError,
  type NestedRecord,
  type PairedRow,
  type TallyNode,
} from './TallyResponseParser.js';

/**
 * Domain normalisation: Tally's XML shapes to the records tools return.
 *
 * Every function here follows the same two rules.
 *
 * **Sign is preserved, never corrected.** Tally's trial balance reports debit
 * balances as negative and P&L expenses as negative. That is Tally's own
 * encoding of the data, and silently flipping it would mean the number Claude
 * reasons about is not the number the accountant would see in Tally. The
 * convention is documented on each type instead.
 *
 * **An unreadable value becomes null plus a warning, never a zero.** A
 * fabricated 0.00 in an audit context is worse than an admitted gap, because
 * it is indistinguishable from a real balance of zero.
 */

/** A normalised result together with anything the caller should be told. */
export interface Normalized<T> {
  data: T;
  warnings: string[];
}

/**
 * Where a record came from, carried on every normalised record so a figure
 * can be traced back to the system that produced it.
 */
export interface SourceRef {
  system: 'tallyprime';
  entityType: 'company' | 'ledger' | 'voucher' | 'stockItem' | 'reportRow';
  /** Best available identity: a GUID where Tally provides one, else a name. */
  identifier: string;
}

function sourceRef(entityType: SourceRef['entityType'], identifier: string): SourceRef {
  return { system: 'tallyprime', entityType, identifier };
}

/** Parse, reject non-data payloads, and hand back the ordered document. */
function openDocument(xml: string): TallyNode[] {
  const nodes = parseTallyXml(xml);
  assertNoTallyError(nodes);

  if (isLivenessResponse(nodes)) {
    throw new TallyError(
      'TALLY_INVALID_RESPONSE',
      'TallyPrime returned its liveness reply instead of data.',
      {
        suggestion:
          'Tally is reachable but did not treat this as a data request. Check that a company is loaded.',
      }
    );
  }

  return nodes;
}

/**
 * The element whose children are a report's parallel arrays.
 *
 * Reports put them directly under `<ENVELOPE>` with no BODY/DATA wrapper,
 * unlike collections. Falling back to the document root keeps this working if
 * a future Tally build adds one.
 */
function reportContainer(nodes: TallyNode[]): TallyNode {
  const envelope = findFirst(nodes, 'ENVELOPE');
  return envelope ?? { ENVELOPE: nodes };
}

/**
 * Narrow a collection response to its `<DATA>` section.
 *
 * This is not tidiness — it prevents a real class of bug. Every collection
 * response opens with a `<CMPINFO>` block of record counters whose tag names
 * are the *same* as the record tags: `<COMPANY>0</COMPANY>`,
 * `<LEDGER>0</LEDGER>`, `<VOUCHER>0</VOUCHER>`. A document-wide search for
 * "VOUCHER" therefore finds a phantom leading record with no fields, which
 * both inflates counts by one and shifts every index. Scoping to DATA removes
 * the counters at the source rather than filtering for their symptoms.
 *
 * Falls back to the whole document when there is no DATA wrapper.
 */
function dataScope(nodes: TallyNode[]): TallyNode[] {
  const data = findFirst(nodes, 'DATA');
  return data === null ? nodes : [data];
}

/** Read an amount, recording a warning when a present value will not parse. */
function readMoney(
  raw: string | null,
  label: string,
  warnings: string[]
): Money | null {
  if (raw === null || raw.trim() === '') return null;

  const money = toMoney(raw);
  if (money === null) {
    warnings.push(`Could not read the amount "${raw}" for ${label}; it is reported as null.`);
  }
  return money;
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export interface Company {
  name: string;
  /** ISO date the books start, or null if Tally did not report one. */
  startingFrom: string | null;
  source: SourceRef;
}

export function normalizeCompanies(xml: string): Normalized<Company[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'COMPANY')
    // Belt and braces alongside dataScope: a real record carries a NAME
    // attribute, a counter does not.
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => {
      const attrs = attributesOf(node);
      const name = childText(node, 'NAME') ?? attrs.NAME ?? '';
      const rawStart = childText(node, 'STARTINGFROM');

      const startingFrom = rawStart === null ? null : tallyDateToIso(rawStart);
      if (rawStart !== null && startingFrom === null) {
        warnings.push(`Company "${name}" reported an unreadable start date "${rawStart}".`);
      }

      return { name, startingFrom, source: sourceRef('company', name) };
    });

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------

export interface Ledger {
  name: string;
  /** Parent group, e.g. "Sundry Creditors". */
  parent: string | null;
  /**
   * Balances as Tally reports them. Negative denotes a debit balance in
   * Tally's own encoding; the sign is passed through untouched.
   * Null means Tally returned an empty element — not a balance of zero.
   */
  openingBalance: Money | null;
  closingBalance: Money | null;
  gstin: string | null;
  source: SourceRef;
  /**
   * Every other populated field Tally holds for this ledger, verbatim.
   *
   * Only present when the caller asked for full detail. Which keys appear is
   * a property of the company: one with GST configured carries GST fields, a
   * payroll company carries payroll fields, and neither is knowable ahead of
   * time — so the shape is an open map rather than a fixed interface.
   */
  fields?: Record<string, string>;
}

/** Fields already surfaced as first-class properties, so not repeated in `fields`. */
const LEDGER_PROMOTED_FIELDS = new Set([
  'PARENT',
  'OPENINGBALANCE',
  'CLOSINGBALANCE',
  'PARTYGSTIN',
  'NAME',
]);

export function normalizeLedgers(xml: string, includeAllFields = false): Normalized<Ledger[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'LEDGER')
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => {
      const name = attributesOf(node).NAME ?? '';
      const fields = includeAllFields ? scalarFieldsOf(node, LEDGER_PROMOTED_FIELDS) : undefined;

      return {
        name,
        parent: childText(node, 'PARENT'),
        openingBalance: readMoney(
          childText(node, 'OPENINGBALANCE'),
          `opening balance of "${name}"`,
          warnings
        ),
        closingBalance: readMoney(
          childText(node, 'CLOSINGBALANCE'),
          `closing balance of "${name}"`,
          warnings
        ),
        gstin: childText(node, 'PARTYGSTIN'),
        // GUID is only present on a full fetch; fall back to the name.
        source: sourceRef('ledger', childText(node, 'GUID') ?? name),
        ...(fields === undefined ? {} : { fields }),
      };
    });

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Voucher types
// ---------------------------------------------------------------------------

export interface VoucherType {
  name: string;
  /**
   * The built-in type this one derives from — "Sales", "Purchase", "Payment"
   * and so on. For a stock type the parent is its own name.
   *
   * This is the field that makes "find all sales" reliable: a company may
   * define "GST Sales" or "Tax Invoice", and only the parent identifies the
   * family.
   */
  parent: string | null;
}

export function normalizeVoucherTypes(xml: string): Normalized<VoucherType[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'VOUCHERTYPE')
    // As elsewhere, CMPINFO carries a <VOUCHERTYPE>0</VOUCHERTYPE> counter.
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => ({
      name: attributesOf(node).NAME ?? '',
      parent: childText(node, 'PARENT'),
    }));

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Stock items
// ---------------------------------------------------------------------------

export interface StockItem {
  name: string;
  parent: string | null;
  source: SourceRef;
  /**
   * Everything else Tally reported, verbatim.
   *
   * Deliberately not mapped into named properties. The test company has no
   * inventory, so a populated stock item response has never been observed, and
   * inventing a mapping would encode a guess as though it were verified. This
   * way the tool returns exactly what Tally sent — correct whatever the shape
   * turns out to be — and can be tightened once real inventory data exists.
   */
  fields: Record<string, string>;
  nested?: Record<string, NestedRecord[]>;
}

export function normalizeStockItems(xml: string): Normalized<StockItem[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'STOCKITEM')
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => {
      const name = attributesOf(node).NAME ?? '';
      const nested = nestedRecordsOf(node, NON_ACCOUNTING_STRUCTURES);

      return {
        name,
        parent: childText(node, 'PARENT'),
        source: sourceRef('stockItem', childText(node, 'GUID') ?? name),
        fields: scalarFieldsOf(node, new Set(['NAME', 'PARENT'])),
        ...(Object.keys(nested).length === 0 ? {} : { nested }),
      };
    });

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceRow {
  name: string;
  /**
   * Closing debit and credit columns. Tally reports the debit column as a
   * negative number; that is preserved. Null means the column was empty.
   */
  debit: Money | null;
  credit: Money | null;
}

export function normalizeTrialBalance(xml: string): Normalized<TrialBalanceRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));
  const rows = pairReportRows(container, 'DSPACCNAME', 'DSPACCINFO');

  const data = rows.map((row) => {
    const debitNode = row.value === null ? null : findFirst([row.value], 'DSPCLDRAMTA');
    const creditNode = row.value === null ? null : findFirst([row.value], 'DSPCLCRAMTA');

    noteMissingValue(row, 'trial balance', warnings);

    return {
      name: row.name,
      debit: readMoney(debitNode === null ? null : textOf(debitNode), `debit of "${row.name}"`, warnings),
      credit: readMoney(
        creditNode === null ? null : textOf(creditNode),
        `credit of "${row.name}"`,
        warnings
      ),
    };
  });

  return { data, warnings };
}

/** Report a name that arrived with no matching amount block. */
function noteMissingValue(row: PairedRow, reportName: string, warnings: string[]): void {
  if (row.value === null) {
    warnings.push(
      `The ${reportName} row "${row.name}" arrived with no amount block; its figures are reported as null.`
    );
  }
}

// ---------------------------------------------------------------------------
// Balance sheet and profit & loss
// ---------------------------------------------------------------------------

export interface StatementRow {
  name: string;
  /**
   * The main column. Tally's sign convention is preserved: liabilities and
   * income arrive positive, assets and expenses negative.
   */
  amount: Money | null;
  /** The indented sub-total column, populated only on some rows. */
  subAmount: Money | null;
}

export function normalizeBalanceSheet(xml: string): Normalized<StatementRow[]> {
  return normalizeStatement(xml, 'BSNAME', 'BSAMT', 'BSSUBAMT', 'BSMAINAMT', 'balance sheet');
}

/**
 * Profit and loss.
 *
 * Note the tag mix: the value block is `PLAMT`, but the main column inside it
 * is `BSMAINAMT` — Tally reuses the balance sheet tag rather than defining a
 * P&L-specific one. Verified against a live export; not a copy-paste slip.
 */
export function normalizeProfitLoss(xml: string): Normalized<StatementRow[]> {
  return normalizeStatement(xml, 'DSPACCNAME', 'PLAMT', 'PLSUBAMT', 'BSMAINAMT', 'profit and loss');
}

function normalizeStatement(
  xml: string,
  nameTag: string,
  valueTag: string,
  subAmountTag: string,
  mainAmountTag: string,
  reportName: string
): Normalized<StatementRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));
  const rows = pairReportRows(container, nameTag, valueTag);

  const data = rows.map((row) => {
    const mainNode = row.value === null ? null : findFirst([row.value], mainAmountTag);
    const subNode = row.value === null ? null : findFirst([row.value], subAmountTag);

    noteMissingValue(row, reportName, warnings);

    return {
      name: row.name,
      amount: readMoney(mainNode === null ? null : textOf(mainNode), `"${row.name}"`, warnings),
      subAmount: readMoney(
        subNode === null ? null : textOf(subNode),
        `sub-total of "${row.name}"`,
        warnings
      ),
    };
  });

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

export type EntrySide = 'debit' | 'credit';

export interface LedgerEntry {
  ledgerName: string;
  /** Tally's signed amount, unmodified. Debits arrive negative. */
  amount: Money | null;
  /**
   * Derived from ISDEEMEDPOSITIVE, which is Tally's own debit flag, rather
   * than from the sign of the amount — the two agree in the data observed,
   * but the flag is the field Tally treats as authoritative.
   */
  side: EntrySide;
  /** Every other populated field on the entry, when full detail was asked for. */
  fields?: Record<string, string>;
  /**
   * Populated nested structures on this entry — bill allocations, bank
   * instrument details, cost centre and tax allocations. Only what this
   * company actually records; empty structures are omitted.
   */
  nested?: Record<string, NestedRecord[]>;
}

export interface Voucher {
  /** Tally's GUID. Stable across edits; the best identity a voucher has. */
  guid: string | null;
  /** ISO date, or null when Tally reported an unreadable one. */
  date: string | null;
  voucherType: string | null;
  voucherNumber: string | null;
  partyLedgerName: string | null;
  narration: string | null;
  isCancelled: boolean;
  isOptional: boolean;
  entries: LedgerEntry[];
  source: SourceRef;
  /**
   * Every other populated field on the voucher, when full detail was asked
   * for — reference numbers, due dates, GST fields, bank details, cost centre
   * names and anything else this company happens to record.
   *
   * Costs nothing extra to retrieve: Tally already sends every field on every
   * voucher and leaves the inapplicable ones empty. Populating this is purely
   * a matter of not discarding what already arrived.
   */
  fields?: Record<string, string>;
  /**
   * Populated nested structures on the voucher — inventory lines, bank
   * instrument details, GST breakdowns, e-way bill details, order references.
   *
   * This is where the substance of an invoice lives, and which structures
   * appear depends entirely on what the company records. Ledger entries are
   * excluded, since they are returned as `entries`.
   */
  nested?: Record<string, NestedRecord[]>;
}

/**
 * Structures excluded from `nested`.
 *
 * Two kinds:
 *
 * - **Entry lists**, because they are returned as `entries` in their own
 *   right. Repeating them here would report the same data twice in two
 *   different shapes.
 * - **Tally's internal audit-trail lists**, which carry row IDs and a `-1`
 *   sentinel rather than anything about the transaction. They are populated on
 *   every record, so without this they would appear as a nested structure on
 *   every single voucher and entry and crowd out the structures that matter.
 */
const NON_ACCOUNTING_STRUCTURES = new Set([
  'ALLLEDGERENTRIES.LIST',
  'LEDGERENTRIES.LIST',
  'OLDAUDITENTRYIDS.LIST',
  'AUDITENTRIES.LIST',
  'OLDAUDITENTRIES.LIST',
  'ACCOUNTAUDITENTRIES.LIST',
]);

/** Voucher fields already surfaced as first-class properties. */
const VOUCHER_PROMOTED_FIELDS = new Set([
  'DATE',
  'GUID',
  'VOUCHERTYPENAME',
  'VOUCHERNUMBER',
  'PARTYLEDGERNAME',
  'NARRATION',
  'ISCANCELLED',
  'ISOPTIONAL',
]);

/** Entry fields already surfaced as first-class properties. */
const ENTRY_PROMOTED_FIELDS = new Set(['LEDGERNAME', 'AMOUNT', 'ISDEEMEDPOSITIVE']);

/**
 * Vouchers from a day book or voucher register export.
 *
 * Only the fields worth reading are extracted. A single exploded voucher
 * carries roughly 200 empty date and tax elements plus legacy cash
 * denomination counters, none of which mean anything here.
 */
export function normalizeVouchers(xml: string, includeAllFields = false): Normalized<Voucher[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'VOUCHER').map((node) => {
    const attrs = attributesOf(node);
    const rawDate = childText(node, 'DATE');
    const number = childText(node, 'VOUCHERNUMBER');

    const date = rawDate === null ? null : tallyDateToIso(rawDate);
    if (rawDate !== null && date === null) {
      warnings.push(`Voucher ${number ?? '(no number)'} reported an unreadable date "${rawDate}".`);
    }

    const guid = childText(node, 'GUID') ?? attrs.REMOTEID ?? null;
    const fields = includeAllFields ? scalarFieldsOf(node, VOUCHER_PROMOTED_FIELDS) : undefined;
    const nested = includeAllFields
      ? nestedRecordsOf(node, NON_ACCOUNTING_STRUCTURES)
      : undefined;

    return {
      guid,
      source: sourceRef('voucher', guid ?? number ?? '(unidentified)'),
      ...(fields === undefined ? {} : { fields }),
      ...(nested === undefined || Object.keys(nested).length === 0 ? {} : { nested }),
      date,
      // VCHTYPE is an attribute and VOUCHERTYPENAME an element; they agree in
      // observed data, but only the element survives some report variants.
      voucherType: childText(node, 'VOUCHERTYPENAME') ?? attrs.VCHTYPE ?? null,
      voucherNumber: number,
      partyLedgerName: childText(node, 'PARTYLEDGERNAME'),
      narration: childText(node, 'NARRATION'),
      isCancelled: isYes(childText(node, 'ISCANCELLED')),
      isOptional: isYes(childText(node, 'ISOPTIONAL')),
      entries: normalizeEntries(node, number, warnings, includeAllFields),
    };
  });

  return { data, warnings };
}

function normalizeEntries(
  voucher: TallyNode,
  voucherNumber: string | null,
  warnings: string[],
  includeAllFields: boolean
): LedgerEntry[] {
  const label = voucherNumber ?? '(no number)';

  // Tally uses several entry element names depending on voucher type:
  // ALLLEDGERENTRIES.LIST for accounting vouchers, LEDGERENTRIES.LIST on some
  // invoice views. Reading only the first would silently return a voucher
  // with no entries at all for the other kind.
  const entryNodes = [
    ...childrenNamed(voucher, 'ALLLEDGERENTRIES.LIST'),
    ...childrenNamed(voucher, 'LEDGERENTRIES.LIST'),
  ];

  return entryNodes.map((entry) => {
    const ledgerName = childText(entry, 'LEDGERNAME') ?? '';
    const fields = includeAllFields ? scalarFieldsOf(entry, ENTRY_PROMOTED_FIELDS) : undefined;
    const nested = includeAllFields
      ? nestedRecordsOf(entry, NON_ACCOUNTING_STRUCTURES)
      : undefined;

    return {
      ledgerName,
      amount: readMoney(
        childText(entry, 'AMOUNT'),
        `entry "${ledgerName}" on voucher ${label}`,
        warnings
      ),
      side: isYes(childText(entry, 'ISDEEMEDPOSITIVE')) ? 'debit' : 'credit',
      ...(fields === undefined ? {} : { fields }),
      ...(nested === undefined || Object.keys(nested).length === 0 ? {} : { nested }),
    };
  });
}

/** Tally's boolean encoding. Anything that is not an explicit Yes is false. */
function isYes(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === 'yes';
}
