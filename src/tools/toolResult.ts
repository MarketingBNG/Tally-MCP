import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import type { TallyClient } from '../tally/TallyClient.js';
import { TallyError } from '../tally/TallyError.js';
import { buildCompanyListRequest } from '../tally/requests.js';
import { normalizeCompanies } from '../tally/normalize.js';
import { financialYearFor, todayIso, validateDateRange, type DateRange } from '../utils/dates.js';

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

/**
 * Run a tool body, turning any failure into a structured payload.
 *
 * No exception escapes to the MCP boundary and no stack trace is ever
 * serialised — full detail goes to the local log, the caller gets a stable
 * code and a suggestion.
 */
export async function runTool(
  toolName: string,
  logger: Logger,
  body: () => Promise<unknown>
): Promise<ToolOutput> {
  const startedAt = Date.now();

  try {
    const result = await body();
    logger.debug('tool completed', { tool: toolName, elapsedMs: Date.now() - startedAt });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const tallyError = TallyError.from(error, `${toolName} failed.`);

    logger.error('tool failed', {
      tool: toolName,
      code: tallyError.code,
      message: tallyError.message,
      elapsedMs: Date.now() - startedAt,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(tallyError.toClientPayload(), null, 2) }],
      isError: true,
    };
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
    loaded.length === 0 ? 'no company is currently loaded' : `currently loaded: ${loaded.join(', ')}`;

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
