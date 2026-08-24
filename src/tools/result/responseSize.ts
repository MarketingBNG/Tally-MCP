import { TallyError } from '../../tally/TallyError.js';

/**
 * The response-size ceiling, and the serialisation it counts.
 *
 * Moved out of toolResult.ts unchanged. One concern: how big a payload may be
 * on the way out, how that is measured, and what to tell a caller whose answer
 * does not fit. `runTool` is the only caller of the guard; the serialiser is
 * used wherever a payload becomes text.
 */

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
export function byteLengthOf(text: string): number {
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
export function assertResponseFits(text: string, toolName: string, maxBytes: number): void {
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
