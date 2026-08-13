/**
 * Stable, user-facing error codes.
 *
 * These are part of the contract with Claude: the code is what gets reasoned
 * about, the message is what gets shown, and the suggestion is what tells the
 * user how to fix it. Do not rename a code once shipped.
 *
 * Stack traces never cross the MCP boundary — see `toClientPayload()`.
 */
export const TALLY_ERROR_CODES = [
  'TALLY_NOT_RUNNING',
  'TALLY_CONNECTION_FAILED',
  'TALLY_TIMEOUT',
  'TALLY_INVALID_RESPONSE',
  'TALLY_COMPANY_NOT_FOUND',
  'TALLY_COMPANY_NOT_LOADED',
  'TALLY_UNSUPPORTED_OPERATION',
  'TALLY_AUTHENTICATION_ERROR',
  'INVALID_DATE_RANGE',
  'INVALID_PARAMETERS',
  'RESULT_LIMIT_EXCEEDED',
  'RESPONSE_TOO_LARGE',
] as const;

export type TallyErrorCode = (typeof TALLY_ERROR_CODES)[number];

/** Default remediation text per code. Overridable per-throw. */
const DEFAULT_SUGGESTIONS: Record<TallyErrorCode, string> = {
  TALLY_NOT_RUNNING:
    'Open TallyPrime and load a company. The server could not reach Tally at the configured host and port.',
  TALLY_CONNECTION_FAILED:
    'Check that TallyPrime is running and that its HTTP server is enabled (F1 > Settings > Connectivity > Client/Server configuration), and that TALLY_HOST/TALLY_PORT match.',
  TALLY_TIMEOUT:
    'Tally did not respond in time. Try a narrower date range or a more specific filter, or raise TALLY_TIMEOUT_MS.',
  TALLY_INVALID_RESPONSE:
    'Tally returned a response this server could not parse. Check the local logs at DEBUG level for the raw payload.',
  TALLY_COMPANY_NOT_FOUND:
    'Check the company name spelling. Use tally_list_companies to see what is available.',
  TALLY_COMPANY_NOT_LOADED:
    'Load that company in TallyPrime first — Tally serves data only for the currently loaded company.',
  TALLY_UNSUPPORTED_OPERATION:
    'This data has no reliable retrieval path in TallyPrime. See docs/known-limitations.md.',
  TALLY_AUTHENTICATION_ERROR:
    'TallyPrime rejected the request as unauthorised. Check any security/user access settings on the company.',
  INVALID_DATE_RANGE: 'Provide dates as YYYY-MM-DD with fromDate on or before toDate.',
  INVALID_PARAMETERS: 'Check the tool parameters against the tool schema and try again.',
  RESULT_LIMIT_EXCEEDED:
    'Narrow the query — use a smaller date range, add a filter, or request a specific record.',
  // Distinct from RESULT_LIMIT_EXCEEDED: the records fitted this server's
  // ceiling, but the serialised response is too big for the MCP client to
  // accept. The remedy is a smaller page or fewer fields, not a shorter period.
  RESPONSE_TOO_LARGE:
    'Request a smaller page with pageSize, or set includeAllFields to false — the data was ' +
    'retrieved successfully but is too large to return in one response.',
};

/** The shape handed back to Claude. Deliberately contains no stack trace. */
export interface TallyErrorPayload {
  error: {
    code: TallyErrorCode;
    message: string;
    suggestion: string;
  };
}

export interface TallyErrorOptions {
  /** Overrides the default suggestion for the code. */
  suggestion?: string;
  /** Underlying cause. Logged locally, never sent to the client. */
  cause?: unknown;
  /** Extra local-only diagnostic context. Never sent to the client. */
  context?: Record<string, unknown>;
}

export class TallyError extends Error {
  readonly code: TallyErrorCode;
  readonly suggestion: string;
  /** Local-only. Excluded from `toClientPayload()` by design. */
  readonly context: Record<string, unknown> | undefined;

  constructor(code: TallyErrorCode, message: string, options: TallyErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TallyError';
    this.code = code;
    this.suggestion = options.suggestion ?? DEFAULT_SUGGESTIONS[code];
    this.context = options.context;
  }

  /**
   * The only sanctioned way to turn an error into something Claude sees.
   * Returns code, message and suggestion — never the stack, cause, or context.
   */
  toClientPayload(): TallyErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        suggestion: this.suggestion,
      },
    };
  }

  static isTallyError(value: unknown): value is TallyError {
    return value instanceof TallyError;
  }

  /**
   * Coerce anything thrown into a TallyError so no raw exception can leak.
   * Unknown failures become TALLY_CONNECTION_FAILED with a generic message —
   * the real detail goes to the local log, not to the client.
   */
  static from(value: unknown, fallbackMessage = 'An unexpected error occurred.'): TallyError {
    if (TallyError.isTallyError(value)) return value;
    return new TallyError('TALLY_CONNECTION_FAILED', fallbackMessage, { cause: value });
  }
}
