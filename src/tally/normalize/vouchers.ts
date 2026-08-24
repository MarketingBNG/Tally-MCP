import {
  tallyDateToIso,
  tallyDateTimeToIso,
} from '../../utils/dates.js';
import {
  DEFAULT_CURRENCY,
  type Money,
} from '../../utils/numbers.js';

import {
  attributesOf,
  childText,
  childrenNamed,
  childrenOf,
  findAll,
  nestedRecordsOf,
  scalarFieldsOf,
  tagNameOf,
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
 * Vouchers and their ledger entries — the largest and most nested of the
 * shapes Tally serves.
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
  ALLLEDGERENTRIES_LIST: 'ALLLEDGERENTRIES.LIST',
  AMOUNT: 'AMOUNT',
  DATE: 'DATE',
  GUID: 'GUID',
  ISCANCELLED: 'ISCANCELLED',
  ISDEEMEDPOSITIVE: 'ISDEEMEDPOSITIVE',
  ISINVENTORYVOUCHER: 'ISINVENTORYVOUCHER',
  ISOPTIONAL: 'ISOPTIONAL',
  ISORDERVOUCHER: 'ISORDERVOUCHER',
  LEDGERENTRIES_LIST: 'LEDGERENTRIES.LIST',
  LEDGERNAME: 'LEDGERNAME',
  NARRATION: 'NARRATION',
  PARTYLEDGERNAME: 'PARTYLEDGERNAME',
  UPDATEDDATETIME: 'UPDATEDDATETIME',
  VOUCHERNUMBER: 'VOUCHERNUMBER',
  VOUCHERTYPENAME: 'VOUCHERTYPENAME',
} as const;

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
  /**
   * When this voucher was last WRITTEN — `YYYY-MM-DDTHH:MM:SS`, local to the
   * machine that wrote it, with no timezone because Tally records none.
   *
   * NULL WHERE THE COMPANY DOES NOT STAMP. Tally sends the field as all zeros in
   * that case rather than omitting it, so null here means "no timestamp
   * available", never "written at the same moment it was dated". A test built on
   * this has to refuse to answer when it is null rather than report nothing found.
   *
   * The LAST write, not the creation: it cannot distinguish a voucher keyed in
   * late from one keyed in on time and altered later, and it does not say who
   * wrote it. Verified live 2026-08-18 as a genuine per-voucher stamp rather than
   * a bulk migration artifact — see docs/probe-findings-2026-08-18.md.
   */
  lastWrittenAt: string | null;
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
  'UPDATEDDATETIME',
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
      const rawDate = childText(node, TAG.DATE);
      const number = childText(node, TAG.VOUCHERNUMBER);

      const date = rawDate === null ? null : tallyDateToIso(rawDate);
      if (rawDate !== null && date === null) {
        warnings.push(
          `Voucher ${number ?? '(no number)'} reported an unreadable date "${rawDate}".`
        );
      }

      const guid = childText(node, TAG.GUID) ?? attrs.REMOTEID ?? null;
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
        voucherType: childText(node, TAG.VOUCHERTYPENAME) ?? attrs.VCHTYPE ?? null,
        voucherNumber: number,
        partyLedgerName: childText(node, TAG.PARTYLEDGERNAME),
        narration: childText(node, TAG.NARRATION),
        isCancelled: isYes(childText(node, TAG.ISCANCELLED)),
        isOptional: isYes(childText(node, TAG.ISOPTIONAL)),
        // Absent on a company recording no orders or notes, which isYes reads as
        // false — the correct reading, since absence means "not one of these".
        isOrderVoucher: isYes(childText(node, TAG.ISORDERVOUCHER)),
        isInventoryVoucher: isYes(childText(node, TAG.ISINVENTORYVOUCHER)),
        // No warning when this fails to parse, unlike DATE above. An unstamped
        // company sends all zeros on every single voucher, so warning per record
        // would bury the real warnings under hundreds of copies of one fact. The
        // test that reads this counts the nulls and says so once.
        lastWrittenAt: tallyDateTimeToIso(childText(node, TAG.UPDATEDDATETIME) ?? ''),
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
  const allEntries = childrenNamed(voucher, TAG.ALLLEDGERENTRIES_LIST);
  const entryNodes =
    allEntries.length > 0 ? allEntries : childrenNamed(voucher, TAG.LEDGERENTRIES_LIST);

  return entryNodes.map((entry) => {
    const ledgerName = childText(entry, TAG.LEDGERNAME) ?? '';
    const fields = includeAllFields ? scalarFieldsOf(entry, ENTRY_PROMOTED_FIELDS) : undefined;
    const nested = includeNested ? nestedRecordsOf(entry, NON_ACCOUNTING_STRUCTURES) : undefined;

    return {
      ledgerName,
      amount: readMoney(
        childText(entry, TAG.AMOUNT),
        `entry "${ledgerName}" on voucher ${label}`,
        warnings,
        currency
      ),
      side: isYes(childText(entry, TAG.ISDEEMEDPOSITIVE)) ? 'debit' : 'credit',
      ...(fields === undefined ? {} : { fields }),
      ...(nested === undefined || Object.keys(nested).length === 0 ? {} : { nested }),
    };
  });
}

