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

  logLevel: z.enum(LOG_LEVELS).default('info'),
});

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
