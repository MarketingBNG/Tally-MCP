import { Decimal } from 'decimal.js';
import type { z } from 'zod';
import { currencyLabelFor, type AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import type { TallyClient } from '../tally/TallyClient.js';
import { TallyError } from '../tally/TallyError.js';
import {
  buildCompanyListRequest,
  buildCurrencyListRequest,
  type TallyRequestOptions,
} from '../tally/requests.js';
import {
  normalizeCompanies,
  normalizeCurrencies,
  type Company,
  type Normalized,
} from '../tally/normalize.js';
import { withQueryLog, type QueryScope } from '../tally/queryLog.js';
import {
  bookYearFor,
  financialYearFor,
  todayIso,
  validateDateRange,
  type DateRange,
} from '../utils/dates.js';
import type { PaginatedResult } from '../utils/pagination.js';
import {
  currencyIsUnavailable,
  DEFAULT_CURRENCY,
  UNKNOWN_CURRENCY,
  type Money,
} from '../utils/numbers.js';
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
 * The one company every "which company is this?" answer must agree on.
 *
 * ## The bug this exists to prevent
 *
 * Every site below used to take `companies[0]` — the first company in Tally's
 * list — on the premise, written into the comments, that "TallyPrime serves one
 * company at a time, so the loaded company IS the scope of the answer". That
 * premise is false. TallyPrime holds several companies open at once, and
 * `SVCURRENTCOMPANY` picks between them per request.
 *
 * With one company loaded, `companies[0]` was always right. With three loaded it
 * is whichever sorts first, regardless of which one was asked about — so a
 * request scoped to a US company came back with its figures correctly fetched and
 * the envelope naming a GERMAN company. Right numbers, wrong name on them, no
 * error raised. That is the single worst output this connector can produce, and
 * it survived a full test suite because every fixture had one company.
 *
 * ## How the company is determined now
 *
 * From the requests that were actually sent. Every request scoped to a company
 * carries `<SVCURRENTCOMPANY>`, so the sent bodies are ground truth about what
 * was asked — better evidence than anything re-derived afterwards.
 *
 * When nothing was scoped, there is a real fork:
 * - exactly one company loaded → that is unambiguously the answer;
 * - more than one loaded → TallyPrime answered from whichever company is ACTIVE
 *   on the desktop, and nothing in the response says which. So the answer is
 *   `null`, meaning "not resolved". Guessing here is what caused the bug.
 */
function companyFromSentRequests(bodies: readonly string[]): string | null {
  const named = new Set<string>();
  for (const body of bodies) {
    const match = /<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/.exec(body);
    const name = match?.[1]?.trim();
    if (name !== undefined && name !== '') named.add(name);
  }
  // Several distinct companies means a genuinely multi-company answer, which no
  // single company_id describes. Null is the honest value, not the first one.
  return named.size === 1 ? ([...named][0] ?? null) : null;
}

/**
 * The loaded company when — and only when — there is exactly one.
 *
 * Returns null with several loaded, because which one TallyPrime would answer
 * from is not knowable from the company list.
 */
async function soleLoadedCompany(deps: ToolDeps): Promise<Company | null> {
  const response = await deps.client.send(buildCompanyListRequest(), 'standard');
  const companies = normalizeCompanies(response.body).data;
  return companies.length === 1 ? (companies[0] ?? null) : null;
}

/** The company record a name refers to, or null. Never guesses. */
export async function companyNamed(deps: ToolDeps, name: string | undefined): Promise<Company | null> {
  const response = await deps.client.send(buildCompanyListRequest(), 'standard');
  const companies = normalizeCompanies(response.body).data;
  if (name === undefined || name === '') {
    return companies.length === 1 ? (companies[0] ?? null) : null;
  }
  return companies.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * The loaded company's own book year, or null when it cannot be determined.
 *
 * Twelve months anchored on the month and day the company's books begin, ending
 * with the year that contains the last date it holds data for. Derived from the
 * company's own `startingFrom` and `endingAt`, never from an assumed 1 April.
 *
 * Never throws. A tool that could answer must not fail because a metadata
 * lookup did, so an unreadable company yields null and the caller falls back.
 *
 * Cheap in practice: this is the same company-list request every other guard
 * already makes, so TallyClient's cache serves it (measured 0 ms on a hit).
 */
export async function companyBookYear(
  deps: ToolDeps,
  /**
   * Which company's year. Omitted is only safe with ONE company loaded — with
   * several, the book years differ (a German calendar year against an Indian
   * April year), so defaulting to the first would silently answer about the
   * wrong twelve months.
   */
  company?: string
): Promise<DateRange | null> {
  try {
    const record = await companyNamed(deps, company);
    if (record === null) return null;
    const startingFrom = record.startingFrom ?? null;
    if (startingFrom === null) return null;
    // endingAt anchors the year, not today's date: a company holding 2019 books
    // does not become a 2026 company because someone opened it today.
    return bookYearFor(startingFrom, record.endingAt ?? startingFrom);
  } catch {
    return null;
  }
}

/**
 * Resolve the period a tool should cover, defaulting to the COMPANY'S own year.
 *
 * Prefer this over the synchronous `resolvePeriod` in any tool that reads dated
 * data. The difference matters for every company that does not keep an Indian
 * April-to-March year:
 *
 * `resolvePeriod` defaults to `financialYearFor(today)`, which is hard-coded to
 * 1 April – 31 March. A US company on a calendar year, asked a question with no
 * dates, therefore gets a window straddling two of its own years — the second
 * half of one and the first half of the next — and every total is a blend of
 * two reporting periods with nothing saying so. The company this server is most
 * often pointed at is a US LLC, so this was the default in practice.
 *
 * `tally_check_tie_out` already did the right thing by hand; this makes the same
 * behaviour available to every tool instead of one.
 *
 * Costs nothing when dates ARE supplied: the company lookup happens only on the
 * defaulting path.
 */
export async function resolvePeriodForCompany(
  deps: ToolDeps,
  fromDate?: string,
  toDate?: string,
  /**
   * Whose book year to default to. Omitting it is safe only when ONE company is
   * loaded: the three companies seen live run a German calendar year, a US
   * April year and an Indian April year, so defaulting to "the first company"
   * would answer about the wrong twelve months without saying so.
   */
  company?: string
): Promise<DateRange> {
  // Explicit dates need no company at all — validate and return, no round trip.
  if (fromDate !== undefined || toDate !== undefined) {
    return resolvePeriod(fromDate, toDate);
  }

  // Falls back to the Indian year only when the company cannot be read, which
  // preserves the previous behaviour rather than failing the call.
  return (await companyBookYear(deps, company)) ?? financialYearFor(todayIso());
}

/**
 * Resolve the period a tool should cover, without consulting the company.
 *
 * Prefer `resolvePeriodForCompany`: this defaults to the Indian financial year
 * containing today, which is wrong for any company not on an April-to-March
 * year. Kept for the validation-only path and for callers that have already
 * resolved a default themselves.
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
  resultCount: number,
  /** Which company the caller asked about, if any. */
  forCompany?: string
): Promise<string[]> {
  if (!wasDefaulted || resultCount > 0) return [];

  let company: Company | null;
  try {
    // By name where one was given. With several loaded and none named, there is
    // no company to describe, and naming the wrong one's book dates in a
    // diagnostic is how a user gets sent to check the wrong set of books.
    company = await companyNamed(deps, forCompany);
  } catch {
    // A diagnostic must never turn an empty-but-valid answer into a failure.
    return [];
  }

  if (company === null) return [];

  const books =
    company.startingFrom === null
      ? 'TallyPrime did not report when its books begin'
      : `its books begin ${company.startingFrom}`;

  const suggestion =
    company.startingFrom === null
      ? 'Supply fromDate and toDate covering the year you mean.'
      : (() => {
          // The company's own twelve-month year, anchored on the month its books
          // begin — not 1 April. Assuming April here produced a suggested range
          // that did not contain the company's data at all on a calendar-year
          // company, which is worse than making no suggestion.
          const year = bookYearFor(company.startingFrom, company.endingAt ?? company.startingFrom);
          return `Retry with fromDate ${year.fromDate} and toDate ${year.toDate} to cover that company's own book year.`;
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
    const companyId = await resolveCompanyId(deps, queries);

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
            company_id: await resolveCompanyId(deps, scope.queries),
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
 * **Corrected 14 Aug 2026.** This used to read "TallyPrime serves one company at a
 * time, so the loaded company IS the scope of every answer" and take the first
 * company in the list. With three companies loaded that produced AgEx Pharma's
 * figures under AGBV Nutrition's name — the wrong-attribution failure this whole
 * codebase is written to avoid, shipped and unnoticed because every fixture had a
 * single company. See `companyFromSentRequests`.
 *
 * Never throws. A tool that produced a correct answer must not be turned into a
 * failure by a metadata lookup, so an unresolvable company is reported as null —
 * which the envelope documents as "not resolved", not "none". Null is also the
 * right answer, not a degradation, when several companies are loaded and the
 * request named none of them: nothing in the response says which one answered.
 */
async function resolveCompanyId(
  deps: ToolDeps,
  /** The request bodies this answer was actually built from. */
  sentBodies: readonly string[]
): Promise<string | null> {
  // Ground truth first: what the requests were scoped to.
  const scoped = companyFromSentRequests(sentBodies);
  if (scoped !== null) return scoped;

  try {
    // Nothing scoped. Safe only when there is exactly one company to mean.
    return (await soleLoadedCompany(deps))?.name ?? null;
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
 *
 * ## Returns the CANONICAL name, and callers must use it
 *
 * This used to return void, so the caller's own spelling continued on to
 * `SVCURRENTCOMPANY`. That is a wrong-attribution bug, because the match here is
 * case-INSENSITIVE while **TallyPrime matches the company name exactly**, and on
 * a mismatch Tally does not raise an error — it silently answers from whichever
 * company is loaded. So `company: "mudals technologies private limited"` passed
 * this check, went to Tally in that casing, and produced real figures labelled
 * with the caller's spelling rather than the company's own.
 *
 * With one company loaded the figures happened to be right. With two loaded it is
 * a silent wrong-company answer, which is the one failure a group comparison
 * could never survive — and the reason the multi-company tool must not ship until
 * this is in place.
 *
 * Also trims the input before comparing. Company names created by copy-paste
 * frequently carry a trailing CR or LF, and a trailing-whitespace mismatch is
 * documented to make Tally reject `SVCURRENTCOMPANY` in a way that is impossible
 * to diagnose from outside.
 *
 * @returns the exact name as TallyPrime spells it, or undefined when no company
 * was named (in which case Tally uses whatever is loaded and there is nothing to
 * canonicalise).
 */
export async function assertCompanyIsLoaded(
  deps: ToolDeps,
  company: string | undefined
): Promise<string | undefined> {
  if (company === undefined || company === '') return undefined;

  // Trim first: the comparison, the error message and the returned name must all
  // agree about what was asked for.
  const requested = company.trim();
  if (requested === '') return undefined;

  const response = await deps.client.send(buildCompanyListRequest(), 'standard');
  const loaded = normalizeCompanies(response.body).data.map((entry) => entry.name);

  // Return Tally's spelling, never the caller's — see the note above.
  const match = loaded.find((name) => name.toLowerCase() === requested.toLowerCase());
  if (match !== undefined) return match;

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

    // A "?" in this list is a symbol TallyPrime substituted, not a currency named
    // "?" — worth saying, because a bare list of symbols invites the reader to
    // treat it as one.
    const names = currencies
      .map((entry) => (currencyIsUnavailable(entry.name) ? `${entry.name} (symbol not transportable)` : entry.name))
      .join(', ');
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

    // Never `companies[0]` on the unnamed path. Currencies differ per company —
    // dollars, euros, rupees across the three seen live — so picking the first
    // would label one company's figures in another's currency.
    const match =
      company === undefined || company === ''
        ? companies.length === 1
          ? companies[0]
          : undefined
        : companies.find((entry) => entry.name.toLowerCase() === company.toLowerCase());

    if (match === undefined && companies.length > 1) {
      warnings?.push(
        'CURRENCY NOT ESTABLISHED: several companies are loaded in TallyPrime and this request ' +
          'did not name one, so which company answered — and therefore which currency these ' +
          `figures are in — cannot be determined. They are labelled "${UNKNOWN_CURRENCY}" rather ` +
          'than assuming. Name the company to get a currency on them.'
      );
      return UNKNOWN_CURRENCY;
    }

    const currency = match?.currency?.trim();

    /*
     * A symbol TallyPrime could not transport is reported as unknown, not passed
     * through and not defaulted.
     *
     * Passing it through labels every figure `"currency": "?"`, which reads as
     * data. Defaulting it is worse: it would label a euro company's balances INR,
     * the precise bug fixed on 2026-08-13. Saying "unknown" and naming the country
     * lets the reader supply the currency from the books, which is the only place
     * the answer actually exists.
     */
    if (currencyIsUnavailable(currency)) {
      // The operator may have supplied the label the books actually use. It is
      // consulted ONLY here — never where Tally sent a symbol successfully — so
      // a setting left over from another company cannot relabel figures whose
      // currency Tally reported perfectly well.
      const rule = currencyLabelFor(
        deps.config.tallyCurrencyLabel,
        match?.name,
        companies.length
      );
      const label = rule?.label ?? UNKNOWN_CURRENCY;

      if (warnings !== undefined) {
        const where =
          match?.country === null || match?.country === undefined || match.country === ''
            ? 'TallyPrime did not report a country either'
            : `TallyPrime reports the country as ${match.country}`;

        const unlabelled =
          `The base currency of "${match?.name ?? 'this company'}" could not be read: ` +
          `TallyPrime reported the symbol as "${currency ?? ''}", which is a substitution ` +
          'rather than a symbol — the character is not in the codepage TallyPrime exports ' +
          'with, and it is replaced before the data leaves TallyPrime, so no setting here ' +
          `can recover it. Every figure in this response is therefore labelled ` +
          `"${UNKNOWN_CURRENCY}". ${where}. Amounts are exact and are never converted — ` +
          "only the label is missing. State the currency from the company's own records " +
          'when quoting any figure, and do NOT assume a currency from the country: this ' +
          'company also defines other currencies.';

        if (rule === null) {
          warnings.push(
            deps.config.tallyCurrencyLabel === undefined
              ? `${unlabelled} To have the label filled in for you, set TALLY_CURRENCY_LABEL in ` +
                  'the server configuration.'
              : // Set, but not applicable here. Saying WHY matters: an operator
                // who has configured a label and still sees "unknown" will
                // otherwise assume the setting is broken.
                `${unlabelled} TALLY_CURRENCY_LABEL IS SET BUT DOES NOT APPLY TO THIS COMPANY. ` +
                  `TallyPrime has ${String(companies.length)} companies loaded, so a bare label ` +
                  'cannot be attributed to one of them — and it must not be guessed, because a ' +
                  'German and an Indian company both report their symbol as "?" and a bare "EUR" ' +
                  'would label rupees EUR. Name the companies instead, as ' +
                  '"Company Name=EUR;Other Company=INR".'
          );
        } else {
          warnings.push(
            'CURRENCY LABEL SUPPLIED BY CONFIGURATION, NOT BY TALLYPRIME. TallyPrime could ' +
              `not transport the symbol for "${match?.name ?? 'this company'}" — it reported ` +
              `"${currency ?? ''}", a substitution made before the data left TallyPrime — so ` +
              `every figure here is labelled "${rule.label}" from TALLY_CURRENCY_LABEL in this ` +
              `server's configuration. ${where}. Amounts are exact and nothing is converted; ` +
              'the label is the only part that did not come from Tally. ' +
              (rule.scope === 'named-company'
                ? 'The setting names this company specifically, so it cannot be confused with ' +
                  'another company loaded alongside it.'
                : 'The setting is a bare label and was applied because this is the only company ' +
                  'TallyPrime has loaded. If a second company is opened, it stops applying and ' +
                  'figures go back to being labelled "unknown" — name the companies in the ' +
                  'setting to avoid that.')
          );
        }
      }
      // Still worth reporting a multi-currency company, and the base label it
      // would be compared against is whatever was resolved above.
      if (warnings !== undefined) await noteMultiCurrency(deps, label, warnings);
      return label;
    }

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
  // Tally's own spelling, not the caller's — but NOT for the reason this comment
  // used to give. Measured 14 Aug 2026 against three loaded companies:
  // SVCURRENTCOMPANY matching is case-INSENSITIVE and tolerates leading and
  // trailing whitespace, and a name that matches nothing returns an EMPTY report
  // rather than another company's figures. So the wrong-attribution hazard
  // originally claimed here does not exist on this build.
  //
  // Canonicalising is still right, for two smaller reasons: the envelope's
  // company_id then carries Tally's own spelling rather than the caller's, and
  // `assertCompanyIsLoaded` rejects a name Tally does not know BEFORE the request
  // — which matters, because the real failure mode is an unmatched name coming
  // back as an empty report that reads as "this company has no data".
  const canonicalCompany = await assertCompanyIsLoaded(deps, company);

  const request = spec.build({
    ...(canonicalCompany === undefined ? {} : { company: canonicalCompany }),
    format: deps.config.tallyPreferredFormat,
  });

  const currencyWarnings: string[] = [];
  const currency = await resolveCompanyCurrency(deps, canonicalCompany, currencyWarnings);
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
 * (tally_get_masters type "ledger" / tally_get_masters type "group" / tally_get_masters type "stockItem").
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
