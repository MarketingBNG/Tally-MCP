import type { Money } from '../utils/numbers.js';

/**
 * The normalised ledger model — a source-agnostic shape for accounting data.
 *
 * WHY THIS EXISTS. Annexure A §3 records that Tally is not the firm's only
 * source: clients sit on QuickBooks Online, Zoho Books and Tally, and the US
 * entities are not on Tally at all. Every audit test and every report in the
 * programme is written ONCE, against this model. Annexure A §3.3 puts the
 * consequence bluntly: if a test contains a source-specific field name, it is
 * written wrong.
 *
 * STATUS: draft for review. Annexure A §7.3 requires the audit-team domain
 * owner to sign this off BEFORE any adapter is written. Nothing here is wired
 * to anything yet — deliberately. These types compile and are exported so they
 * can be reviewed as code alongside docs/normalised-ledger-model.md, which
 * explains them for a non-engineer and lists the open questions.
 *
 * THREE RULES CARRIED OVER from src/tally/normalize.ts, which is the closest
 * thing to a first draft of this model and has been proven against live data:
 *
 *   1. An unreadable value becomes `null`, never `0`. A fabricated zero is
 *      indistinguishable from a real balance of zero, which in an audit is the
 *      more dangerous of the two. Matches Spec §6 rule 10.
 *   2. Every record carries provenance back to the system it came from.
 *      Matches Spec §6 rule 2.
 *   3. Nothing that arrived is discarded: each entity keeps a raw escape hatch
 *      so an adapter never has to throw away a field it cannot yet map.
 *
 * ONE RULE DELIBERATELY BROKEN. `normalize.ts` preserves Tally's signed
 * encoding, where a debit arrives negative. That is right for a Tally
 * connector and wrong here — see `EntryLine.side` for the decision and what it
 * costs.
 */

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Systems an adapter may exist for.
 *
 * Widened from the `'tallyprime'` literal in `normalize.ts`. Listing systems
 * that have no adapter yet is intentional: it is the roadmap in Annexure A §3,
 * and a test that switches on this union will fail to compile when one is
 * added rather than silently ignoring it.
 */
export type SourceSystem =
  | 'tallyprime'
  | 'zoho_books'
  | 'quickbooks_online'
  | 'xero'
  | 'sap'
  | 'oracle'
  | 'dynamics';

export type EntityType =
  | 'entity'
  | 'account'
  | 'party'
  | 'voucher'
  | 'entryLine'
  | 'costCentre'
  | 'stockItem'
  | 'document';

/**
 * Where a record came from, carried on every record in this model.
 *
 * `identifier` is whatever the source treats as identity — a GUID where one
 * exists, a name where it does not. It is NOT assumed stable across edits;
 * Tally company records, for instance, expose no GUID at all.
 */
export interface SourceRef {
  system: SourceSystem;
  entityType: EntityType;
  identifier: string;
  /**
   * The request, query or endpoint that produced this record, where the
   * adapter can name one. Spec §6 rule 2 requires a figure to carry the query
   * that produced it; on the Tally side this is the XML request body.
   */
  sourceQuery?: string;
  /** When the source was read. Snapshots (Spec §4 L0) depend on this. */
  retrievedAt?: string;
}

/**
 * Fields the source held that this model has no home for, kept verbatim.
 *
 * Not a dumping ground — the point is that mapping can be incremental without
 * being lossy. `Ledger.fields` and `Voucher.fields` in `normalize.ts` already
 * work this way and are what make the existing tools useful on companies whose
 * configuration nobody anticipated.
 */
export type RawFields = Record<string, string>;

// ---------------------------------------------------------------------------
// Entity and period
// ---------------------------------------------------------------------------

/**
 * A reporting entity — one set of books.
 *
 * Called "entity" rather than "company" because consolidation (Spec §4 L4
 * `fs_consolidate`) treats branches and subsidiaries alike, and because
 * "company" already means something narrower in TallyPrime.
 */
export interface Entity {
  id: string;
  name: string;
  /**
   * Currency the books are KEPT in. Per entity, never global: the cross-border
   * work this whole programme exists for (Annexure A §6, Phase 7) means an
   * Indian entity on INR and a US entity on USD inside one group.
   */
  functionalCurrency: string;
  /** Month the financial year starts, 1–12. India is 4; the US is commonly 1. */
  fiscalYearStartMonth: number | null;
  /** Reporting framework this entity's statements are prepared under. */
  framework: 'ind_as' | 'indian_gaap' | 'us_gaap' | 'other' | null;
  taxIdentifiers: TaxIdentifier[];
  source: SourceRef;
  raw?: RawFields;
}

/** A GSTIN, PAN, EIN or equivalent. Kept as a list; entities have several. */
export interface TaxIdentifier {
  /** e.g. 'gstin', 'pan', 'tan', 'cin', 'ein'. Lower-case, source-agnostic. */
  kind: string;
  value: string;
  /** State or country the identifier is issued for, where it matters (GST). */
  jurisdiction: string | null;
}

export interface FiscalPeriod {
  entityId: string;
  /** ISO YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string;
  /** Whether the source reports this period as closed to further posting. */
  isClosed: boolean | null;
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

/**
 * Classification every framework agrees on, before any framework-specific
 * caption is applied.
 *
 * Deliberately these five and no more. Schedule III heads and US GAAP captions
 * are NOT modelled here — they are the output of the mapping layer
 * (`gaap_bridge_engine`, Spec §4 L4), and baking one framework's vocabulary
 * into the shared model is exactly how a dual-framework system stops being
 * dual.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/**
 * A node in the chart of accounts.
 *
 * This merges what TallyPrime splits into Group and Ledger. The distinction
 * there is that a Group cannot hold transactions and a Ledger can, which is
 * `isPostable` here — one recursive tree rather than two entity types, because
 * QuickBooks and Zoho Books both model it that way and a test that has to know
 * which system it is looking at to walk the tree has already failed §3.3.
 */
export interface Account {
  id: string;
  entityId: string;
  /** Account code where the source keeps one. Tally does not; QBO does. */
  code: string | null;
  name: string;
  parentId: string | null;
  /**
   * Root-to-leaf names, e.g. ["Current Assets", "Sundry Debtors", "Acme Ltd"].
   * Materialised rather than walked, because ledger scrutiny and mapping both
   * key off the path and re-deriving it per test is where drift starts.
   */
  path: string[];
  type: AccountType;
  /**
   * Which side increases this account. Derivable from `type` for the ordinary
   * cases, but contra accounts (accumulated depreciation, drawings) invert it,
   * and getting that wrong silently flips a figure's sign.
   */
  normalBalance: 'debit' | 'credit';
  /** False for a heading that only aggregates its children. */
  isPostable: boolean;
  /** Null means the source reported no balance — NOT a balance of zero. */
  openingBalance: SignedAmount | null;
  closingBalance: SignedAmount | null;
  source: SourceRef;
  raw?: RawFields;
}

// ---------------------------------------------------------------------------
// The sign decision
// ---------------------------------------------------------------------------

/**
 * An amount together with the side it falls on.
 *
 * THIS IS THE DECISION THAT NEEDS THE AUDIT DOMAIN OWNER'S SIGN-OFF, and it is
 * the one thing in this file that cannot be changed cheaply later.
 *
 * TallyPrime encodes side in the SIGN of the amount: a debit balance arrives
 * negative, an expense arrives negative, stock-in-hand arrives negative.
 * `src/tally/normalize.ts` preserves that untouched, and says why — the number
 * the model reasons about is then the same number an accountant sees on the
 * Tally screen.
 *
 * That property cannot survive a second source. QuickBooks and Zoho Books do
 * not share Tally's convention, so a signed amount alone would mean every
 * audit test has to know which system produced the figure before it can read
 * it. That is precisely the source-specific coupling Annexure A §3.3 forbids.
 *
 * So this model carries an EXPLICIT side and a NON-NEGATIVE magnitude. The
 * mechanism already exists: `LedgerEntry.side` in normalize.ts is derived from
 * Tally's own ISDEEMEDPOSITIVE flag rather than from the sign, because that
 * flag is what Tally treats as authoritative.
 *
 * WHAT IT COSTS, stated plainly for the review: the adapter now transforms
 * rather than passes through, so a figure in this model no longer matches the
 * Tally screen glyph for glyph, and a reviewer comparing the two must know the
 * convention differs. The trade is cross-source comparability against
 * single-source fidelity. It is a professional judgement, not an engineering
 * one, and it must be settled before the second adapter is written.
 */
export interface SignedAmount {
  /** Never negative. A negative magnitude here is a bug, not a credit. */
  magnitude: Money;
  side: 'debit' | 'credit';
}

// ---------------------------------------------------------------------------
// Parties, cost centres, inventory
// ---------------------------------------------------------------------------

export interface Party {
  id: string;
  entityId: string;
  name: string;
  /** A party can be more than one of these at once, so this is a list. */
  roles: ('customer' | 'vendor' | 'employee' | 'bank' | 'government' | 'other')[];
  taxIdentifiers: TaxIdentifier[];
  /** The account this party's balance sits in, where the source links them. */
  accountId: string | null;
  /**
   * Whether this party is related to the entity, for AS 18 / Ind AS 24 /
   * ASC 850. Null means UNDETERMINED, not "no" — the determination is
   * professional judgement (Spec §4 L3 `scrutiny_related_party`) and an
   * adapter must never assert it on its own.
   */
  isRelatedParty: boolean | null;
  source: SourceRef;
  raw?: RawFields;
}

export interface CostCentre {
  id: string;
  entityId: string;
  name: string;
  parentId: string | null;
  source: SourceRef;
}

/** A quantity with its unit, kept together — a bare number is meaningless. */
export interface Quantity {
  amount: string;
  /** Unit exactly as the source names it, e.g. "Kgs.", "Nos". Not converted. */
  unit: string;
}

export interface StockItem {
  id: string;
  entityId: string;
  name: string;
  parentId: string | null;
  baseUnit: string | null;
  openingQuantity: Quantity | null;
  closingQuantity: Quantity | null;
  openingValue: SignedAmount | null;
  closingValue: SignedAmount | null;
  source: SourceRef;
  raw?: RawFields;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Transaction families every accounting system has, whatever it calls them.
 *
 * The source's own type name is kept alongside in `Voucher.sourceType`,
 * because a company's custom "Tax Invoice" type matters to an auditor even
 * though it normalises to `sales`. The existing Tally tools already resolve
 * custom types to their base type this way.
 */
export type VoucherFamily =
  | 'sales'
  | 'purchase'
  | 'receipt'
  | 'payment'
  | 'contra'
  | 'journal'
  | 'credit_note'
  | 'debit_note'
  | 'stock_journal'
  | 'other';

/**
 * One transaction: a balanced set of entry lines.
 *
 * Called a voucher rather than a journal entry to match the vocabulary the
 * engagement teams already use.
 */
export interface Voucher {
  id: string;
  entityId: string;
  /** ISO YYYY-MM-DD. Null when the source reported an unreadable date. */
  date: string | null;
  family: VoucherFamily;
  /** The source's own type name, e.g. "Tax Invoice". */
  sourceType: string | null;
  number: string | null;
  narration: string | null;
  partyId: string | null;
  lines: EntryLine[];
  /**
   * Audit-trail fields, from the source's edit log where it keeps one.
   *
   * These drive most of the §4 L3 fraud-risk tests — entries posted at odd
   * hours, backdated entries, entries by users who rarely post. Null means the
   * source did not supply it, which for an Indian statutory audit is itself a
   * finding: the edit log is mandatory.
   */
  createdAt: string | null;
  createdBy: string | null;
  lastAlteredAt: string | null;
  lastAlteredBy: string | null;
  /**
   * Cancelled and optional vouchers are RETAINED, not filtered out. A voucher
   * that was entered and then cancelled is evidence, and dropping it at the
   * adapter would put it beyond the reach of every test downstream.
   */
  isCancelled: boolean;
  /** Entered but not affecting books — Tally's "optional", QBO's draft. */
  isDraft: boolean;
  /** Documents supporting this voucher. Empty until L1 exists. */
  documents: DocumentLink[];
  source: SourceRef;
  raw?: RawFields;
}

export interface EntryLine {
  id: string;
  voucherId: string;
  accountId: string;
  /** See SignedAmount: explicit side, non-negative magnitude. */
  amount: SignedAmount | null;
  partyId: string | null;
  costCentreId: string | null;
  /** Inventory movement on this line, where there is one. */
  stockItemId: string | null;
  quantity: Quantity | null;
  /** Tax charged on this line, itemised. */
  taxLines: TaxLine[];
  /** Bill/invoice references this line settles — the ageing backbone. */
  billReferences: BillReference[];
  source: SourceRef;
  raw?: RawFields;
}

/**
 * One tax component on a line.
 *
 * `regime` keeps this usable outside India: GST, VAT, TDS and US sales tax all
 * fit, and a test written for one does not have to be rewritten for another.
 */
export interface TaxLine {
  /** e.g. 'gst_cgst', 'gst_sgst', 'gst_igst', 'tds', 'vat', 'us_sales_tax'. */
  regime: string;
  /** Rate as a percentage string, e.g. "18". Null when the source omits it. */
  rate: string | null;
  taxableAmount: Money | null;
  taxAmount: Money | null;
  /** HSN/SAC, TDS section, or the source's equivalent classification code. */
  code: string | null;
  jurisdiction: string | null;
}

export interface BillReference {
  /** The bill or invoice number being created, settled or adjusted. */
  reference: string;
  kind: 'new' | 'against' | 'advance' | 'on_account';
  amount: SignedAmount | null;
  dueDate: string | null;
}

// ---------------------------------------------------------------------------
// Document linkage (L1 hook)
// ---------------------------------------------------------------------------

/**
 * A link between a voucher and a source document.
 *
 * Defined now although nothing populates it: Spec §4 L1 calls document-voucher
 * linking "the vouching backbone", and `doc_gap_analysis` — vouchers above
 * materiality with no supporting document — is answerable only if the absence
 * of a link is representable from the start.
 */
export interface DocumentLink {
  documentId: string;
  /** SHA-256 of the stored document, per Spec §4 L1 `doc_ingest`. */
  contentHash: string;
  relation: 'supports' | 'referenced_by' | 'superseded_by';
  /**
   * Extraction confidence where the link was made by a machine, 0–1. Null when
   * a human made the link. Spec §6 rule 7: below-threshold extraction goes to
   * a human queue and is never auto-posted, so the score has to survive here.
   */
  confidence: number | null;
}
