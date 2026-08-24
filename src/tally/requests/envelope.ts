import { isoToTallyDate } from '../../utils/dates.js';

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

/**
 * The envelope every request shares, and the Export-only guarantee it carries.
 *
 * Split out of requests.ts at 736 lines. `EXPORT_ONLY` is the load-bearing
 * constant in this whole directory: it is the reason nothing this server sends
 * can modify Tally data, and `FORBIDDEN_WRITE_VERBS` exists so a test can prove
 * none of them ever appears in a built body.
 */

/** The only request verb this server ever issues. */
export const EXPORT_ONLY = 'Export' as const;

/** Verbs that would modify Tally data. Present only so tests can assert absence. */
export const FORBIDDEN_WRITE_VERBS = ['Import', 'Alter', 'Delete', 'Create'] as const;

export type TallyWireFormat = 'xml' | 'json';

/**
 * Deliberately not scoped to any company.
 *
 * A unique symbol rather than `undefined`, and that is the entire point — see
 * `CompanyScope` below.
 */
export const UNSCOPED: unique symbol = Symbol('UNSCOPED');

/**
 * Which company a request is for, as an explicit choice that cannot be skipped.
 *
 * ## The bug this shape exists to make unwriteable
 *
 * `company` used to be optional, and every builder defaulted its whole options
 * object to `{}`. So `buildLedgerListRequest({ format })` compiled, sent no
 * `SVCURRENTCOMPANY`, and TallyPrime answered from whichever company it had
 * current. That is exactly how `tally_get_company` came to report one company's
 * 472 ledgers under another company’s name (pinned in
 * tests/tools/companyScoping.test.ts) — the call site did
 * not decide to be unscoped, it simply forgot to say.
 *
 * Worse, an unscoped request body is byte-identical whichever company was
 * asked about, so the response cache — keyed on the body — then served the
 * second company the first one's data. The wrong answer was reproducible.
 *
 * An optional field cannot express the difference between "no company, on
 * purpose" and "I forgot". This type can: every scopable builder now REQUIRES
 * `company`, and passing `UNSCOPED` is how a caller states that global scope is
 * intended. Forgetting is a compile error rather than a silent wrong answer.
 *
 * Only two requests are legitimately unscoped — the company list itself and the
 * connection probe — and both say so in their own code below.
 */
export type CompanyScope = string | typeof UNSCOPED;

export interface TallyRequestOptions {
  /**
   * Company to scope the request to, or `UNSCOPED` to state that no scope is
   * intended. REQUIRED — see `CompanyScope` for why this is not optional.
   *
   * Must be TallyPrime's own spelling of the name. Tally matches
   * `SVCURRENTCOMPANY` exactly and answers from the loaded company on a
   * mismatch rather than erroring, so pass what `assertCompanyIsLoaded`
   * returned, never the caller's own string.
   */
  company: CompanyScope;
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
export function staticVariables(options: TallyRequestOptions): string {
  const parts: string[] = [];

  // SVEXPORTFORMAT selects the wire format. $$SysName:JSON is only honoured
  // by TallyPrime 7.0+; older builds ignore it and return XML, which the
  // client detects and handles rather than failing.
  parts.push(
    options.format === 'json'
      ? '<SVEXPORTFORMAT>$$SysName:JSON</SVEXPORTFORMAT><SVEXPORTINPLAINFORMAT>Yes</SVEXPORTINPLAINFORMAT>'
      : '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>'
  );

  /*
   * A missing company is a PROGRAMMING error and is raised as one.
   *
   * The type makes `company` required, so this is unreachable from TypeScript.
   * It is here because of what the alternative would do: with `company`
   * undefined, the template below would emit the literal
   * `<SVCURRENTCOMPANY>undefined</SVCURRENTCOMPANY>`, TallyPrime would find no
   * company by that name, and — verified behaviour — it answers from whichever
   * company is loaded rather than erroring. That is precisely the silent
   * wrong-company read this whole type exists to prevent, reintroduced through
   * an untyped call site.
   *
   * Failing loudly here is the conservative choice: a thrown error is caught by
   * `runTool` and surfaced as a typed refusal, which is strictly better than a
   * plausible figure attributed to the wrong entity.
   */
  if (options.company === undefined || options.company === null) {
    throw new Error(
      'A Tally request was built with no company scope. Pass the resolved company name, or ' +
        'UNSCOPED to state that global scope is intended — see CompanyScope in requests.ts.'
    );
  }

  // UNSCOPED is the only way to omit the tag, and it has to be said out loud.
  // An empty string is treated as unscoped too rather than emitted as an empty
  // tag, which TallyPrime rejects in a way that cannot be diagnosed remotely.
  if (options.company !== UNSCOPED && options.company !== '') {
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
export function buildReportRequest(reportId: string, options: TallyRequestOptions): string {
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
  options: TallyRequestOptions,
  /**
   * How the requested fields are spelled on the wire.
   *
   * `nativeMethod` (the default) emits one `<NATIVEMETHOD>` per field, which is
   * what the master collections use. `commaFetch` emits the whole list inside a
   * single `<FETCH>a,b,c</FETCH>`.
   *
   * Both forms are in production and neither is a stylistic preference: the
   * voucher collection and the two AlterId fingerprint requests are the
   * comma-form callers, and they were verified live in that shape. Changing how
   * a working request is spelled is not a refactor — it is a live behaviour
   * change against an interface that answers an unrecognised request with an
   * empty report rather than an error. So the form each caller was proven with
   * is preserved exactly, and only the envelope around it is shared.
   */
  fetchMode: 'nativeMethod' | 'commaFetch' = 'nativeMethod'
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
    fetchMode === 'commaFetch'
      ? `<FETCH>${escapeXml(requested.join(','))}</FETCH>`
      : wildcard +
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
    // Genuinely global: this asks whether Tally is answering at all, which is
    // not a question about any company's books.
    { company: UNSCOPED }
  );
}
