import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import type { TallyClient } from '../tally/TallyClient.js';
import { TallyError } from '../tally/TallyError.js';
import { withQueryLog, type QueryScope } from '../tally/queryLog.js';
import type { PaginatedResult } from '../utils/pagination.js';
import { distinct, renderProvenance } from './result/provenance.js';
import {
  assertResponseFits,
  byteLengthOf,
  serializeToolPayload,
} from './result/responseSize.js';
import { resolveCompanyId } from './result/companies.js';

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
  // Shared by both scopes below, so the second does not re-send what the first
  // already fetched. Held here rather than reached for through `scope` so the
  // sharing is visible at the point it is decided.
  const inFlight = new Map<string, Promise<unknown>>();
  const scope: QueryScope = { queries: [], oldestFetchAt: null, inFlight };
  const queries = scope.queries;

  try {
    const result = await withQueryLog(scope, body);

    // Resolved outside the QUERY LOG on purpose: this is metadata about the
    // answer, not one of the queries that produced it, and recording it would
    // put a request in `source_query` that reproduces none of the figures.
    //
    // It does share the in-flight memo, though — those are separate concerns.
    // Falling back to the sole loaded company re-sends the company-list request
    // the body has almost certainly already sent, and there is no reason to pay
    // for it twice to keep it out of the provenance. The throwaway scope is
    // what keeps it out: its `queries` and `oldestFetchAt` are discarded, so
    // this records exactly as much as it did when it ran outside a scope
    // entirely, which is nothing.
    const companyId = await withQueryLog(
      { queries: [], oldestFetchAt: null, inFlight },
      () => resolveCompanyId(deps, queries)
    );

    const envelope: ToolEnvelope = {
      data: result.data,
      company_id: companyId,
      as_of_timestamp: new Date().toISOString(),
      source_query: renderProvenance(distinct(queries), deps.config.tallySourceQueryMode, deps.client),
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
            source_query: renderProvenance(distinct(queries), deps.config.tallySourceQueryMode, deps.client),
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

/**
 * Re-exported so the 31 files importing from `toolResult.js` stay untouched by
 * the split. See src/tools/result/ for where each concern now lives.
 */
export {
  applyConditions,
  type DatasetSpec,
  type FieldSpec,
  type FieldType,
} from './result/filtering.js';

export { serializeToolPayload } from './result/responseSize.js';

export {
  resolveCompanyCurrency,
  resolveCompanyCurrencyDetailed,
  type ResolvedCurrency,
} from './result/currency.js';

export {
  noteEmptyDefaultedPeriod,
  notePeriodBeyondBooks,
  periodWasDefaulted,
  resolvePeriod,
  resolvePeriodForCompany,
} from './result/periods.js';

export {
  assertCompanyIsLoaded,
  companyBookYear,
  companyList,
  companyNamed,
} from './result/companies.js';
export {
  assertResultSetFits,
  fetchCollection,
  findByName,
} from './result/collections.js';
