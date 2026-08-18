import { tallyDateToIso } from '../utils/dates.js';
import { DEFAULT_CURRENCY, toMoney, type Money } from '../utils/numbers.js';
import { TallyError } from './TallyError.js';
import {
  attributesOf,
  childText,
  childrenNamed,
  childrenOf,
  findAll,
  findFirst,
  isLivenessResponse,
  nestedRecordsOf,
  pairReportRows,
  parseTallyXml,
  scalarFieldsOf,
  tagNameOf,
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
  entityType:
    | 'company'
    | 'ledger'
    | 'group'
    | 'voucher'
    | 'stockItem'
    | 'godown'
    | 'reportRow';
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

/**
 * Read an amount, recording a warning when a present value will not parse.
 *
 * `currency` is REQUIRED rather than defaulted, and that is deliberate. It used
 * to default to INR, which meant every figure this server returned was labelled
 * INR whatever the company's books were actually in — verified live 2026-08-13
 * against a US company whose base currency is `$`, whose dollar balances came
 * back labelled `"currency": "INR"`. Nothing converted, so the numbers were
 * right and only the label lied, which is the more dangerous failure: an
 * accountant reading 494,397.50 INR against books stating $494,397.50 has been
 * handed a plausible wrong fact. Making the parameter mandatory means the
 * compiler, not a reviewer, guarantees every construction site supplies it.
 */
function readMoney(
  raw: string | null,
  label: string,
  warnings: string[],
  currency: string
): Money | null {
  if (raw === null || raw.trim() === '') return null;

  const money = toMoney(raw, currency);
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
  /**
   * ISO date the books END AT, or null if Tally did not report one.
   *
   * This is the last date the company holds data for, NOT the end of its book
   * year: verified live 2026-08-14 on a company reporting `20260731` whose year
   * runs to 31 December. Use it as the anchor for `bookYearFor` rather than
   * today's date — a company holding 2019 books does not become a current-year
   * company because someone opened it today.
   */
  endingAt: string | null;
  /**
   * The company's base currency exactly as Tally labels it — a SYMBOL, not an
   * ISO code: `"$"` on a US company, `"₹"` or `"Rs."` on an Indian one. Null
   * when Tally did not report it.
   *
   * This is the label every monetary figure from this company carries. It is not
   * a conversion rate and nothing here converts between currencies.
   */
  currency: string | null;
  /** Country as Tally reports it, e.g. "United States of America". */
  country: string | null;
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

      const rawEnd = childText(node, 'ENDINGAT');
      const endingAt = rawEnd === null ? null : tallyDateToIso(rawEnd);
      if (rawEnd !== null && endingAt === null) {
        warnings.push(`Company "${name}" reported an unreadable end date "${rawEnd}".`);
      }

      return {
        name,
        startingFrom,
        endingAt,
        currency: childText(node, 'CURRENCYNAME'),
        country: childText(node, 'COUNTRYNAME'),
        source: sourceRef('company', name),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the company list');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

export interface Currency {
  /** The symbol Tally uses as the currency's identity, e.g. "$". */
  name: string;
  /** Tally's spelled-out name, e.g. "Dollar". Null when not reported. */
  formalName: string | null;
  /** Decimal places Tally records for it, as a string. Null when not reported. */
  decimalPlaces: string | null;
}

export function normalizeCurrencies(xml: string): Normalized<Currency[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'CURRENCY')
    // A real record carries a NAME attribute; the CMPINFO counter does not.
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => ({
      name: childText(node, 'NAME') ?? attributesOf(node).NAME ?? '',
      formalName: childText(node, 'MAILINGNAME'),
      decimalPlaces: childText(node, 'DECIMALPLACES'),
    }));

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the currency list');
  if (unread !== undefined) warnings.push(unread);

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
  /**
   * TallyPrime's own related-party marking, from `ISRELATEDPARTY`.
   *
   * A real, populated field — but a SEED, not an answer. Whether a party is
   * related under AS 18 / Ind AS 24 is a legal determination about directors,
   * relatives, key management personnel and common control, and a company that
   * has never ticked the box has every ledger reading `false`. So `false` here
   * means "not marked in Tally", never "not a related party". Screening seeds
   * from this and takes the rest from a caller-supplied list.
   */
  isRelatedParty: boolean;
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
  'ISRELATEDPARTY',
  'NAME',
]);

export function normalizeLedgers(
  xml: string,
  includeAllFields = false,
  currency: string = DEFAULT_CURRENCY
): Normalized<Ledger[]> {
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
          warnings,
          currency
        ),
        closingBalance: readMoney(
          childText(node, 'CLOSINGBALANCE'),
          `closing balance of "${name}"`,
          warnings,
          currency
        ),
        gstin: childText(node, 'PARTYGSTIN'),
        isRelatedParty: isYes(childText(node, 'ISRELATEDPARTY')),
        // GUID is only present on a full fetch; fall back to the name.
        source: sourceRef('ledger', childText(node, 'GUID') ?? name),
        ...(fields === undefined ? {} : { fields }),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the ledger masters');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Groups (chart of accounts)
// ---------------------------------------------------------------------------

export interface Group {
  name: string;
  /** Parent group this nests under, or null for a primary group. */
  parent: string | null;
  /** True for P&L groups (income/expenses), false for balance sheet groups. */
  isRevenue: boolean;
  /** Tally's own debit/credit classification, same convention as a ledger entry's side. */
  isDeemedPositive: boolean;
  source: SourceRef;
}

export function normalizeGroups(xml: string): Normalized<Group[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'GROUP')
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => {
      const name = attributesOf(node).NAME ?? '';

      return {
        name,
        parent: childText(node, 'PARENT'),
        isRevenue: isYes(childText(node, 'ISREVENUE')),
        isDeemedPositive: isYes(childText(node, 'ISDEEMEDPOSITIVE')),
        source: sourceRef('group', childText(node, 'GUID') ?? name),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the group masters');
  if (unread !== undefined) warnings.push(unread);

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
  /**
   * How Tally numbers vouchers of this type, one entry per numbering series.
   *
   * Read from the nested `VOUCHERNUMBERSERIES.LIST`, NOT from the type's
   * top-level `NUMBERINGMETHOD` element. That scalar is a legacy field: verified
   * live 2026-08-12, it read `None` on all 26 types of a company whose every
   * series was actually `Automatic` with sub-method `Auto Retain`. A scalar
   * `numberingMethod` field was built first and reported exactly that wrong
   * answer, which is the reason this is a list read from the nested structure.
   *
   * Empty when the request did not ask for all fields — the curated fetch cannot
   * carry a nested list. `tally_get_masters type "voucherType"` always asks for all fields;
   * voucher-family resolution does not, and does not read this.
   *
   * Worth having because it changes what a repeated voucher number means: on a
   * manually-numbered type a repeat is a data-entry question, on an automatic one
   * it points at something stranger, and `preventsDuplicates` says whether Tally
   * would have stopped it. That inference belongs to whoever is reading.
   */
  numberingSeries: VoucherNumberSeries[];
  /**
   * Tally's debit/credit classification for the type. Genuinely per-type: it
   * varies across types on real data, unlike the numbering scalar above.
   */
  isDeemedPositive: boolean;
}

export interface VoucherNumberSeries {
  /** Series name as Tally holds it, e.g. "Default". */
  name: string | null;
  /** e.g. "Automatic", "Manual", "None" — Tally's own label, uninterpreted. */
  method: string | null;
  /** e.g. "Auto Retain". Tally's finer distinction under `method`. */
  subMethod: string | null;
  /**
   * Whether Tally itself refuses a duplicate number on this series. Directly
   * relevant to a duplicate-invoice question: `false` means nothing in Tally
   * prevented one.
   */
  preventsDuplicates: boolean;
}

/**
 * Numbering series on one voucher type, from the nested list.
 *
 * Returns empty rather than guessing when the structure is absent, which is the
 * normal case for the curated fetch. An empty list means "not asked for or not
 * recorded" — never "unnumbered", which is what the legacy scalar would have
 * implied. See the VoucherType.numberingSeries comment.
 */
function numberingSeriesOf(node: TallyNode): VoucherNumberSeries[] {
  return childrenNamed(node, 'VOUCHERNUMBERSERIES.LIST').map((series) => ({
    name: childText(series, 'NAME'),
    method: childText(series, 'NUMBERINGMETHOD'),
    subMethod: childText(series, 'NUMBERINGSUBMETHOD'),
    preventsDuplicates: isYes(childText(series, 'PREVENTDUPLICATES')),
  }));
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
      numberingSeries: numberingSeriesOf(node),
      isDeemedPositive: isYes(childText(node, 'ISDEEMEDPOSITIVE')),
    }));

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the voucher type masters');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Stock items
// ---------------------------------------------------------------------------

export interface StockItem {
  name: string;
  parent: string | null;
  /** Base stock-keeping unit, e.g. "Kgs.". */
  baseUnits: string | null;
  /** Quantity strings exactly as Tally formats them, unit included (e.g. "1000.00 Kgs."). */
  openingBalance: string | null;
  closingBalance: string | null;
  /**
   * Value of the balance. Verified live: TallyPrime reports these negative
   * for a stock-in-hand item, matching the trial balance sign convention
   * elsewhere in this server. Sign is preserved, not corrected.
   */
  openingValue: Money | null;
  closingValue: Money | null;
  /** Rate string exactly as Tally formats it, e.g. "20.00/Kgs.". */
  closingRate: string | null;
  source: SourceRef;
  /**
   * Every other populated field Tally holds for this item, verbatim — e.g.
   * CATEGORY. Which fields exist depends on what this company has configured.
   */
  fields: Record<string, string>;
  nested?: Record<string, NestedRecord[]>;
}

/** Stock item fields already surfaced as first-class properties. */
const STOCK_ITEM_PROMOTED_FIELDS = new Set([
  'NAME',
  'PARENT',
  'BASEUNITS',
  'OPENINGBALANCE',
  'CLOSINGBALANCE',
  'OPENINGVALUE',
  'CLOSINGVALUE',
  'CLOSINGRATE',
]);

export function normalizeStockItems(
  xml: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<StockItem[]> {
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
        baseUnits: childText(node, 'BASEUNITS'),
        openingBalance: childText(node, 'OPENINGBALANCE'),
        closingBalance: childText(node, 'CLOSINGBALANCE'),
        openingValue: readMoney(
          childText(node, 'OPENINGVALUE'),
          `opening value of "${name}"`,
          warnings,
          currency
        ),
        closingValue: readMoney(
          childText(node, 'CLOSINGVALUE'),
          `closing value of "${name}"`,
          warnings,
          currency
        ),
        closingRate: childText(node, 'CLOSINGRATE'),
        source: sourceRef('stockItem', childText(node, 'GUID') ?? name),
        fields: scalarFieldsOf(node, STOCK_ITEM_PROMOTED_FIELDS),
        ...(Object.keys(nested).length === 0 ? {} : { nested }),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the stock item masters');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

// ---------------------------------------------------------------------------
// Closing stock reports (Stock Summary, Godown Summary)
// ---------------------------------------------------------------------------

export interface ClosingStockRow {
  /** Stock item name, or godown name, depending on which report was fetched. */
  name: string;
  /**
   * Closing quantity exactly as Tally formats it, unit included — "9500.00 Kg".
   *
   * Kept as ONE STRING rather than split into a number and a unit, which is the
   * convention `StockItem` above already follows. A bare stock number is
   * meaningless and worse than absent: `toMoney` deliberately refuses strings
   * like this because the salvage attempt used to return figures 100x too large.
   */
  closingQuantity: string | null;
  /**
   * Closing rate exactly as Tally formats it.
   *
   * ROUNDED, and therefore not a basis for arithmetic. Verified live 2026-08-14:
   * an item with quantity 9500.00 Kg and rate 4.85 carried a Tally value of
   * -46,084.41, where 9500 x 4.85 is 46,075.00 — the true rate is 4.8510958 and
   * the report shows two decimals. Multiplying quantity by rate produces a
   * figure that looks right and is not. Use `closingValue`, which is Tally's own.
   */
  closingRate: string | null;
  /**
   * Tally's own closing value. NEGATIVE on stock in hand, matching the debit
   * convention everywhere else in this server. Sign preserved, never corrected.
   */
  closingValue: Money | null;
  source: SourceRef;
}

/**
 * Both `Stock Summary` and `Godown Summary` share one wire shape, verified live
 * 2026-08-14 on the company that finally populated them:
 *
 *   DSPACCNAME > DSPDISPNAME            (item name, or godown name)
 *   DSPSTKINFO > DSPSTKCL > DSPCLQTY / DSPCLRATE / DSPCLAMTA
 *
 * The two alternate as siblings directly under `<ENVELOPE>` with no `<DATA>`
 * wrapper, which is the same positional pairing the trial balance uses — so it
 * goes through `pairReportRows` rather than a zip of two filtered lists, for the
 * reason documented there: a heading or subtotal row missing one side would
 * otherwise shift every subsequent pairing silently.
 *
 * `entityKind` only picks the source entity type and the wording of warnings.
 * The parsing is identical because the reports are identical in shape.
 */
export function normalizeClosingStock(
  xml: string,
  reportName: string,
  entityKind: 'stockItem' | 'godown',
  currency: string = DEFAULT_CURRENCY
): Normalized<ClosingStockRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));
  const rows = pairReportRows(container, 'DSPACCNAME', 'DSPSTKINFO');

  const data = rows.map((row) => {
    const closing = row.value === null ? null : findFirst([row.value], 'DSPSTKCL');
    const read = (tag: string): string | null => {
      if (closing === null) return null;
      const node = findFirst([closing], tag);
      return node === null ? null : textOf(node);
    };

    noteMissingValue(row, reportName, warnings);

    return {
      name: row.name,
      closingQuantity: read('DSPCLQTY'),
      closingRate: read('DSPCLRATE'),
      closingValue: readMoney(
        read('DSPCLAMTA'),
        `closing value of "${row.name}"`,
        warnings,
        currency
      ),
      source: sourceRef(entityKind, row.name),
    };
  });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the closing stock report');
  if (unread !== undefined) warnings.push(unread);

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

export function normalizeTrialBalance(
  xml: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<TrialBalanceRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));
  const rows = pairReportRows(container, 'DSPACCNAME', 'DSPACCINFO');

  const data = rows.map((row) => {
    const debitNode = row.value === null ? null : findFirst([row.value], 'DSPCLDRAMTA');
    const creditNode = row.value === null ? null : findFirst([row.value], 'DSPCLCRAMTA');

    noteMissingValue(row, 'trial balance', warnings);

    return {
      name: row.name,
      debit: readMoney(
        debitNode === null ? null : textOf(debitNode),
        `debit of "${row.name}"`,
        warnings,
        currency
      ),
      credit: readMoney(
        creditNode === null ? null : textOf(creditNode),
        `credit of "${row.name}"`,
        warnings,
        currency
      ),
    };
  });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the trial balance');
  if (unread !== undefined) warnings.push(unread);

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
// Cash flow and funds flow (monthly movement)
// ---------------------------------------------------------------------------

export interface MonthlyFlowRow {
  /** Month name exactly as Tally labels it, e.g. "April". No year is sent. */
  period: string;
  /** Tally's debit column. Sign preserved: debits arrive negative. */
  debit: Money | null;
  credit: Money | null;
  /**
   * Tally's own net column, passed through rather than recomputed. Observed
   * live: debit + credit on the cash flow report; credit − debit on the funds
   * flow report, where debit and credit are the month's opening and closing
   * funds.
   */
  net: Money | null;
}

/**
 * Both flow reports share one wire shape: DSPPERIOD (a month name) and
 * DSPACCINFO alternate as siblings, the same positional pairing the trial
 * balance uses, with three amounts nested inside each info block.
 */
export function normalizeMonthlyFlow(
  xml: string,
  reportName: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<MonthlyFlowRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));
  const rows = pairReportRows(container, 'DSPPERIOD', 'DSPACCINFO');

  const data = rows.map((row) => {
    const debitNode = row.value === null ? null : findFirst([row.value], 'DSPDRAMTA');
    const creditNode = row.value === null ? null : findFirst([row.value], 'DSPCRAMTA');
    const netNode = row.value === null ? null : findFirst([row.value], 'DSPCLAMTA');

    noteMissingValue(row, reportName, warnings);

    return {
      period: row.name,
      debit: readMoney(
        debitNode === null ? null : textOf(debitNode),
        `debit of "${row.name}"`,
        warnings,
        currency
      ),
      credit: readMoney(
        creditNode === null ? null : textOf(creditNode),
        `credit of "${row.name}"`,
        warnings,
        currency
      ),
      net: readMoney(
        netNode === null ? null : textOf(netNode),
        `net of "${row.name}"`,
        warnings,
        currency
      ),
    };
  });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'this monthly flow report');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
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

export function normalizeBalanceSheet(
  xml: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<StatementRow[]> {
  return normalizeStatement(
    xml,
    'BSNAME',
    'BSAMT',
    'BSSUBAMT',
    'BSMAINAMT',
    'balance sheet',
    currency
  );
}

/**
 * Profit and loss.
 *
 * Note the tag mix: the value block is `PLAMT`, but the main column inside it
 * is `BSMAINAMT` — Tally reuses the balance sheet tag rather than defining a
 * P&L-specific one. Verified against a live export; not a copy-paste slip.
 */
export function normalizeProfitLoss(
  xml: string,
  currency: string = DEFAULT_CURRENCY
): Normalized<StatementRow[]> {
  return normalizeStatement(
    xml,
    'DSPACCNAME',
    'PLAMT',
    'PLSUBAMT',
    'BSMAINAMT',
    'profit and loss',
    currency
  );
}

function normalizeStatement(
  xml: string,
  nameTag: string,
  valueTag: string,
  subAmountTag: string,
  mainAmountTag: string,
  reportName: string,
  currency: string
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
      amount: readMoney(
        mainNode === null ? null : textOf(mainNode),
        `"${row.name}"`,
        warnings,
        currency
      ),
      subAmount: readMoney(
        subNode === null ? null : textOf(subNode),
        `sub-total of "${row.name}"`,
        warnings,
        currency
      ),
    };
  });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'this statement');
  if (unread !== undefined) warnings.push(unread);

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
  /**
   * A sales or purchase ORDER — a commitment, not a transaction. It carries no
   * ledger entries, so it contributes nothing to any total while still inflating
   * voucher COUNTS if left in a population.
   */
  isOrderVoucher: boolean;
  /**
   * A stock-only voucher such as a delivery or receipt note: it moves inventory
   * without touching accounts. Reported rather than silently dropped, because
   * whether it belongs in a stock figure is a judgement — a receipt note and the
   * purchase invoice that follows it describe the same goods.
   */
  isInventoryVoucher: boolean;
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
export function normalizeVouchers(
  xml: string,
  includeAllFields = false,
  currency: string = DEFAULT_CURRENCY,
  /**
   * Keep the nested structures (bank allocations, bill allocations, inventory
   * lines, tax breakdowns) WITHOUT keeping every scalar field.
   *
   * Separate from `includeAllFields` because the two have completely different
   * costs, which stayed hidden while one flag controlled both. The nested
   * structures ride along in the ordinary curated request for free — verified
   * live 2026-08-13, the lean 8.6MB response and the 18.3MB `FETCH *` response
   * contain IDENTICAL numbers of them (948 bank allocations, 977 bill
   * allocations, 466 inventory lines, 1,032 rate details). Only the scalar
   * fields cost the extra 10MB.
   *
   * So a tool that wants bank instruments no longer has to ask for 204 scalar
   * fields it never reads. Defaults to following `includeAllFields`, leaving
   * existing callers unaffected.
   */
  includeNested = includeAllFields
): Normalized<Voucher[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'VOUCHER')
    /**
     * Drop the `<VOUCHER>0</VOUCHER>` counter from the CMPINFO preamble.
     *
     * Every other normaliser here filters on the NAME attribute for this, but a
     * voucher has no NAME, so it needed its own test — and without one this was
     * the single record type that could return a phantom. It only bites when the
     * response has no `<DATA>` wrapper, because `dataScope` then falls back to
     * the whole document and the counter comes into range; `stock-items-empty.xml`
     * proves Tally really does emit that wrapper-less shape on an empty result.
     * The phantom arrived with a null date, null number and no entries, so it
     * inflated the voucher count by one AND presented an unbalanced voucher to
     * the tie-out control.
     *
     * A real voucher always carries at least one child element. The counter's
     * only child is the text "0".
     */
    .filter((node) => childrenOf(node).some((child) => tagNameOf(child) !== null))
    .map((node) => {
      const attrs = attributesOf(node);
      const rawDate = childText(node, 'DATE');
      const number = childText(node, 'VOUCHERNUMBER');

      const date = rawDate === null ? null : tallyDateToIso(rawDate);
      if (rawDate !== null && date === null) {
        warnings.push(
          `Voucher ${number ?? '(no number)'} reported an unreadable date "${rawDate}".`
        );
      }

      const guid = childText(node, 'GUID') ?? attrs.REMOTEID ?? null;
      const fields = includeAllFields ? scalarFieldsOf(node, VOUCHER_PROMOTED_FIELDS) : undefined;
      const nested = includeNested
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
        // Absent on a company recording no orders or notes, which isYes reads as
        // false — the correct reading, since absence means "not one of these".
        isOrderVoucher: isYes(childText(node, 'ISORDERVOUCHER')),
        isInventoryVoucher: isYes(childText(node, 'ISINVENTORYVOUCHER')),
        entries: normalizeEntries(
          node,
          number,
          warnings,
          includeAllFields,
          currency,
          includeNested
        ),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the voucher register');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

function normalizeEntries(
  voucher: TallyNode,
  voucherNumber: string | null,
  warnings: string[],
  includeAllFields: boolean,
  currency: string,
  includeNested: boolean
): LedgerEntry[] {
  const label = voucherNumber ?? '(no number)';

  // Tally uses two entry element names: ALLLEDGERENTRIES.LIST on accounting
  // vouchers, LEDGERENTRIES.LIST on some invoice views. They are ALTERNATIVES,
  // not halves — an invoice carries BOTH, with LEDGERENTRIES.LIST repeating the
  // party entry that ALLLEDGERENTRIES.LIST already holds. Concatenating them
  // counted the party twice and left 29 of 453 vouchers reported as failing
  // double entry on books that balance (verified live 2026-08-13: invoice
  // ACME/INV/01 has 2 ALLLEDGERENTRIES and 1 LEDGERENTRIES, all three parsed).
  //
  // So ALLLEDGERENTRIES.LIST wins where present and LEDGERENTRIES.LIST is only
  // a fallback, which keeps voucher types that carry solely the latter readable.
  const allEntries = childrenNamed(voucher, 'ALLLEDGERENTRIES.LIST');
  const entryNodes =
    allEntries.length > 0 ? allEntries : childrenNamed(voucher, 'LEDGERENTRIES.LIST');

  return entryNodes.map((entry) => {
    const ledgerName = childText(entry, 'LEDGERNAME') ?? '';
    const fields = includeAllFields ? scalarFieldsOf(entry, ENTRY_PROMOTED_FIELDS) : undefined;
    const nested = includeNested ? nestedRecordsOf(entry, NON_ACCOUNTING_STRUCTURES) : undefined;

    return {
      ledgerName,
      amount: readMoney(
        childText(entry, 'AMOUNT'),
        `entry "${ledgerName}" on voucher ${label}`,
        warnings,
        currency
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

// ---------------------------------------------------------------------------
// Generic reports (the allowlisted tally_get_report)
// ---------------------------------------------------------------------------

/**
 * One row of a report whose exact shape is not known in advance.
 *
 * `amounts` holds every scalar under the value block under TallyPrime's own tag
 * names — `DSPCLDRAMTA`, `DSPCLCRAMTA`, and whatever else the particular report
 * emits — rather than being renamed to debit/credit. Renaming would mean
 * asserting which column is which on a report whose columns have not been
 * verified, and getting that wrong silently is the failure this whole file is
 * written to avoid. A caller reading `DSPCLDRAMTA` knows exactly what it has.
 */
export interface GenericReportRow {
  name: string;
  amounts: Record<string, string>;
}

/**
 * Parse a report into name/amount rows without knowing its column meanings.
 *
 * Every TallyPrime report observed so far uses the same positional pairing the
 * trial balance does: a name node and an info node alternating as siblings. So
 * this reads the shape rather than the report, which is what makes one function
 * serve an allowlist of views whose individual layouts differ.
 *
 * When the pairing finds nothing, the result is an EMPTY row list plus a
 * warning — never an error and never an invented row. Tally answers a valid
 * report that has nothing to show with a 23-byte empty envelope, and that is a
 * real answer ("no negative ledgers") which must not be reported as a failure.
 */
export function normalizeGenericReport(
  xml: string,
  reportName: string
): Normalized<GenericReportRow[]> {
  const warnings: string[] = [];
  const container = reportContainer(openDocument(xml));

  /*
   * THREE ROW SHAPES, not one — and reading only the first is silent data loss.
   *
   * This function used to pair `DSPACCNAME` with `DSPACCINFO` and nothing else.
   * That is the shape `Negative Ledgers` uses, and it was the report the
   * allowlist was verified against, so the code looked right.
   *
   * Measured live 2026-08-17 against MUDALS TECHNOLOGIES (284 vouchers, 155 of
   * them journals), the other reports do NOT use it:
   *   - `Journal Register`  2,098 bytes of DSPPERIOD / DSPACCINFO
   *   - `Sales Register`    2,817 bytes of the same
   *   - `Ratio Analysis`    1,677 bytes of RATIONAME / RATIOVALUE
   * Every one of those parsed to ZERO rows. TallyPrime sent real figures and
   * this server reported "no rows" — then appended the note below explaining
   * that an empty result is a real answer on an exception report. So the output
   * did not merely lose the data, it argued that the loss was a clean result.
   * On a register that reads as "this company records no sales".
   *
   * The shapes are tried in order and the first that yields rows wins. They are
   * mutually exclusive in practice — a report emits one vocabulary — so this
   * cannot mix two together. A report matching none still returns no rows, but
   * now says so as an unrecognised LAYOUT rather than as an empty report, which
   * is a different claim and the honest one.
   */
  let layout = 'DSPACCNAME/DSPACCINFO';
  let rows = pairReportRows(container, 'DSPACCNAME', 'DSPACCINFO');

  if (rows.length === 0) {
    // Register reports: one row per PERIOD rather than per account.
    const byPeriod = pairReportRows(container, 'DSPPERIOD', 'DSPACCINFO');
    if (byPeriod.length > 0) {
      layout = 'DSPPERIOD/DSPACCINFO';
      rows = byPeriod;
    }
  }

  if (rows.length === 0) {
    // Ratio Analysis: flat name/value pairs, no amount block at all.
    const ratios = pairReportRows(container, 'RATIONAME', 'RATIOVALUE');
    if (ratios.length > 0) {
      layout = 'RATIONAME/RATIOVALUE';
      rows = ratios;
    }
  }

  const data: GenericReportRow[] = [];
  for (const row of rows) {
    // Amounts nest one level deeper than the info block on every report
    // observed, so a shallow scalar read would come back empty. The descendant
    // walk finds them wherever the particular report puts them.
    //
    // RATIOVALUE is a scalar rather than a block, so it has no descendants to
    // walk; its own text IS the value and is reported under its own tag name,
    // keeping the "columns are TallyPrime's tag names" contract intact.
    const amounts =
      row.value === null
        ? {}
        : layout === 'RATIONAME/RATIOVALUE'
          ? { RATIOVALUE: (textOf(row.value) ?? '').trim() }
          : descendantScalars(row.value);

    if (row.value === null) {
      warnings.push(
        `The "${reportName}" row "${row.name}" arrived with no amount block; it is reported with ` +
          'no amounts rather than with zeros.'
      );
    }
    data.push({ name: row.name, amounts });
  }

  if (data.length > 0 && layout !== 'DSPACCNAME/DSPACCINFO') {
    warnings.push(
      `"${reportName}" uses TallyPrime's ${layout} row layout rather than the per-account one. ` +
        (layout === 'DSPPERIOD/DSPACCINFO'
          ? 'Each row is a PERIOD (a month), not an account, so the "name" is a date range and ' +
            'the figures are that period\'s totals. Do not read these rows as ledger balances.'
          : 'Each row is a named ratio and its value, so there are no debit/credit columns to ' +
            'read; the value is reported under TallyPrime\'s own RATIOVALUE tag.')
    );
  }

  if (data.length === 0) {
    // Distinguish "Tally sent nothing" from "Tally sent something this parser
    // does not recognise". Reporting the second as the first is what produced
    // the silent loss described above, and the byte count is the evidence.
    const bytes = xml.length;
    const looksPopulated = bytes > EMPTY_ENVELOPE_BYTES;
    warnings.push(
      looksPopulated
        ? `UNRECOGNISED ROW LAYOUT: TallyPrime returned ${String(bytes)} bytes for ` +
          `"${reportName}", so it is NOT an empty report — but none of the row layouts this ` +
          'server knows (DSPACCNAME/DSPACCINFO, DSPPERIOD/DSPACCINFO, RATIONAME/RATIOVALUE) ' +
          'matched it, so no rows could be read. Do NOT report this as "nothing to report": ' +
          'there is data here that this server could not parse. Open the report in TallyPrime ' +
          'to read it, and treat this as a gap in this server rather than in the books.'
        : `TallyPrime accepted "${reportName}" and returned no rows. On this report that is a ` +
          'real answer, not a failure — but it is also what an unpopulated feature looks like, ' +
          'so check whether this company uses the feature before reading it as "nothing to ' +
          'report".'
    );
  }

  return { data, warnings };
}

/**
 * Size of TallyPrime's empty-result envelope, plus room for whitespace.
 *
 * Measured at 23 bytes on a live install (see genericReport.ts). Anything
 * meaningfully larger carried content, which is what separates "no rows" from
 * "rows this parser could not read".
 */
const EMPTY_ENVELOPE_BYTES = 64;

/**
 * The invariant every normaliser is held to: a payload that carried content
 * must never be reported as an empty result.
 *
 * ## Why this is a shared rule and not a per-parser detail
 *
 * `normalizeGenericReport` read one row shape and returned zero rows for three
 * reports that use others. TallyPrime had sent 2,098 bytes of Journal Register
 * and 1,677 of Ratio Analysis; the tool answered "no rows" and appended its
 * standing note that an empty result is a real answer on an exception report.
 * The output did not merely lose the figures, it argued the loss was clean.
 *
 * That was one parser's bug, but it is a shape EVERY parser here can take: each
 * one matches specific tag names against a payload whose shape TallyPrime does
 * not document, and each returns an array that is empty both when there is
 * nothing and when nothing matched. Those two cases are indistinguishable from
 * the outside and mean opposite things.
 *
 * So the distinction is drawn once, from the only evidence available — the byte
 * count. Above the empty-envelope size, content arrived; zero rows then means
 * this server failed to read it, and says so in those words.
 *
 * Returns the warning to push, or undefined when there is nothing to say.
 * Callers append it; nothing is suppressed or rewritten.
 */
export function unreadablePayloadWarning(
  xml: string,
  rowsParsed: number,
  /** What was being parsed, named as the caller would describe it. */
  what: string
): string | undefined {
  if (rowsParsed > 0) return undefined;
  if (xml.length <= EMPTY_ENVELOPE_BYTES) return undefined;

  return (
    `UNREAD PAYLOAD: TallyPrime returned ${String(xml.length)} bytes for ${what}, so this is NOT ` +
    'an empty result — but no rows could be read from it. Something in the response did not ' +
    'match the layout this server expects. Do NOT report this as "none found" or "nothing to ' +
    'report": there is data here that was not parsed. Check the same view on screen in ' +
    'TallyPrime, and treat this as a gap in this server rather than in the books.'
  );
}

/** Every scalar tag at any depth below a node, first occurrence winning. */
function descendantScalars(node: TallyNode): Record<string, string> {
  const found: Record<string, string> = {};

  const walk = (current: TallyNode): void => {
    for (const child of childrenOf(current)) {
      const tag = tagNameOf(child);
      if (tag === null) continue;
      if (childrenOf(child).some((grandchild) => tagNameOf(grandchild) !== null)) {
        walk(child);
        continue;
      }
      const text = textOf(child);
      if (text === null) continue;
      const trimmed = text.trim();
      if (trimmed === '') continue;
      found[tag] ??= trimmed;
    }
  };

  walk(node);
  return found;
}
