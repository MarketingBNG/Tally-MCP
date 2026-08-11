/**
 * Structured, leveled logger.
 *
 * CRITICAL: every line goes to **stderr**. This process speaks MCP over stdio,
 * which means stdout is the protocol channel — a single stray `console.log`
 * corrupts the JSON-RPC stream and Claude Desktop drops the connection with a
 * confusing error. ESLint enforces this too (`no-console` is an error in src/).
 *
 * Redaction: this logger never prints full Tally payloads at INFO or above.
 * Voucher/ledger bodies are only visible at DEBUG, and callers are expected to
 * pass them via `logRawPayload()` so the intent is explicit at the call site.
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** Keys whose values are replaced with '[redacted]' at any level. */
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|api[-_]?key|auth|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  /**
   * Log a raw Tally payload. DEBUG-only by design — these contain full
   * accounting records and must never appear in normal operation.
   */
  logRawPayload(label: string, payload: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function write(
  level: LogLevel,
  configuredLevel: LogLevel,
  bindings: Record<string, unknown>,
  message: string,
  fields?: Record<string, unknown>
): void {
  if (LEVEL_RANK[level] > LEVEL_RANK[configuredLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...bindings,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };

  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Circular or otherwise unserialisable field — never let logging throw.
    line = JSON.stringify({ ts: entry.ts, level, msg: message, note: 'fields unserialisable' });
  }

  process.stderr.write(`${line}\n`);
}

export function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  return {
    error: (message, fields) => write('error', level, bindings, message, fields),
    warn: (message, fields) => write('warn', level, bindings, message, fields),
    info: (message, fields) => write('info', level, bindings, message, fields),
    debug: (message, fields) => write('debug', level, bindings, message, fields),
    logRawPayload: (label, payload) => {
      if (LEVEL_RANK.debug > LEVEL_RANK[level]) return;
      write('debug', level, bindings, `raw payload: ${label}`, {
        bytes: payload.length,
        payload,
      });
    },
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
