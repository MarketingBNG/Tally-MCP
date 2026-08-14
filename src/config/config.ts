import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { LOG_LEVELS } from '../utils/logger.js';

/**
 * Configuration is read from environment variables and validated at startup.
 *
 * Under Claude Desktop, values come from the `env` block in
 * claude_desktop_config.json — the .env file is a development convenience and
 * is not read in that context. See README.md → Configuration.
 */

// `quiet` matters: dotenv's banner would otherwise print to stdout and corrupt
// the MCP stdio stream before the server even starts.
loadDotenv({ quiet: true });

const portSchema = z.coerce
  .number()
  .int('TALLY_PORT must be a whole number.')
  .min(1, 'TALLY_PORT must be between 1 and 65535.')
  .max(65535, 'TALLY_PORT must be between 1 and 65535.');

const configSchema = z.object({
  tallyHost: z.string().min(1, 'TALLY_HOST must not be empty.').default('127.0.0.1'),
  tallyPort: portSchema.default(9000),
  tallyProtocol: z.enum(['http', 'https']).default('http'),

  /** Timeout for ordinary requests. */
  tallyTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000, 'TALLY_TIMEOUT_MS must be at least 1000.')
    .max(600_000, 'TALLY_TIMEOUT_MS must be at most 600000.')
    .default(30_000),

  /**
   * Timeout for report-class requests (trial balance, P&L, balance sheet).
   * These are inherently large but bounded, so they get a longer allowance
   * rather than sharing the general timeout. Defaults to 4x the base timeout.
   */
  tallyReportTimeoutMs: z.coerce.number().int().min(1000).max(600_000).optional(),

  /**
   * Preferred wire format. Native JSON requires TallyPrime 7.0+; the adapter
   * falls back to XML per-request where JSON is unsupported.
   */
  tallyPreferredFormat: z.enum(['json', 'xml']).default('json'),

  /**
   * Ceiling on records held in memory for a single query. Tally does not
   * paginate server-side, so a query is either fully fetched or refused —
   * exceeding this yields RESULT_LIMIT_EXCEEDED rather than an attempt.
   */
  tallyMaxRecords: z.coerce
    .number()
    .int()
    .min(1, 'TALLY_MAX_RECORDS must be at least 1.')
    .max(100_000, 'TALLY_MAX_RECORDS must be at most 100000.')
    .default(5000),

  /**
   * Ceiling on the serialised size of a single tool response, in bytes.
   *
   * This is a *transport* limit, distinct from TALLY_MAX_RECORDS above, which
   * counts records. The two are not interchangeable: MCP clients cap the size
   * of a tool result — Claude Desktop rejects anything over 1MB with "Tool
   * result is too large" — and a response can breach that while holding a
   * fraction of the record ceiling. One full-field voucher runs to roughly
   * 18 KB, so the default page of 100 is about 1.7MB: comfortably inside 5000
   * records and comfortably over the client's limit.
   *
   * When a client discards an oversized result, Claude never sees it and the
   * user gets a dead end with nothing to act on. Refusing here instead, with
   * the page size that would fit, keeps the failure inside this server's own
   * vocabulary where it can say what to do about it.
   *
   * ## Why the default is far below the client's 1MB limit
   *
   * It was 900,000 — chosen as headroom under Claude Desktop's 1MB cap. That
   * conflated two different budgets. The transport limit is about whether a
   * single message can be delivered; the **context** limit is about how many
   * such messages fit in a conversation. A 900 KB response is roughly 225,000
   * tokens, so one legal call could consume a fifth of a large context window
   * and a whole small one — measured on a real audit, a single page of 25
   * full-detail vouchers cost about 54,000 tokens.
   *
   * 150,000 bytes is roughly 37,000 tokens: enough for a substantial page,
   * small enough that no one call dominates the conversation it belongs to.
   * Raise it deliberately (`TALLY_MAX_RESPONSE_BYTES`) for a one-off deep dive;
   * the RESPONSE_TOO_LARGE error already names a page size that fits, computed
   * from the measured size, so the normal remedy is a retry rather than config.
   */
  tallyMaxResponseBytes: z.coerce
    .number()
    .int()
    .min(10_000, 'TALLY_MAX_RESPONSE_BYTES must be at least 10000.')
    .max(50_000_000, 'TALLY_MAX_RESPONSE_BYTES must be at most 50000000.')
    .default(150_000),

  logLevel: z.enum(LOG_LEVELS).default('info'),

  /**
   * How long an identical Tally request, and the records parsed from it, may be
   * served from memory instead of being fetched and parsed again.
   *
   * TallyPrime has no server-side cache of its own, and a single audit turns into
   * many tool calls over the same period's voucher register — bank
   * reconciliation, outstanding, GST, inventory movements and the voucher list
   * all read it. Measured live on a company with 453 vouchers: that register is
   * **21MB and takes about 7 seconds** for TallyPrime to produce, of which 87% is
   * Tally's own time and 13% is parsing here.
   *
   * **Default raised from 20,000 to 300,000 (5 minutes) on 2026-08-13**, because
   * 20 seconds is shorter than a person thinks for. A real audit pauses between
   * questions while the answer is read, so the cache lapsed constantly and each
   * lapse cost the full 7 seconds again — the single largest contributor to "the
   * audit takes too long". At 5 minutes an audit of one period runs off one fetch.
   *
   * The trade-off, stated so it is a decision rather than an accident: a change
   * made in TallyPrime **while** a conversation is in progress may not be seen for
   * up to 5 minutes. This server cannot write, so the only way to hit it is to
   * edit the books by hand mid-audit. If that is a real risk for a session, set
   * TALLY_CACHE_TTL_MS lower for it; 0 disables caching entirely and restores the
   * old behaviour of re-fetching everything.
   */
  tallyCacheTtlMs: z.coerce
    .number()
    .int()
    .min(0, 'TALLY_CACHE_TTL_MS must be at least 0.')
    .max(300_000, 'TALLY_CACHE_TTL_MS must be at most 300000.')
    .default(300_000),

  /**
   * The currency label to use when TallyPrime's own symbol cannot be transported.
   *
   * Verified live: TallyPrime replaces `₹`, `€` and other characters outside its
   * export codepage with a literal `?` **before the bytes leave TallyPrime**, so
   * the symbol is destroyed at source and no request-side setting recovers it.
   * Ten encoding settings were probed and every response came back identical.
   *
   * The figures are exact either way — only the LABEL is missing — but a figure
   * labelled "unknown" is awkward to quote in a workpaper, and this is the one
   * place the answer actually exists: the person running the server knows what
   * currency the books are in.
   *
   * ## Two forms, and why a bare label is not enough
   *
   * - `EUR` — a bare label. Applied ONLY when TallyPrime has exactly ONE company
   *   loaded.
   * - `Company Name=EUR;Other Company=INR` — per company, matched on the
   *   company's own name, case-insensitively.
   *
   * The bare form is restricted for a reason found the hard way, on live data.
   * A German company and an Indian company BOTH report their symbol as `?` —
   * `€` and `₹` are equally absent from Tally's export codepage. With both
   * loaded, a bare `EUR` would have labelled rupee balances EUR: the numbers
   * right, the label a confident lie, which is precisely the bug class this
   * whole mechanism exists to avoid. So with more than one company loaded a bare
   * label is refused and the response says to name the companies.
   *
   * Otherwise deliberately narrow:
   * - Used ONLY where Tally's symbol was untransportable. It never overrides a
   *   symbol Tally sent successfully, so it cannot relabel a dollar company.
   * - Where it is used, the response SAYS the label came from configuration
   *   rather than from Tally. A label the operator supplied and a label Tally
   *   reported are different kinds of fact and must not be indistinguishable.
   */
  tallyCurrencyLabel: z
    .string()
    .trim()
    .min(1, 'TALLY_CURRENCY_LABEL must not be empty if it is set at all.')
    .max(512, 'TALLY_CURRENCY_LABEL must be at most 512 characters.')
    .optional(),
});

/**
 * A currency label resolved for one company.
 *
 * `scope` is carried so the response can say WHERE the label came from. A label
 * that applies to one named company and a label applied because only one
 * company happened to be loaded are different strengths of fact.
 */
export interface CurrencyLabelRule {
  label: string;
  scope: 'named-company' | 'single-company-only';
}

/**
 * Read TALLY_CURRENCY_LABEL into a rule for one company.
 *
 * Returns null when nothing applies — which is the common case and is not an
 * error. Never throws: a misconfigured label must degrade to "unknown", not
 * refuse to answer an accounting question.
 */
export function currencyLabelFor(
  setting: string | undefined,
  companyName: string | undefined,
  loadedCompanyCount: number
): CurrencyLabelRule | null {
  if (setting === undefined) return null;

  if (setting.includes('=')) {
    for (const pair of setting.split(';')) {
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const name = pair.slice(0, at).trim();
      const label = pair.slice(at + 1).trim();
      if (name === '' || label === '') continue;
      if (companyName !== undefined && name.toLowerCase() === companyName.trim().toLowerCase()) {
        return { label, scope: 'named-company' };
      }
    }
    return null;
  }

  // A bare label with several companies loaded cannot be attributed to one of
  // them, and guessing is the failure this restriction exists to prevent.
  if (loadedCompanyCount > 1) return null;

  return { label: setting, scope: 'single-company-only' };
}

export type AppConfig = Readonly<Omit<z.infer<typeof configSchema>, 'tallyReportTimeoutMs'>> & {
  /**
   * Always populated by `loadConfig` — optional in the schema only because
   * the environment variable itself is optional, with a derived default.
   */
  readonly tallyReportTimeoutMs: number;
  /** Fully-qualified base URL for the Tally HTTP endpoint. */
  readonly tallyBaseUrl: string;
};

/** Raised when configuration is invalid. Not a TallyError — this is fatal and pre-connection. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse({
    tallyHost: env.TALLY_HOST,
    tallyPort: env.TALLY_PORT,
    tallyProtocol: env.TALLY_PROTOCOL,
    tallyTimeoutMs: env.TALLY_TIMEOUT_MS,
    tallyReportTimeoutMs: env.TALLY_REPORT_TIMEOUT_MS,
    tallyPreferredFormat: env.TALLY_PREFERRED_FORMAT,
    tallyMaxRecords: env.TALLY_MAX_RECORDS,
    tallyMaxResponseBytes: env.TALLY_MAX_RESPONSE_BYTES,
    tallyCacheTtlMs: env.TALLY_CACHE_TTL_MS,
    tallyCurrencyLabel: env.TALLY_CURRENCY_LABEL,
    logLevel: env.LOG_LEVEL,
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(
      `Invalid configuration. Fix the following environment variables and restart:\n${details}\n\n` +
        'Under Claude Desktop these come from the "env" block in claude_desktop_config.json, ' +
        'not from a .env file. See README.md → Configuration.'
    );
  }

  const value = parsed.data;
  const reportTimeout = value.tallyReportTimeoutMs ?? value.tallyTimeoutMs * 4;

  return Object.freeze({
    ...value,
    tallyReportTimeoutMs: reportTimeout,
    tallyBaseUrl: `${value.tallyProtocol}://${value.tallyHost}:${String(value.tallyPort)}`,
  });
}
