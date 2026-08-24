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

/**
 * Ways of writing "this machine" that pin one IP family, and so can be refused
 * by a Tally listening on the other. See tallyHost below.
 */
const LOOPBACK_LITERALS = new Set(['127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const configSchema = z.object({
  /**
   * The machine TallyPrime is on. `localhost`, not `127.0.0.1`, and the
   * difference is not cosmetic — it decides whether a local install works at
   * all on some machines.
   *
   * MEASURED, 2026-08-24, on a machine with TallyPrime running and a company
   * loaded. Tally's HTTP server was listening on `::` — every IPv6 address, and
   * NO IPv4 one:
   *
   *   http://127.0.0.1:9000   ECONNREFUSED
   *   http://[::1]:9000       HTTP 200
   *   http://localhost:9000   HTTP 200
   *
   * So dialling the IPv4 literal was refused while Tally sat there answering
   * perfectly. The whole product then reports "TallyPrime was not open" — a
   * confident, wrong, and completely undiagnosable message, because Tally IS
   * open and the user is looking straight at it.
   *
   * `localhost` resolves to both families and Node tries them in turn (Happy
   * Eyeballs, on by default since Node 20), so it connects whichever way Tally
   * chose to listen. There is no matching downside: a Tally listening on IPv4
   * only is reached just the same.
   *
   * A loopback literal is normalised to `localhost` for the same reason —
   * .env files already on disk say `127.0.0.1`, and nobody choosing it meant
   * "fail if Tally happens to be on IPv6".
   */
  tallyHost: z
    .string()
    .min(1, 'TALLY_HOST must not be empty.')
    .default('localhost')
    .transform((host) => (LOOPBACK_LITERALS.has(host.trim().toLowerCase()) ? 'localhost' : host)),
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
   * How much of the request provenance to put in every response's `source_query`.
   *
   * `full` emits every request body verbatim on every call. `dedupe` (the
   * default) emits each DISTINCT body verbatim the first time it appears in the
   * session and a one-line descriptor on later calls. `compact` never emits a
   * body, only descriptors.
   *
   * `dedupe` is the default because it costs nothing that matters. Measured over
   * a seven-call audit sequence, `source_query` was 31% of everything returned,
   * and the bulk of that was the SAME two requests — the company list and the
   * currency list — reprinted verbatim on all seven calls. Every distinct
   * request is still shown in full once, so nothing becomes unreplayable; only
   * the repetition goes.
   *
   * It is also safe for the audit-file path: `tally_make_workpaper` reproduces a
   * paper from its TOOL PARAMETERS, not from these request bodies, so a
   * deduplicated transcript cannot weaken a workpaper.
   *
   * WHY THIS IS A KNOB AND NOT A CHANGE. Measured on this server's own output:
   * the XML transcript runs 2-4KB per call and is frequently the largest single
   * thing in a response, ahead of the accounting data. On a long audit that is
   * most of the cost. But it is also the reproducibility claim this connector
   * makes, and a workpaper that cites a query nobody can replay is weaker
   * evidence than one that does.
   *
   * The one thing `dedupe` assumes is that the earlier response is still
   * readable. In a long session that gets summarised, the first occurrence may
   * be gone and a reader is left with a descriptor and no body. Set `full` when
   * that matters — an engagement where the transcript itself is the record.
   * `compact` remains for exploratory browsing, and gives up replayability
   * outright.
   *
   * Nothing else about the response changes at any setting — no warning, figure
   * or caveat is affected, and there is a test asserting exactly that.
   */
  tallySourceQueryMode: z
    .enum(['full', 'dedupe', 'compact'])
    .default('dedupe'),

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

  /**
   * Where the scheduled exporter writes its workbooks.
   *
   * A LOCAL folder. Nothing in this codebase calls a Google API — the intended
   * setup is that this path sits inside a folder Google Drive Desktop syncs, so
   * Drive's own client does the uploading and no credential ever exists here.
   * See docs and README: client accounting data ends up in Drive, which is the
   * point of the folder, but our code does not put it there.
   *
   * Unset means no export is configured, which is the state of every install
   * that has not run Setup's export questions. The exporter says so plainly and
   * exits rather than inventing a location.
   */
  tallyExportFolder: z
    .string()
    .trim()
    .min(1, 'TALLY_EXPORT_FOLDER must not be empty if it is set at all.')
    .optional(),

  /**
   * Which companies the exporter fetches, semicolon-separated.
   *
   * Named EXPLICITLY, never "whichever company is current". TallyPrime holds
   * several companies at once and answers an unscoped request from whichever it
   * considers current — that is how a workbook ends up labelled one company and
   * read from another, which is the worst failure this whole export can have.
   *
   * Unset means "every company TallyPrime currently has open", which is honest
   * about what it did because the Manifest records the name Tally gave.
   */
  tallyExportCompanies: z
    .string()
    .trim()
    .min(1, 'TALLY_EXPORT_COMPANIES must not be empty if it is set at all.')
    .optional(),

  /**
   * How often the scheduled task runs, in minutes.
   *
   * The task itself is registered by Setup at this interval; the exporter reads
   * it only to say, in the run log, what cadence it believes it is on. One
   * minute is the design in the plan — the task WAKES every minute and asks the
   * cheap "has anything changed?" question, exporting only when the answer is
   * yes.
   *
   * FIVE IS THE DEFAULT, and the reasoning for it is worth writing down because
   * an earlier version of this comment got it wrong.
   *
   * It once said sixty, on the grounds that the change check rests on `ALTERID`
   * moving on every edit — including a deletion — which is unproven. That was a
   * mistake: the interval does not affect that risk at all. If a deletion goes
   * unnoticed, it is missed exactly as much at sixty minutes as at one. What
   * bounds the damage is the guaranteed daily export, which runs at any
   * interval. Sixty bought nothing in safety and cost an hour of staleness.
   *
   * So the interval is what it always should have been: a straight trade between
   * how fresh the spreadsheet is and how often TallyPrime is asked a cheap
   * question. Five minutes is that trade struck sensibly — the check costs about
   * a fifth of a second, so twelve an hour is nothing, and nobody waits long for
   * a figure.
   *
   * One is the design's own answer and is still available. The ALTERID check
   * (scripts/prove-alterid.mjs) remains worth running on a licensed install, but
   * as a question about whether the change check is SOUND, not about the cadence.
   */
  tallyExportIntervalMinutes: z.coerce
    .number()
    .int()
    .min(1, 'TALLY_EXPORT_INTERVAL_MINUTES must be at least 1.')
    .max(1440, 'TALLY_EXPORT_INTERVAL_MINUTES must be at most 1440.')
    .default(5),

  /**
   * Force an export even when the fingerprint says nothing changed.
   *
   * The daily guaranteed run uses this. It exists as a setting so a support
   * question — "the workbook looks stale, prove it is not" — has an answer that
   * does not involve editing the books to make the fingerprint move.
   */
  tallyExportForce: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
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
    tallySourceQueryMode: env.TALLY_SOURCE_QUERY_MODE,
    tallyCurrencyLabel: env.TALLY_CURRENCY_LABEL,
    tallyExportFolder: env.TALLY_EXPORT_FOLDER,
    tallyExportCompanies: env.TALLY_EXPORT_COMPANIES,
    tallyExportIntervalMinutes: env.TALLY_EXPORT_INTERVAL_MINUTES,
    tallyExportForce: env.TALLY_EXPORT_FORCE,
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
