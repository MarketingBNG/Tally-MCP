import { Decimal } from 'decimal.js';
import type { z } from 'zod';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import type { TallyClient } from '../tally/TallyClient.js';
import { TallyError } from '../tally/TallyError.js';
import {
  buildCompanyListRequest,
  buildCurrencyListRequest,
  type TallyRequestOptions,
} from '../tally/requests.js';
import { normalizeCompanies, normalizeCurrencies, type Normalized } from '../tally/normalize.js';
import { withQueryLog, type QueryScope } from '../tally/queryLog.js';
import { financialYearFor, todayIso, validateDateRange, type DateRange } from '../utils/dates.js';
import type { PaginatedResult } from '../utils/pagination.js';
import { DEFAULT_CURRENCY, type Money } from '../utils/numbers.js';
import type { conditionSchema } from '../schemas/common.js';

/**
 * Shared plumbing for data tools.
 *
 * Every tool answers the same three questions in the same way — what period
 * am I covering, what do I do when Tally fails, and how do warnings reach the
 * caller — so those answers live here rather than being restated (and
 * gradually diverging) in each tool.
 */

export interface ToolDeps {
  client: TallyClient;
  config: AppConfig;
  logger: Logger;
}

/**
 * The MCP content shape a tool handler returns.
 *
 * The index signature is required: the SDK's result type carries one, and a
 * named interface without it is not assignable to it.
 */
export interface ToolOutput {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * What a tool body hands back to `runTool`.
 *
 * `rows` and `truncated` are part of the return type rather than something a
 * body may optionally declare, so that a tool which forgets them does not
 * compile. Build Specification v1.0 §6 rule 4 exists because a sibling
 * connector truncated silently and a wrong figure reached a client workpaper;
 * a rule enforced by the type checker cannot be forgotten under deadline the
 * way a convention can.
 *
 * Only the tool knows what one row of its own answer is — a page of vouchers,
 * a statement's lines, the ledgers a search matched — which is why this is not
 * inferred centrally from the payload.
 */
export interface ToolBodyResult {
  /** The tool's own payload. Becomes the envelope's `data`, unchanged. */
  data: unknown;
  /** How many rows of accounting data the payload carries. */
  rows: number;
  /**
   * True when the caller did NOT receive everything that matched — a partial
   * page, a capped search, a clipped list. False means this is the whole
   * answer. Never a guess: if a tool cannot know, it must refuse rather than
   * report false.
   */
  truncated: boolean;
}

/**
 * The envelope every data tool returns, per Build Specification v1.0 §4.
 *
 * Field names are snake_case against the camelCase used everywhere else in
 * this codebase. That is deliberate: these six are an external contract shared
 * with the warehouse and reporting layers, named in the specification itself,
 * and consumers should not have to track a rename at the boundary.
 */
export interface ToolEnvelope {
  /** The tool's own payload, exactly as it was before this envelope existed. */
  data: unknown;
  /**
   * The company the figures belong to, by NAME — TallyPrime's company list
   * exposes no GUID, so there is no stabler identifier available here.
   * Null when it could not be resolved; never guessed.
   */
  company_id: string | null;
  /** When this answer was produced, ISO 8601. */
  as_of_timestamp: string;
  /**
   * When the underlying data was actually read from TallyPrime, ISO 8601.
   *
   * Distinct from `as_of_timestamp`, and the distinction is the point. Identical
   * requests are served from an in-process cache for `TALLY_CACHE_TTL_MS`
   * (default five minutes), which is what keeps a multi-question audit from
   * re-fetching the same 21MB voucher register for every question. The
   * consequence is that an answer produced now can rest on data read minutes ago,
   * and dating it `now` would be a false provenance claim in a workpaper.
   *
   * Always the OLDEST contribution: an answer is only as fresh as the stalest
   * thing in it. Null when nothing was read from TallyPrime at all.
   */
  data_fetched_at: string | null;
  /**
   * Every distinct request body sent to TallyPrime while producing this
   * answer, in the order first sent. Replaying these reproduces the figures.
   */
  source_query: string[];
  /** Rows of accounting data in `data`. */
  row_count: number;
  /** Whether anything that matched was withheld. See ToolBodyResult. */
  truncated: boolean;
}

/**
 * Resolve the period a tool should cover.
 *
 * With no dates, this defaults to the Indian financial year containing today,
 * matching what TallyPrime's own reports do. The resolved range is always
 * echoed back in the response so Claude reports the period it actually
 * received rather than assuming the one it asked for.
 *
 * A single supplied date is an error, not something to half-guess: filling in
 * the other end silently would produce a period nobody asked for.
 */
export function resolvePeriod(fromDate?: string, toDate?: string): DateRange {
  if (fromDate === undefined && toDate === undefined) {
    return financialYearFor(todayIso());
  }
  if (fromDate === undefined || toDate === undefined) {
    throw new TallyError(
      'INVALID_DATE_RANGE',
      'Supply both fromDate and toDate, or neither. Given only one, the server will not guess the other end of the period.'
    );
  }
  return validateDateRange(fromDate, toDate);
}

/** True when the caller supplied no dates, so `resolvePeriod` picked the period. */
export function periodWasDefaulted(fromDate?: string, toDate?: string): boolean {
  return fromDate === undefined && toDate === undefined;
}

/**
 * Explain an empty result that came back for a period nobody asked for.
 *
 * A TallyPrime company is commonly created per financial year — "Acme (25-26)"
 * — while the default period here is the financial year containing *today*.
 * Open a prior-year company after 1 April and the two no longer overlap, so
 * every date-defaulted query returns zero rows. Observed live: a company with
 * 453 vouchers in its own year reported nothing at all, because the default
 * period had moved past the end of its books.
 *
 * Silence there is the dangerous outcome — "no vouchers" reads as *the data is
 * missing*, not *you asked about the wrong year*. So an empty result for a
 * period the caller never chose is annotated with the company's actual start
 * date and a concrete range to retry with.
 *
 * Deliberately narrow. It fires only when the period was defaulted AND the
 * result is empty, which is also the only path that pays for the extra company
 * lookup — a genuinely empty year still gets the note, which is honest, since
 * this says the period was defaulted rather than claiming it was wrong.
 */
export async function noteEmptyDefaultedPeriod(
  deps: ToolDeps,
  period: DateRange,
  wasDefaulted: boolean,
  resultCount: number
): Promise<string[]> {
  if (!wasDefaulted || resultCount > 0) return [];

  let company;
  try {
    const response = await deps.client.send(buildCompanyListRequest(), 'standard');
    company = normalizeCompanies(response.body).data[0];
  } catch {
    // A diagnostic must never turn an empty-but-valid answer into a failure.
    return [];
  }

  if (company === undefined) return [];

  const books =
    company.startingFrom === null
      ? 'TallyPrime did not report when its books begin'
      : `its books begin ${company.startingFrom}`;

  const suggestion =
    company.startingFrom === null
      ? 'Supply fromDate and toDate covering the year you mean.'
      : (() => {
          const fy = financialYearFor(company.startingFrom);
          return `Retry with fromDate ${fy.fromDate} and toDate ${fy.toDate} to cover that company's own financial year.`;
        })();

  return [
    `No records for ${period.fromDate} to ${period.toDate} — a period you did not specify. ` +
      'With no dates given this server defaults to the financial year containing today, which ' +
      `may not be the year this company holds: the loaded company is "${company.name}" and ${books}. ` +
      `${suggestion} Do not report this as "no data" without checking the period first.`,
  ];
}

/**
 * Serialise a payload for the MCP boundary.
 *
 * Compact, not pretty-printed. Indentation is pure overhead here — the reader
 * is a model that parses JSON identically either way — and it is expensive
 * overhead: measured at 15% on dense records and over 50% on field-heavy ones,
 * spent entirely on whitespace inside a response that has a hard size ceiling.
 *
 * One function so the choice is made once. Every text payload this server
 * emits goes through here.
 */
export function serializeToolPayload(payload: unknown): string {
  return JSON.stringify(payload);
}

/** UTF-8 byte length, which is what a transport limit actually counts. */
function byteLengthOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Refuse a response the client would reject anyway.
 *
 * MCP clients cap tool result size — Claude Desktop at 1MB. When a result
 * breaches that, the client discards it: Claude never sees the data, and the
 * user gets a failure with nothing in it to act on. The record-count guard
 * (`assertResultSetFits`) cannot prevent this because it counts the wrong
 * thing; a page of 100 full-field vouchers is ~1.7MB and ~2% of the record
 * ceiling.
 *
 * So the size is checked here, at the one point every response passes through,
 * and an oversized one becomes a normal structured error. Where the payload
 * carries pagination metadata, the suggestion names the page size that would
 * actually fit — derived from the real measurement rather than guessed, so
 * Claude can retry once and succeed instead of bisecting.
 */
function assertResponseFits(text: string, toolName: string, maxBytes: number): void {
  const bytes = byteLengthOf(text);
  if (bytes <= maxBytes) return;

  throw new TallyError(
    'RESPONSE_TOO_LARGE',
    `${toolName} produced a ${describeSize(bytes)} response, above the ${describeSize(maxBytes)} ` +
      'limit for a single tool result. The data was retrieved successfully; it cannot be ' +
      'returned in one piece.',
    { suggestion: suggestSmallerRequest(text, bytes, maxBytes) }
  );
}

/**
 * Advice derived from the payload that was too big.
 *
 * Reads the `pagination` block the paginated tools already return, so the
 * suggested page size is arithmetic on a measured byte count rather than a
 * guess. The 0.8 factor is headroom: records vary in size, and a suggestion
 * that fails a second time is worse than a conservative one.
 */
function suggestSmallerRequest(text: string, bytes: number, maxBytes: number): string {
  const generic =
    'Narrow the request: set includeAllFields to false if it is on, use a shorter date range, ' +
    'or fetch a single record by name or number instead of a list.';

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return generic;
  }

  // The pagination block sits inside the envelope's `data`. The bare top-level
  // form is still accepted so this keeps working for any payload measured
  // before it is wrapped.
  type Paged = { pagination?: { pageSize?: unknown } } | null;
  const envelope = parsed as { data?: Paged } | null;
  const pagination = (envelope?.data ?? (parsed as Paged))?.pagination;
  const pageSize = pagination?.pageSize;
  if (typeof pageSize !== 'number' || pageSize < 1) return generic;

  const fits = Math.max(1, Math.floor((pageSize * maxBytes * 0.8) / bytes));
  return (
    `Retry with pageSize ${String(fits)} or lower (this page used pageSize ${String(pageSize)}). ` +
    'Setting includeAllFields to false, where the tool offers it, reduces the size far more ' +
    'than paging does.'
  );
}

/** Bytes as something a person can read in an error message. */
function describeSize(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)}MB`
    : `${String(Math.round(bytes / 1000))}KB`;
}

/**
 * Run a tool body, turning any failure into a structured payload.
 *
 * No exception escapes to the MCP boundary and no stack trace is ever
 * serialised — full detail goes to the local log, the caller gets a stable
 * code and a suggestion.
 *
 * Takes `deps` rather than just a logger so that the response-size ceiling is
 * enforced here for every tool, present and future, without any call site
 * having to remember to opt in.
 */
export async function runTool(
  toolName: string,
  deps: ToolDeps,
  body: () => Promise<ToolBodyResult>
): Promise<ToolOutput> {
  const startedAt = Date.now();

  // Held outside the try so that a failure still reports the requests that
  // were sent before it — those are the ones worth seeing in a diagnosis.
  const scope: QueryScope = { queries: [], oldestFetchAt: null };
  const queries = scope.queries;

  try {
    const result = await withQueryLog(scope, body);

    // Resolved outside the query log on purpose: this is metadata about the
    // answer, not one of the queries that produced it, and recording it would
    // put a request in `source_query` that reproduces none of the figures.
    const companyId = await resolveCompanyId(deps);

    const envelope: ToolEnvelope = {
      data: result.data,
      company_id: companyId,
      as_of_timestamp: new Date().toISOString(),
      source_query: distinct(queries),
      data_fetched_at:
        scope.oldestFetchAt === null ? null : new Date(scope.oldestFetchAt).toISOString(),
      row_count: result.rows,
      truncated: result.truncated,
    };

    const text = serializeToolPayload(envelope);
    assertResponseFits(text, toolName, deps.config.tallyMaxResponseBytes);

    deps.logger.debug('tool completed', {
      tool: toolName,
      bytes: byteLengthOf(text),
      rows: result.rows,
      truncated: result.truncated,
      elapsedMs: Date.now() - startedAt,
    });
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const tallyError = TallyError.from(error, `${toolName} failed.`);

    deps.logger.error('tool failed', {
      tool: toolName,
      code: tallyError.code,
      message: tallyError.message,
      elapsedMs: Date.now() - startedAt,
    });

    // The error payload carries the same provenance fields as a success.
    // `data` and `row_count` are absent rather than zero — nothing was
    // returned, and a 0 there would read as "asked, found nothing".
    return {
      content: [
        {
          type: 'text',
          text: serializeToolPayload({
            ...tallyError.toClientPayload(),
            company_id: await resolveCompanyId(deps),
            as_of_timestamp: new Date().toISOString(),
            source_query: distinct(queries),
            data_fetched_at:
              scope.oldestFetchAt === null ? null : new Date(scope.oldestFetchAt).toISOString(),
          }),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Build a body result from a page, deriving both counts from the page itself.
 *
 * The paginated tools all answer `rows` and `truncated` the same way — the
 * slice they are returning, and whether more of it remains — so they share
 * this rather than restating it and risking one of them drifting. `hasMore` is
 * exactly the §6 rule 4 question: did the caller get everything that matched?
 */
export function fromPage<T>(page: PaginatedResult<T>, extra: object = {}): ToolBodyResult {
  return {
    data: { ...page, ...extra },
    rows: page.items.length,
    truncated: page.pagination.hasMore,
  };
}

/**
 * Build a body result for a tool that returns a complete, unpaginated answer.
 *
 * `truncated` is hard-coded false, which is only honest where the tool has no
 * cap of its own — a single named record, a whole statement. A tool that caps
 * anything must not use this.
 */
export function whole(data: unknown, rows: number): ToolBodyResult {
  return { data, rows, truncated: false };
}

/** Preserve first-sent order while dropping repeats of the same request. */
function distinct(bodies: readonly string[]): string[] {
  return [...new Set(bodies)];
}

/**
 * Name the company the figures belong to.
 *
 * TallyPrime serves one company at a time, so the loaded company IS the scope
 * of every answer — there is nothing to disambiguate against the caller's
 * `company` argument, which `assertCompanyIsLoaded` has already checked
 * matches. Nearly always free: any tool that touched the company list has it
 * in TallyClient's TTL cache by the time this runs.
 *
 * Never throws. A tool that produced a correct answer must not be turned into
 * a failure by a metadata lookup, so an unresolvable company is reported as
 * null — which the envelope documents as "not resolved", not "none".
 */
async function resolveCompanyId(deps: ToolDeps): Promise<string | null> {
  try {
    const response = await deps.client.send(buildCompanyListRequest(), 'standard');
    return normalizeCompanies(response.body).data[0]?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Check that a named company is the one TallyPrime currently has loaded.
 *
 * Only called when the caller actually names a company — with no name, Tally
 * uses whatever is loaded and there is nothing to verify, so the extra
 * round trip is skipped entirely.
 *
 * The validation is done **here rather than by asking Tally**, deliberately.
 * TallyPrime serves one company at a time, so a request scoped to a company
 * it does not have open cannot succeed; and sending unverified names into
 * Tally's request path is the behaviour that has already been observed to
 * take the application down. Comparing against the loaded list first means an
 * unknown name never reaches Tally at all, and the caller gets a precise
 * error naming what *is* loaded.
 */
export async function assertCompanyIsLoaded(
  deps: ToolDeps,
  company: string | undefined
): Promise<void> {
  if (company === undefined || company === '') return;

  const response = await deps.client.send(buildCompanyListRequest(), 'standard');
  const loaded = normalizeCompanies(response.body).data.map((entry) => entry.name);

  const matches = loaded.some((name) => name.toLowerCase() === company.toLowerCase());
  if (matches) return;

  const available =
    loaded.length === 0
      ? 'no company is currently loaded'
      : `currently loaded: ${loaded.join(', ')}`;

  throw new TallyError(
    'TALLY_COMPANY_NOT_LOADED',
    `TallyPrime does not have "${company}" open — ${available}.`,
    {
      suggestion:
        'Open that company in TallyPrime and try again. Tally serves data only for the company it currently has loaded, so this server cannot switch companies on your behalf.',
      context: { requested: company, loaded },
    }
  );
}

/**
 * The base currency of the loaded company, for labelling every figure returned.
 *
 * Exists because the label used to be a hard-coded `INR`. Verified live
 * 2026-08-13: a US company keeping books in dollars had every balance returned as
 * `"currency": "INR"`. Nothing was converted — the arithmetic was right and only
 * the label lied — which is the worse kind of wrong, because a plausible label is
 * believed. §6 rule 1 forbids this server inventing figures, and inventing the
 * unit a figure is denominated in is the same offence.
 *
 * Cheap to call repeatedly: it is the company-list request every other guard
 * already makes, so TallyClient's cache serves it (measured 0 ms on a hit).
 *
 * Falls back to `DEFAULT_CURRENCY` when Tally does not report one, which is the
 * old behaviour and is right for the Indian installs this was built against.
 * There is no warning on the fallback: on an Indian company INR is correct, and a
 * warning on every figure would be noise that trains the reader to ignore it.
 */
/**
 * Warn when this company defines more than one currency.
 *
 * Tally does not report a per-voucher currency on these books — probed live
 * 2026-08-13, no CURRENCYNAME or FOREX element appears on any voucher or entry — so
 * this server CANNOT tell a foreign-currency transaction from a base-currency one and
 * labels every figure with the company's base currency.
 *
 * On a single-currency company that is exactly right, and silent is correct. On a
 * multi-currency company it is a real mislabelling risk on every figure, so it is
 * disclosed. Detecting it is the honest half of a problem that cannot be solved
 * without a per-transaction field Tally does not send: the reader is told the label
 * may be wrong instead of being left to assume it is right.
 *
 * Guessing at a field name to "handle" forex is exactly what this project does not
 * do — see docs/known-limitations.md.
 */
async function noteMultiCurrency(
  deps: ToolDeps,
  base: string,
  warnings: string[]
): Promise<void> {
  try {
    const response = await deps.client.send(buildCurrencyListRequest(), 'standard');
    const currencies = normalizeCurrencies(response.body).data;
    if (currencies.length <= 1) return;

    const names = currencies.map((entry) => entry.name).join(', ');
    warnings.push(
      `This company defines ${String(currencies.length)} currencies (${names}) and every figure here is labelled with the base currency "${base}". TallyPrime does not report a per-transaction currency over this interface, so a transaction recorded in a different currency cannot be distinguished and may be labelled "${base}" incorrectly. Amounts are never converted. Check the currency on any figure that matters before relying on it.`
    );
  } catch (error) {
    // The currency list is a nicety; failing to read it must not fail the answer.
    deps.logger.debug('could not read the currency list', { error: String(error) });
  }
}

export async function resolveCompanyCurrency(
  deps: ToolDeps,
  company: string | undefined,
  /**
   * Collects the multi-currency caveat when there is one. Optional so a caller that
   * only needs the label — and has nowhere to put a warning — stays unaffected.
   */
  warnings?: string[]
): Promise<string> {
  try {
    const response = await deps.client.send(buildCompanyListRequest(), 'standard');
    const companies = normalizeCompanies(response.body).data;

    const match =
      company === undefined || company === ''
        ? companies[0]
        : companies.find((entry) => entry.name.toLowerCase() === company.toLowerCase());

    const currency = match?.currency?.trim();
    const base = currency === undefined || currency === '' ? DEFAULT_CURRENCY : currency;

    if (warnings !== undefined) await noteMultiCurrency(deps, base, warnings);

    return base;
  } catch (error) {
    // A figure with a slightly wrong LABEL is recoverable; refusing the whole
    // answer because the currency probe failed is not. Every caller has already
    // proved Tally is reachable, so this only fires on an odd response shape.
    deps.logger.debug('could not resolve the company currency; using the default', {
      error: String(error),
    });
    return DEFAULT_CURRENCY;
  }
}

/**
 * Guard a fully-fetched result set against the in-memory ceiling.
 *
 * Tally cannot paginate, so the check necessarily happens *after* the fetch:
 * the size is unknowable until the whole payload is in hand. Refusing here
 * still protects the caller from being handed an unusable wall of records,
 * and the message says how to narrow the query.
 */
export function assertResultSetFits(count: number, config: AppConfig, hint: string): void {
  if (count > config.tallyMaxRecords) {
    throw new TallyError(
      'RESULT_LIMIT_EXCEEDED',
      `TallyPrime returned ${String(count)} records, above the limit of ${String(config.tallyMaxRecords)}.`,
      { suggestion: hint }
    );
  }
}

/**
 * One full fetch of a master collection: confirm the company, build, send,
 * normalise, and merge the parser's repairs into the warnings.
 *
 * Every master fetcher (ledgers, groups, stock items) did these five steps
 * identically, differing only in builder, normaliser and timeout class — so
 * they share this and keep only their own naming. Identical fetches within
 * TALLY_CACHE_TTL_MS are served from TallyClient's cache rather than re-sent,
 * which is what makes the multi-fetch tools affordable.
 */
export async function fetchCollection<T>(
  deps: ToolDeps,
  company: string | undefined,
  spec: {
    build: (options: TallyRequestOptions) => string;
    /**
     * `currency` is the loaded company's own, resolved here so no fetcher has to
     * remember to do it. A normaliser that returns no money may ignore it.
     */
    normalize: (xml: string, currency: string) => Normalized<T[]>;
    /**
     * Full-field fetches are large enough to deserve the report timeout;
     * curated ones are not. Defaults to the standard timeout.
     */
    timeoutClass?: 'standard' | 'report';
  }
): Promise<Normalized<T[]>> {
  await assertCompanyIsLoaded(deps, company);

  const request = spec.build({
    ...(company === undefined ? {} : { company }),
    format: deps.config.tallyPreferredFormat,
  });

  const currencyWarnings: string[] = [];
  const currency = await resolveCompanyCurrency(deps, company, currencyWarnings);
  const response = await deps.client.send(request, spec.timeoutClass ?? 'standard');
  const { data, warnings } = spec.normalize(response.body, currency);

  return { data, warnings: [...response.repairs, ...currencyWarnings, ...warnings] };
}

/**
 * Find a named record, exact match first, then case-insensitively.
 *
 * The fallback matters: TallyPrime preserves the capitalisation a user typed,
 * so requiring an exact match would report a real ledger as missing over a
 * difference in case. Preferring the exact match first keeps two records that
 * differ only in capitalisation resolvable.
 */
export function findByName<T>(
  records: readonly T[],
  name: string,
  nameOf: (record: T) => string
): T | undefined {
  const lowered = name.toLowerCase();
  return (
    records.find((record) => nameOf(record) === name) ??
    records.find((record) => nameOf(record).toLowerCase() === lowered)
  );
}

/**
 * Generic field-condition filter, shared by the merged master tools
 * (tally_get_ledgers / tally_get_groups / tally_get_stock_items).
 *
 * Deliberately NOT a SQL or freeform query layer: each dataset exposes a
 * fixed, small field allowlist via `DatasetSpec`, and this only evaluates
 * conditions against that allowlist — never an arbitrary Tally
 * report/collection ID.
 */
export type FieldType = 'string' | 'money' | 'boolean';

export interface FieldSpec<T> {
  type: FieldType;
  get: (record: T) => string | boolean | Money | null;
}

export type DatasetSpec<T> = Record<string, FieldSpec<T>>;

type Op = z.infer<typeof conditionSchema>['op'];

const STRING_OPS: readonly Op[] = ['eq', 'neq', 'contains', 'isNull', 'isNotNull'];
const NUMERIC_OPS: readonly Op[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'isNotNull'];
const BOOLEAN_OPS: readonly Op[] = ['eq', 'neq', 'isNull', 'isNotNull'];

const OPS_BY_TYPE: Record<FieldType, readonly Op[]> = {
  string: STRING_OPS,
  money: NUMERIC_OPS,
  boolean: BOOLEAN_OPS,
};

function moneyAmount(value: Money | null): Decimal | null {
  return value === null ? null : new Decimal(value.amount);
}

function evaluateCondition(
  fieldName: string,
  fieldType: FieldType,
  raw: string | boolean | Money | null,
  op: Op,
  compareTo: string | number | boolean | undefined
): boolean {
  if (op === 'isNull') return raw === null;
  if (op === 'isNotNull') return raw !== null;

  if (raw === null) return false;

  if (fieldType === 'string') {
    const actual = (raw as string).toLowerCase();
    if (typeof compareTo !== 'string') {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `Condition on "${fieldName}" needs a string value for op "${op}".`
      );
    }
    const expected = compareTo.toLowerCase();
    if (op === 'eq') return actual === expected;
    if (op === 'neq') return actual !== expected;
    if (op === 'contains') return actual.includes(expected);
    throw new TallyError(
      'INVALID_PARAMETERS',
      `Op "${op}" is not valid for string field "${fieldName}".`
    );
  }

  if (fieldType === 'boolean') {
    if (typeof compareTo !== 'boolean') {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `Condition on "${fieldName}" needs a boolean value for op "${op}".`
      );
    }
    if (op === 'eq') return raw === compareTo;
    if (op === 'neq') return raw !== compareTo;
    throw new TallyError(
      'INVALID_PARAMETERS',
      `Op "${op}" is not valid for boolean field "${fieldName}".`
    );
  }

  // Money.
  if (typeof compareTo !== 'number') {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `Condition on "${fieldName}" needs a numeric value for op "${op}".`
    );
  }
  const actual = moneyAmount(raw as Money);
  if (actual === null) return false;
  const expected = new Decimal(compareTo);
  if (op === 'eq') return actual.equals(expected);
  if (op === 'neq') return !actual.equals(expected);
  if (op === 'gt') return actual.greaterThan(expected);
  if (op === 'gte') return actual.greaterThanOrEqualTo(expected);
  if (op === 'lt') return actual.lessThan(expected);
  if (op === 'lte') return actual.lessThanOrEqualTo(expected);
  throw new TallyError(
    'INVALID_PARAMETERS',
    `Op "${op}" is not valid for money field "${fieldName}".`
  );
}

export function applyConditions<T>(
  records: readonly T[],
  dataset: DatasetSpec<T>,
  conditions: readonly z.infer<typeof conditionSchema>[]
): T[] {
  for (const condition of conditions) {
    const spec = dataset[condition.field];
    if (!spec) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `Unknown field "${condition.field}" for this dataset.`,
        { suggestion: `Valid fields: ${Object.keys(dataset).join(', ')}` }
      );
    }
    if (!OPS_BY_TYPE[spec.type].includes(condition.op)) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `Op "${condition.op}" is not valid for field "${condition.field}" (a ${spec.type} field).`,
        { suggestion: `Valid ops for ${spec.type}: ${OPS_BY_TYPE[spec.type].join(', ')}` }
      );
    }
  }

  return records.filter((record) =>
    conditions.every((condition) => {
      const spec = dataset[condition.field];
      if (!spec) return false;
      return evaluateCondition(
        condition.field,
        spec.type,
        spec.get(record),
        condition.op,
        condition.value
      );
    })
  );
}
