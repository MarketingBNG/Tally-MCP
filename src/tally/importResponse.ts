import { TallyError } from './TallyError.js';

/**
 * Reading TallyPrime's answer to an import.
 *
 * Captured live 2026-10-14. Success, a create:
 *
 *   <RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED>
 *   <LASTVCHID>0</LASTVCHID><LASTMID>0</LASTMID><COMBINED>0</COMBINED>
 *   <IGNORED>0</IGNORED><ERRORS>0</ERRORS><CANCELLED>0</CANCELLED>
 *   <EXCEPTIONS>0</EXCEPTIONS></RESPONSE>
 *
 * A refusal (unknown parent group) adds a LINEERROR and counts an EXCEPTION
 * while ERRORS stays 0:
 *
 *   <RESPONSE><LINEERROR>Group 'X' does not exist!</LINEERROR>...<EXCEPTIONS>1</EXCEPTIONS>
 *
 * And a create of an existing name reports ALTERED 1 with no error at all.
 *
 * So success is never "ERRORS is 0". It is: the exact counter the operation
 * should move moved by exactly the expected amount, every other mutation
 * counter is 0, and there were no exceptions, errors or line errors. Anything
 * else is a refusal, or — if the counters say something changed that was not
 * asked for — a loud warning that the books were touched unexpectedly.
 */

export interface ImportCounters {
  created: number;
  altered: number;
  deleted: number;
  cancelled: number;
  combined: number;
  ignored: number;
  errors: number;
  exceptions: number;
  /** MasterId of the last voucher written, 0 when none. */
  lastVoucherId: number;
  /** MasterId of the last master written, 0 when none. */
  lastMasterId: number;
  /** Every LINEERROR, decoded, in order. */
  lineErrors: string[];
}

/** Which counters an operation is expected to move, and by how much. Absent means 0. */
export type ExpectedCounts = Partial<Pick<ImportCounters, 'created' | 'altered' | 'deleted' | 'cancelled'>>;

const COUNTER_TAGS = {
  created: 'CREATED',
  altered: 'ALTERED',
  deleted: 'DELETED',
  cancelled: 'CANCELLED',
  combined: 'COMBINED',
  ignored: 'IGNORED',
  errors: 'ERRORS',
  exceptions: 'EXCEPTIONS',
  lastVoucherId: 'LASTVCHID',
  lastMasterId: 'LASTMID',
} as const;

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Parse an import response into counters.
 *
 * Regex rather than the general parser on purpose: the response is a flat,
 * fixed list of scalars, and a missing counter must be an ERROR here, not a
 * null — a write whose result cannot be read has an unknown outcome.
 */
export function parseImportResponse(body: string): ImportCounters {
  if (!/<RESPONSE>/i.test(body)) {
    throw new TallyError(
      'WRITE_OUTCOME_UNKNOWN',
      'TallyPrime answered the write with something that is not an import result, so whether ' +
        'anything was written cannot be told from the reply.',
      { context: { body: body.slice(0, 2000) } }
    );
  }

  const read = (tag: string): number => {
    const match = new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, 'i').exec(body);
    if (match?.[1] === undefined) {
      throw new TallyError(
        'WRITE_OUTCOME_UNKNOWN',
        `TallyPrime's import result has no readable ${tag} count, so whether anything was ` +
          'written cannot be told from the reply.',
        { context: { body: body.slice(0, 2000) } }
      );
    }
    return Number(match[1]);
  };

  const counters = Object.fromEntries(
    Object.entries(COUNTER_TAGS).map(([key, tag]) => [key, read(tag)])
  ) as Omit<ImportCounters, 'lineErrors'>;

  const lineErrors = [...body.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) =>
    decodeEntities((m[1] ?? '').trim())
  );

  return { ...counters, lineErrors };
}

export interface ImportJudgement {
  ok: boolean;
  /** Plain-language reasons the write is not a clean success. Empty when ok. */
  problems: string[];
  /**
   * True when TallyPrime reports changing something the operation did not ask
   * for — e.g. ALTERED 1 on a create. The books WERE touched; the caller must
   * be told so rather than told "nothing happened".
   */
  unexpectedChange: boolean;
}

/** Judge counters against what the operation should have done. */
export function judgeImport(counters: ImportCounters, expected: ExpectedCounts): ImportJudgement {
  const problems: string[] = [];
  let unexpectedChange = false;

  for (const key of ['created', 'altered', 'deleted', 'cancelled'] as const) {
    const want = expected[key] ?? 0;
    const got = counters[key];
    if (got !== want) {
      problems.push(`TallyPrime reports ${key.toUpperCase()} ${String(got)}, expected ${String(want)}.`);
      if (got > want) unexpectedChange = true;
    }
  }
  if (counters.combined !== 0) {
    problems.push(`TallyPrime COMBINED ${String(counters.combined)} record(s) into existing ones.`);
    unexpectedChange = true;
  }
  if (counters.ignored !== 0) problems.push(`TallyPrime IGNORED ${String(counters.ignored)} record(s).`);
  if (counters.errors !== 0) problems.push(`TallyPrime reports ${String(counters.errors)} error(s).`);
  if (counters.exceptions !== 0) {
    problems.push(`TallyPrime reports ${String(counters.exceptions)} exception(s).`);
  }
  for (const line of counters.lineErrors) problems.push(`TallyPrime: ${line}`);

  return { ok: problems.length === 0, problems, unexpectedChange };
}
