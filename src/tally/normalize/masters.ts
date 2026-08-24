
import {
  DEFAULT_CURRENCY,
  type Money,
} from '../../utils/numbers.js';

import {
  attributesOf,
  childText,
  childrenNamed,
  findAll,
  nestedRecordsOf,
  scalarFieldsOf,
  type NestedRecord,
  type TallyNode,
} from '../TallyResponseParser.js';
import {
  dataScope,
  openDocument,
  readMoney,
  sourceRef,
  unreadablePayloadWarning,
  type Normalized,
  type SourceRef,
  isYes,
  NON_ACCOUNTING_STRUCTURES,
} from './shared.js';

/**
 * Master records: ledgers, groups, the simple name/parent masters, voucher
 * types and stock items.
 *
 * Split out of the single normalize.ts, which had grown to 1,461 lines across
 * thirteen banner-delimited sections. Every function here follows the same two
 * rules as the rest of the normalisers.
 *
 * **Sign is preserved, never corrected.** Tally's trial balance reports debit
 * balances as negative and P&L expenses as negative. That is Tally's own
 * encoding, and silently flipping it would mean the number Claude reasons about
 * is not the number the accountant would see in Tally.
 *
 * **An unreadable value becomes null plus a warning, never a zero.** A
 * fabricated 0.00 in an audit context is worse than an admitted gap, because it
 * is indistinguishable from a real balance of zero.
 */

/**
 * Every TallyPrime element name this module depends on, in one place.
 *
 * These are the wire contract, and TallyPrime does not document it. Scattered as
 * bare literals through the normalisers they were unreviewable: a tag renamed or
 * dropped in a future Tally build yields ZERO ROWS, not a type error, and the
 * only way to find what a normaliser actually requires was to read every line of
 * it. Collected here, "what does this module need from Tally?" is one block to
 * read and one place to change.
 *
 * The keys are the tag names themselves rather than friendlier aliases: an alias
 * would put a second vocabulary between the reader and the payload they are
 * comparing against, and the payload only ever says the tag.
 */
const TAG = {
  BASEUNITS: 'BASEUNITS',
  CLOSINGBALANCE: 'CLOSINGBALANCE',
  CLOSINGRATE: 'CLOSINGRATE',
  CLOSINGVALUE: 'CLOSINGVALUE',
  GUID: 'GUID',
  ISDEEMEDPOSITIVE: 'ISDEEMEDPOSITIVE',
  ISRELATEDPARTY: 'ISRELATEDPARTY',
  ISREVENUE: 'ISREVENUE',
  NAME: 'NAME',
  NUMBERINGMETHOD: 'NUMBERINGMETHOD',
  NUMBERINGSUBMETHOD: 'NUMBERINGSUBMETHOD',
  OPENINGBALANCE: 'OPENINGBALANCE',
  OPENINGVALUE: 'OPENINGVALUE',
  PARENT: 'PARENT',
  PARTYGSTIN: 'PARTYGSTIN',
  PREVENTDUPLICATES: 'PREVENTDUPLICATES',
  VOUCHERNUMBERSERIES_LIST: 'VOUCHERNUMBERSERIES.LIST',
} as const;

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
        parent: childText(node, TAG.PARENT),
        openingBalance: readMoney(
          childText(node, TAG.OPENINGBALANCE),
          `opening balance of "${name}"`,
          warnings,
          currency
        ),
        closingBalance: readMoney(
          childText(node, TAG.CLOSINGBALANCE),
          `closing balance of "${name}"`,
          warnings,
          currency
        ),
        gstin: childText(node, TAG.PARTYGSTIN),
        isRelatedParty: isYes(childText(node, TAG.ISRELATEDPARTY)),
        // GUID is only present on a full fetch; fall back to the name.
        source: sourceRef('ledger', childText(node, TAG.GUID) ?? name),
        ...(fields === undefined ? {} : { fields }),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the ledger masters');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

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
        parent: childText(node, TAG.PARENT),
        isRevenue: isYes(childText(node, TAG.ISREVENUE)),
        isDeemedPositive: isYes(childText(node, TAG.ISDEEMEDPOSITIVE)),
        source: sourceRef('group', childText(node, TAG.GUID) ?? name),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the group masters');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

/**
 * One record from a master list that is essentially a name, a parent and
 * whatever else the company happens to record.
 *
 * Cost centres, cost categories, units, stock groups and stock categories all
 * have this shape. They get one normaliser rather than five because there is
 * nothing type-specific to interpret — a name is a name — and five near-copies
 * would drift.
 */
export interface SimpleMaster {
  name: string;
  parent: string | null;
  /** Every other populated field, verbatim. Which appear is a company property. */
  fields: Record<string, string>;
  source: SourceRef;
}

/** Fields already surfaced as first-class properties. */
const SIMPLE_MASTER_PROMOTED = new Set(['NAME', 'PARENT', 'GUID']);

/**
 * Normalise one of the simple master collections.
 *
 * ## Why these were unreachable until 2026-08-21
 *
 * They need a collection TYPE this server had never sent — and type probing was
 * stopped years-of-commits ago after two hangs, because an unrecognised TYPE
 * parks TallyPrime behind a modal dialog. The rule was sound and the cost of
 * breaking it was real, so the lists were documented as unreachable.
 *
 * Re-probed on 2026-08-21 against TallyPrime 7.1, with somebody watching the
 * Tally window and the scheduled export disabled: `CostCentre`, `CostCategory`,
 * `Godown`, `Unit`, `StockGroup`, `StockCategory` and `Budget` were ALL accepted
 * in under 30ms with no dialog and no error, against a `Ledger` control that
 * passed alongside them. `Godown` returned "Main Location", `Unit` returned
 * "Kg", `CostCategory` returned "Primary Cost Category". Empty results are the
 * company not using the feature, not a refusal.
 *
 * The safety rule is NOT repealed by this. What is now known is that these seven
 * specific types are safe on this build; a type nobody has sent is still
 * unknown, and scripts/probe-collection-types.mjs is how to find out — watched,
 * one at a time, with the export disabled.
 */
export function normalizeSimpleMasters(
  xml: string,
  element: string,
  entityType: SourceRef['entityType'],
  what: string
): Normalized<SimpleMaster[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), element)
    // CMPINFO carries a counter element of the same name — `<GODOWN>0</GODOWN>`
    // — which has no NAME attribute. Same guard every master list here needs.
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => {
      const name = attributesOf(node).NAME ?? '';
      return {
        name,
        parent: childText(node, TAG.PARENT),
        fields: scalarFieldsOf(node, SIMPLE_MASTER_PROMOTED),
        source: sourceRef(entityType, childText(node, TAG.GUID) ?? name),
      };
    });

  const unread = unreadablePayloadWarning(xml, data.length, what);
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

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
  return childrenNamed(node, TAG.VOUCHERNUMBERSERIES_LIST).map((series) => ({
    name: childText(series, TAG.NAME),
    method: childText(series, TAG.NUMBERINGMETHOD),
    subMethod: childText(series, TAG.NUMBERINGSUBMETHOD),
    preventsDuplicates: isYes(childText(series, TAG.PREVENTDUPLICATES)),
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
      parent: childText(node, TAG.PARENT),
      numberingSeries: numberingSeriesOf(node),
      isDeemedPositive: isYes(childText(node, TAG.ISDEEMEDPOSITIVE)),
    }));

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the voucher type masters');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

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
        parent: childText(node, TAG.PARENT),
        baseUnits: childText(node, TAG.BASEUNITS),
        openingBalance: childText(node, TAG.OPENINGBALANCE),
        closingBalance: childText(node, TAG.CLOSINGBALANCE),
        openingValue: readMoney(
          childText(node, TAG.OPENINGVALUE),
          `opening value of "${name}"`,
          warnings,
          currency
        ),
        closingValue: readMoney(
          childText(node, TAG.CLOSINGVALUE),
          `closing value of "${name}"`,
          warnings,
          currency
        ),
        closingRate: childText(node, TAG.CLOSINGRATE),
        source: sourceRef('stockItem', childText(node, TAG.GUID) ?? name),
        fields: scalarFieldsOf(node, STOCK_ITEM_PROMOTED_FIELDS),
        ...(Object.keys(nested).length === 0 ? {} : { nested }),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the stock item masters');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}
