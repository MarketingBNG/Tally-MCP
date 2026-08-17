import { isoToTallyDate } from '../utils/dates.js';

/**
 * Tally request construction.
 *
 * Tally is a single-endpoint POST API: everything goes to the same URL and
 * the payload decides what you get. Request *shape* is documented (unlike
 * response shape), so this module can be written and tested without
 * ground-truth samples.
 *
 * READ-ONLY GUARANTEE: `TALLYREQUEST` is hard-coded to `Export` in every
 * builder here, and no builder emits an Import/Alter/Delete envelope. This is
 * the only place Tally request bodies are constructed — tool code never
 * assembles payloads directly — so this file is the single place to audit
 * that claim. There is a test asserting no write verb appears anywhere.
 */

/** The only request verb this server ever issues. */
const EXPORT_ONLY = 'Export' as const;

/** Verbs that would modify Tally data. Present only so tests can assert absence. */
export const FORBIDDEN_WRITE_VERBS = ['Import', 'Alter', 'Delete', 'Create'] as const;

export type TallyWireFormat = 'xml' | 'json';

export interface TallyRequestOptions {
  /**
   * Company to scope the request to. When omitted, Tally uses whichever
   * company is currently loaded — see PROJECT_SPEC.md "Company selection".
   */
  company?: string;
  /** ISO YYYY-MM-DD. Converted to Tally's YYYYMMDD internally. */
  fromDate?: string;
  /** ISO YYYY-MM-DD. */
  toDate?: string;
  /** Preferred response format. JSON requires TallyPrime 7.0+. */
  format?: TallyWireFormat;
}

/** Escape a value for safe inclusion in an XML text node or attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the STATICVARIABLES block shared by every export request.
 *
 * Company and date scoping live here rather than in each builder so that a
 * new report cannot accidentally omit them.
 */
function staticVariables(options: TallyRequestOptions): string {
  const parts: string[] = [];

  // SVEXPORTFORMAT selects the wire format. $$SysName:JSON is only honoured
  // by TallyPrime 7.0+; older builds ignore it and return XML, which the
  // client detects and handles rather than failing.
  parts.push(
    options.format === 'json'
      ? '<SVEXPORTFORMAT>$$SysName:JSON</SVEXPORTFORMAT><SVEXPORTINPLAINFORMAT>Yes</SVEXPORTINPLAINFORMAT>'
      : '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>'
  );

  if (options.company !== undefined && options.company !== '') {
    parts.push(`<SVCURRENTCOMPANY>${escapeXml(options.company)}</SVCURRENTCOMPANY>`);
  }
  if (options.fromDate !== undefined) {
    parts.push(`<SVFROMDATE>${isoToTallyDate(options.fromDate)}</SVFROMDATE>`);
  }
  if (options.toDate !== undefined) {
    parts.push(`<SVTODATE>${isoToTallyDate(options.toDate)}</SVTODATE>`);
  }

  return `<STATICVARIABLES>${parts.join('')}</STATICVARIABLES>`;
}

/**
 * A raw export envelope for a named report (TYPE=Data).
 * Used for day book, trial balance, balance sheet, P&L and similar.
 */
export function buildReportRequest(reportId: string, options: TallyRequestOptions = {}): string {
  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    `<TALLYREQUEST>${EXPORT_ONLY}</TALLYREQUEST>`,
    '<TYPE>Data</TYPE>',
    `<ID>${escapeXml(reportId)}</ID>`,
    '</HEADER>',
    '<BODY><DESC>',
    staticVariables(options),
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

/**
 * A collection export (TYPE=Collection), used for masters such as ledgers,
 * groups and stock items.
 *
 * `nativeMethods` names the fields to return. Requesting only what is needed
 * keeps responses small — Tally has no server-side pagination, so payload
 * size is the main lever available.
 */
export function buildCollectionRequest(
  collectionName: string,
  tallyType: string,
  /**
   * Fields to return. The literal `'*'` requests every field Tally holds for
   * the type, via `<FETCH>*</FETCH>`.
   *
   * Verified against a live install: `*` returns roughly 37x the payload —
   * 5.5 MB versus 148 KB for 330 ledgers — because it includes every feature
   * field Tally supports, populated or not. Worth it when the question is
   * "tell me everything about this company", wasteful for browsing, so the
   * choice is explicit at the call site rather than a default.
   */
  nativeMethods: readonly string[] | '*',
  options: TallyRequestOptions = {}
): string {
  // `*` may arrive on its own or inside the list. Inside the list it means
  // "everything, AND these by name" — which is not redundant, because Tally's
  // wildcard is not a superset: it omits ClosingBalance on a Ledger and every
  // entry list on a Voucher. Both of those were live-verified data losses, so
  // the wildcard always emits as <FETCH> and the named fields as NATIVEMETHODs
  // alongside it, rather than one being expressed in terms of the other.
  const requested = nativeMethods === '*' ? ['*'] : nativeMethods;
  const wildcard = requested.includes('*') ? '<FETCH>*</FETCH>' : '';
  const methods =
    wildcard +
    requested
      .filter((method) => method !== '*')
      .map((method) => `<NATIVEMETHOD>${escapeXml(method)}</NATIVEMETHOD>`)
      .join('');

  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    `<TALLYREQUEST>${EXPORT_ONLY}</TALLYREQUEST>`,
    '<TYPE>Collection</TYPE>',
    `<ID>${escapeXml(collectionName)}</ID>`,
    '</HEADER>',
    '<BODY><DESC>',
    staticVariables(options),
    '<TDL><TDLMESSAGE>',
    // ISMODIFY="No" is belt-and-braces: a collection definition cannot write
    // data, but stating it makes the read-only intent explicit at the wire level.
    `<COLLECTION NAME="${escapeXml(collectionName)}" ISMODIFY="No" ISFIXED="No">`,
    `<TYPE>${escapeXml(tallyType)}</TYPE>`,
    methods,
    '</COLLECTION>',
    '</TDLMESSAGE></TDL>',
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

/**
 * The lightest request that proves Tally is reachable and responding.
 * Used by tally_connection_status, and deliberately cheap: it asks for the
 * company list only, with no date scoping.
 */
export function buildConnectionProbeRequest(): string {
  return buildCollectionRequest(
    'List of Companies',
    'Company',
    ['Name', 'StartingFrom', 'EndingAt'],
    {}
  );
}

/**
 * Company list, including basic period metadata and the base currency.
 *
 * `CurrencyName` is what stops every figure being mislabelled. Tally reports it
 * as a SYMBOL rather than an ISO code — verified live 2026-08-13, a US company
 * returned `<CURRENCYNAME>$</CURRENCYNAME>` and
 * `<COUNTRYNAME>United States of America</COUNTRYNAME>`. Without it the server
 * fell back to a hard-coded INR and labelled dollar balances as rupees.
 *
 * `BaseCurrencySymbol` and `BaseCurrencyFormalName` were probed at the same time
 * and are NOT supported on this collection: Tally silently omitted them rather
 * than erroring, which is worth knowing — an unsupported native method here fails
 * open, so a missing field means "not served", never "not set".
 */
export function buildCompanyListRequest(options: TallyRequestOptions = {}): string {
  return buildCollectionRequest(
    'List of Companies',
    'Company',
    ['Name', 'StartingFrom', 'EndingAt', 'CompanyNumber', 'GUID', 'CurrencyName', 'CountryName'],
    options
  );
}

/**
 * Ledger masters.
 *
 * `allFields` switches from the curated set to everything Tally holds. Use it
 * when the question is about what a company actually records — different
 * companies enable different features, so the field set is a property of the
 * company, not something this server can know in advance. It costs roughly
 * 37x the payload, so it is opt-in.
 */
export function buildLedgerListRequest(
  options: TallyRequestOptions = {},
  allFields = false
): string {
  return buildCollectionRequest(
    'Ledgers',
    'Ledger',
    // Order matters for `allFields`, exactly as it does for vouchers: `*` first,
    // then the curated names, because the wildcard does not imply them.
    allFields ? ['*', ...LEDGER_FIELDS] : LEDGER_FIELDS,
    options
  );
}

/**
 * The curated ledger fields, named once because `allFields` must ALSO request
 * them rather than relying on `*`.
 *
 * WHY. `<FETCH>*</FETCH>` does not include `ClosingBalance`. Verified live
 * 2026-08-17 against MUDALS TECHNOLOGIES: listing ledgers returned ADP India
 * Pvt. Ltd. with a closing balance of -14,822,831, while fetching that same
 * ledger BY NAME — which takes the `allFields` path — returned `null` for it.
 * The wildcard is not the superset its name implies; it is a different set.
 *
 * That made the failure worse than a missing field. Rule 1 of the model is
 * that `null` means unreadable, so the most complete request available was
 * reporting the most important number on the account as unavailable when Tally
 * would have sent it for the asking. An accountant opening one party's detail
 * would read a blank balance as nothing to see.
 *
 * The cost of naming them alongside `*` is a duplicated tag or two in a
 * response already carrying ninety fields.
 */
const LEDGER_FIELDS = [
  'Name',
  'Parent',
  'OpeningBalance',
  'ClosingBalance',
  'LedgerPhone',
  'LedgerContact',
  'PartyGSTIN',
  'GSTRegistrationType',
  'IsBillWiseOn',
  'IsCostCentresOn',
  // Tally's own related-party flag. Verified live 2026-08-14: a real
  // ledger master field, returned populated on 330 of 330 ledgers. It
  // corrects earlier research for this project which concluded that
  // TallyPrime holds no related-party marking at all — it does, and it
  // is the right SEED for related-party screening even though it is not
  // by itself a complete list.
  'IsRelatedParty',
] as const;

/**
 * Ledger groups — the chart of accounts hierarchy itself, as distinct from
 * the ledgers filed under it. `Parent` is the group this one nests under
 * (empty for a primary group), and `IsRevenue`/`IsDeemedPositive` classify it
 * as P&L vs balance sheet and debit vs credit respectively.
 */
export function buildGroupListRequest(options: TallyRequestOptions = {}): string {
  return buildCollectionRequest(
    'Groups',
    'Group',
    ['Name', 'Parent', 'IsRevenue', 'IsDeemedPositive', 'IsSubLedger'],
    options
  );
}

/**
 * Voucher types defined in the company, with the base type each derives from.
 *
 * Needed because voucher type NAMES are company-specific: a company can define
 * "GST Sales" or "Tax Invoice" deriving from the built-in `Sales` type.
 * Matching a voucher's type name against the string "sales" would miss those
 * and quietly under-report. `Parent` is the base type, so this lets the family
 * be resolved from Tally rather than guessed.
 *
 * Verified against a live install.
 *
 * `allFields` is required to see the numbering setup, and the reason is a trap
 * worth knowing. The curated form CANNOT return it: the top-level
 * `NUMBERINGMETHOD` element on a voucher type reads `None` on every type — it is
 * a legacy field — while the real method lives in the nested
 * `VOUCHERNUMBERSERIES.LIST`, one entry per numbering series. Verified live
 * 2026-08-12 on a company where all 26 types reported top-level `None` and every
 * series was actually `Automatic` / `Auto Retain`, with a real invoice prefix.
 * Reading the scalar therefore produces a confident answer that is wrong, which
 * is why `numberingSeries` is normalised from the nested list instead and the
 * scalar is not reported at all.
 *
 * The whole collection with every field measured 142 KB for 26 types, so unlike
 * ledgers there is no meaningful cost to paying for it. The curated form is kept
 * because voucher-family resolution needs only name and parent, and it runs on
 * every family query.
 */
export function buildVoucherTypeListRequest(
  options: TallyRequestOptions = {},
  allFields = false
): string {
  return buildCollectionRequest(
    'VoucherTypes',
    'VoucherType',
    allFields ? '*' : ['Name', 'Parent', 'IsDeemedPositive'],
    options
  );
}

/**
 * The currencies this company defines.
 *
 * Cheap (1.7KB on a real company) and it answers one question that matters: is this
 * company multi-currency? Tally does not report a per-voucher currency on
 * single-currency books — probed live 2026-08-13, no CURRENCYNAME or FOREX field
 * appears on any voucher or entry — so this server cannot tell a foreign-currency
 * transaction from a base-currency one. Where more than one currency is DEFINED, that
 * gap is disclosed rather than left silent.
 *
 * `IsBaseCurrency` is requested but not served — Tally silently omits it, the same
 * fail-open behaviour as `BaseCurrencySymbol` on the company collection. The base
 * currency therefore comes from the company's own `CurrencyName`, not from here.
 */
export function buildCurrencyListRequest(options: TallyRequestOptions = {}): string {
  return buildCollectionRequest(
    'Currencies',
    'Currency',
    ['Name', 'MailingName', 'IsBaseCurrency', 'DecimalPlaces'],
    options
  );
}

/**
 * Stock item masters.
 *
 * UNVERIFIED SHAPE: the request uses the same proven collection form as
 * ledgers and returns 200 OK, but the test company holds **zero stock items**
 * (`<STOCKITEM>0</STOCKITEM>`), so a populated inventory response has never
 * been seen. Normalisation therefore promotes only `Name` and `Parent` — safe
 * by analogy with every other master — and returns everything else through the
 * generic field extraction, so the tool reports whatever Tally actually sends
 * rather than a guessed mapping. See docs/known-limitations.md.
 */
export function buildStockItemListRequest(
  options: TallyRequestOptions = {},
  allFields = false
): string {
  return buildCollectionRequest(
    'StockItems',
    'StockItem',
    allFields
      ? '*'
      : [
          'Name',
          'Parent',
          'Category',
          'BaseUnits',
          'ClosingBalance',
          'ClosingValue',
          'ClosingRate',
          'OpeningBalance',
          'OpeningValue',
        ],
    options
  );
}

/**
 * Vouchers WITH their ledger and inventory entries.
 *
 * A collection over `Voucher`, not the `Voucher Register` report, and the
 * difference is not a preference — the report cannot answer an accounting
 * question at all. Verified live 2026-08-13 against TallyPrime on a company
 * with 453 vouchers: the report returns 28 KB of field scaffolding per voucher
 * (246 distinct tags, almost all empty) and **zero** ledger entries. No
 * `ALLLEDGERENTRIES.LIST`, no `LEDGERNAME`, no `AMOUNT`. `EXPLODEFLAG` does
 * not change that. Every voucher therefore parsed with `entries: []`, which
 * silently zeroed every movement-based figure this server produces — the
 * tie-out control reported 34 exceptions and 0 vouchers checked against books
 * that actually balance.
 *
 * The entry lists MUST be named explicitly in `FETCH`. `<FETCH>*</FETCH>` is
 * the trap: it returns 10.9 MB of every scalar Tally holds and still omits the
 * entries, so it looks like the most complete request available while being
 * exactly as useless as the report. Verified on the same company — `*` gave 0
 * entries, the explicit list gave 907 ledger entries and 466 inventory entries.
 *
 * DATES ARE NOT SCOPED HERE, and that is Tally's behaviour, not an omission.
 * A collection ignores SVFROMDATE/SVTODATE: asked for April 2025 alone (13
 * vouchers) it returned all 453 spanning the full year. So the whole book comes
 * back and callers filter by date themselves. `staticVariables` still emits the
 * dates — they cost nothing and a future Tally build may honour them — but
 * nothing may rely on them having been applied.
 */
export function buildVoucherCollectionRequest(
  options: TallyRequestOptions = {},
  allFields = false
): string {
  // Order matters for `allFields`: `*` first, then the entry lists, because the
  // wildcard does not imply them and naming them after it is what brings them back.
  const fields = allFields
    ? ['*', 'AllLedgerEntries', 'AllInventoryEntries']
    : [
        'Date',
        'GUID',
        'VoucherTypeName',
        'VoucherNumber',
        'PartyLedgerName',
        'Narration',
        'IsCancelled',
        'IsOptional',
        // Order and note vouchers are NOT transactions in the accounting sense.
        // `tally-database-loader` fetches both flags precisely so they can be
        // excluded from financial totals: a sales or purchase ORDER is a
        // commitment carrying no ledger entries, and a delivery or receipt note
        // moves stock without touching accounts — so a receipt note and the
        // purchase invoice that follows it both carry inventory lines for the
        // same goods, and counting both double-counts the movement.
        //
        // Absent on a company that records neither, which reads as false. Adding
        // them to the fetch list costs nothing: Tally sends the field superset
        // regardless and leaves the inapplicable ones empty.
        'IsOrderVoucher',
        'IsInventoryVoucher',
        'AllLedgerEntries',
        'AllInventoryEntries',
      ];

  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    `<TALLYREQUEST>${EXPORT_ONLY}</TALLYREQUEST>`,
    '<TYPE>Collection</TYPE>',
    '<ID>AllVouchers</ID>',
    '</HEADER>',
    '<BODY><DESC>',
    staticVariables(options),
    '<TDL><TDLMESSAGE>',
    '<COLLECTION NAME="AllVouchers" ISMODIFY="No" ISFIXED="No">',
    '<TYPE>Voucher</TYPE>',
    `<FETCH>${escapeXml(fields.join(','))}</FETCH>`,
    '</COLLECTION>',
    '</TDLMESSAGE></TDL>',
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

/**
 * Every voucher's `AlterId`, and nothing else — a candidate cache-validation probe.
 *
 * NOT USED BY ANY TOOL YET, and deliberately so. The idea is that if the maximum
 * `AlterId` has not moved, the books have not changed and a cached parse is still
 * valid — turning a 2.6s / 8.6MB refetch into a ~200ms / 537KB check. Measured live
 * 2026-08-13: 537.6KB in 199-260ms against 8.6MB in ~2,000ms, so roughly 16x smaller
 * and 10x faster.
 *
 * It is not wired in because the saving is worthless if the assumption is wrong. If
 * `AlterId` fails to move on any kind of edit — a DELETION being the likely one — a
 * validated cache would serve stale figures and report them as current, which is
 * strictly worse than the honest five-minute expiry in place today. Proving it needs
 * someone to alter, add and delete a voucher in a real company, so it lives in
 * `scripts/probe-alterid.mjs` until that is done.
 *
 * The shape is defined here rather than in the script so that the Export-only
 * guarantee this file carries covers it too.
 */
export function buildVoucherAlterIdRequest(options: TallyRequestOptions = {}): string {
  return [
    '<ENVELOPE>',
    '<HEADER>',
    '<VERSION>1</VERSION>',
    `<TALLYREQUEST>${EXPORT_ONLY}</TALLYREQUEST>`,
    '<TYPE>Collection</TYPE>',
    '<ID>VoucherAlterIds</ID>',
    '</HEADER>',
    '<BODY><DESC>',
    staticVariables(options),
    '<TDL><TDLMESSAGE>',
    '<COLLECTION NAME="VoucherAlterIds" ISMODIFY="No" ISFIXED="No">',
    '<TYPE>Voucher</TYPE>',
    '<FETCH>AlterId,MasterId</FETCH>',
    '</COLLECTION>',
    '</TDLMESSAGE></TDL>',
    '</DESC></BODY>',
    '</ENVELOPE>',
  ].join('');
}

/** Trial balance for a date range. */
export function buildTrialBalanceRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Trial Balance', options);
}

/** Balance sheet as at the end of the range. */
export function buildBalanceSheetRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Balance Sheet', options);
}

/** Profit and loss for the range. */
export function buildProfitLossRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Profit and Loss', options);
}

/**
 * Monthly cash movement — Tally's own "Cash Flow" report.
 *
 * Verified against a live install (2026-08-12): returns alternating
 * DSPPERIOD/DSPACCINFO siblings, one pair per month, each carrying debit,
 * credit and net columns where net = debit + credit. This is monthly
 * movement, NOT a classified cash flow statement — Tally supplies no
 * operating/investing/financing split.
 */
export function buildCashFlowRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Cash Flow', options);
}

/**
 * Monthly funds movement — Tally's own "Funds Flow" report.
 *
 * Same wire shape as the cash flow report but different column semantics,
 * verified live: each month's debit equals the previous month's credit, and
 * net = credit − debit — Tally is reporting opening funds, closing funds and
 * the change per month.
 */
export function buildFundsFlowRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Funds Flow', options);
}

/**
 * Closing stock per item — Tally's own "Stock Summary" report.
 *
 * Report ID verified 2026-08-10 (accepted, not rejected) but it returned an
 * empty envelope on every company probed until 2026-08-14, when a company that
 * maintains inventory finally populated it. That is why this arrived late: the
 * ID was known good long before its response shape could be read.
 *
 * Shape: alternating DSPACCNAME/DSPSTKINFO siblings, one pair per stock item,
 * carrying closing quantity, rate and value. See `normalizeClosingStock`.
 */
export function buildStockSummaryRequest(options: TallyRequestOptions = {}): string {
  return buildReportRequest('Stock Summary', options);
}

/**
 * Closing stock per location — Tally's own "Godown Summary" report.
 *
 * Identical wire shape to Stock Summary, with godown names in place of item
 * names; verified live 2026-08-14 against a company with one godown ("Main
 * Location"). This is the only path in the server to location-wise stock.
 */
export function buildGodownSummaryRequest(options: TallyRequestOptions = {}): string {
  return buildReportRequest('Godown Summary', options);
}
