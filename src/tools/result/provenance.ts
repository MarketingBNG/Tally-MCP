
/**
 * Rendering the `source_query` provenance block.
 *
 * Moved out of toolResult.ts unchanged. `runTool` is the only caller. The
 * per-session memory of which bodies have already been shown in full lives here
 * with the rendering that uses it, rather than beside unrelated plumbing.
 */

/**
 * Reduce each request body to a one-line descriptor, when configured to.
 *
 * At `full` — the default — this returns the bodies untouched, so every
 * existing caller sees exactly what it saw before.
 *
 * At `compact` it emits `TYPE ID [company] [from..to]`, pulled straight out of
 * the request rather than reconstructed from the tool's arguments: the point of
 * provenance is to describe what was actually sent, and a descriptor built from
 * the inputs would agree with the caller's intent rather than with the wire.
 *
 * What is deliberately KEPT at compact: the report or collection ID, the
 * company scope and the date range. Those are what identify which query a
 * figure came from, and the company scope in particular is the thing a reader
 * checks when two companies are open. What is dropped is the field list and the
 * TDL envelope — bulk that never varies with the question asked.
 *
 * The trade-off is real and belongs to the operator: a compact descriptor
 * cannot be replayed verbatim. See TALLY_SOURCE_QUERY_MODE in config.ts.
 */
/**
 * Distinct request bodies already shown in full during this session, per client.
 *
 * Keyed on the TallyClient because that is what a session owns — one server
 * process, one client, one conversation's worth of provenance. A WeakMap so a
 * discarded client takes its history with it.
 */
const QUERIES_SHOWN_IN_FULL = new WeakMap<object, Set<string>>();

/**
 * Upper bound on remembered bodies, so a long session cannot grow this without
 * limit. On eviction the body is simply shown in full again — the failure mode
 * is a longer response, never a missing one.
 */
const MAX_REMEMBERED_QUERIES = 300;

/** A one-line summary of what a request asked for, read back off the wire. */
function describeQuery(body: string): string {
  const pick = (tag: string): string | undefined =>
    new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1];

  const type = pick('TYPE') ?? 'Request';
  const id = pick('ID') ?? 'unknown';
  const company = pick('SVCURRENTCOMPANY');
  const from = pick('SVFROMDATE');
  const to = pick('SVTODATE');

  return (
    `${type} "${id}"` +
    (company === undefined ? '' : ` company="${company}"`) +
    (from === undefined || to === undefined ? '' : ` ${from}..${to}`)
  );
}

/**
 * Render the provenance for one answer, at the configured level of detail.
 *
 * At `full` the bodies are returned untouched.
 *
 * At `dedupe` — the default — a body is returned VERBATIM the first time it is
 * seen this session and replaced by a descriptor on every later call. What this
 * removes is repetition, not information: measured across a seven-call audit
 * sequence, `source_query` was 31% of everything returned and most of it was the
 * same company-list and currency-list requests reprinted on all seven calls.
 * Each distinct request is still shown in full once, so every figure remains
 * reproducible from the transcript as a whole.
 *
 * The descriptor is deliberately self-identifying — type, ID, company, dates —
 * rather than a numeric back-reference, because the first occurrence is emitted
 * byte-for-byte with no marker added. Adding an index to it would have made the
 * verbatim body no longer verbatim, and something a consumer replays must not
 * carry annotations of ours.
 *
 * At `compact` nothing is ever emitted in full.
 */
export function renderProvenance(
  bodies: readonly string[],
  mode: 'full' | 'dedupe' | 'compact',
  /** Session identity — the client this answer was fetched through. */
  sessionKey: object
): string[] {
  if (mode === 'full') return [...bodies];

  if (mode === 'compact') {
    return bodies.map(
      (body) =>
        `${describeQuery(body)} [compact: set TALLY_SOURCE_QUERY_MODE=full for the replayable request body]`
    );
  }

  let shown = QUERIES_SHOWN_IN_FULL.get(sessionKey);
  if (shown === undefined) {
    shown = new Set<string>();
    QUERIES_SHOWN_IN_FULL.set(sessionKey, shown);
  }

  return bodies.map((body) => {
    if (shown.has(body)) {
      // Kept short on purpose. This line is re-read on every call, and the
      // config hint that explains it belongs in the docs rather than in each
      // repeat — spelling it out here cost more than the repetition it saved.
      return `${describeQuery(body)} [body shown in full earlier this session]`;
    }

    if (shown.size >= MAX_REMEMBERED_QUERIES) {
      // Oldest insertion first — Set preserves it. Evicting means that body is
      // shown in full again next time, which is safe in the only direction
      // that matters.
      const oldest = shown.values().next().value;
      if (oldest !== undefined) shown.delete(oldest);
    }
    shown.add(body);
    return body;
  });
}

/** Preserve first-sent order while dropping repeats of the same request. */
export function distinct(bodies: readonly string[]): string[] {
  return [...new Set(bodies)];
}
