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
  const methods =
    nativeMethods === '*'
      ? '<FETCH>*</FETCH>'
      : nativeMethods
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

/** Company list, including basic period metadata. */
export function buildCompanyListRequest(options: TallyRequestOptions = {}): string {
  return buildCollectionRequest(
    'List of Companies',
    'Company',
    ['Name', 'StartingFrom', 'EndingAt', 'CompanyNumber', 'GUID'],
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
    allFields
      ? '*'
      : [
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
        ],
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
 */
export function buildVoucherTypeListRequest(options: TallyRequestOptions = {}): string {
  return buildCollectionRequest(
    'VoucherTypes',
    'VoucherType',
    ['Name', 'Parent', 'NumberingMethod', 'IsDeemedPositive'],
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
 * Vouchers for a date range. This is the reliable date-scoped voucher path.
 *
 * `EXPLODEFLAG` is deliberately NOT set. Exploding a voucher adds roughly
 * 50 KB of empty scaffolding apiece — around 200 blank date and tax elements
 * plus legacy cash-denomination counters — none of which this server reads.
 * A single month came back at 1.55 MB with it on. Callers needing inventory
 * detail will need a separate, explicitly-opted-in path.
 */
export function buildVoucherRegisterRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Voucher Register', options);
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
