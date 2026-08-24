import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Provenance capture for the request bodies sent to TallyPrime.
 *
 * Build Specification v1.0 §6 rule 2 requires that every figure this server
 * returns carries the query that produced it, so a number in a workpaper can
 * be re-derived months later rather than taken on trust.
 *
 * The capture is done with an AsyncLocalStorage rather than by threading a
 * recorder through every call site, and that choice is load-bearing. A tool
 * body reaches TallyPrime through several layers — `fetchCollection`,
 * `assertCompanyIsLoaded`, per-tool helpers — and any of them could send a
 * request the caller never sees. Passing a recorder explicitly would mean each
 * of those layers has to remember to forward it, and the failure mode of
 * forgetting is a response that looks fully sourced while quietly omitting a
 * request. An ambient store cannot be forgotten: `TallyClient.send` is the one
 * place a request leaves this process, and it always reports.
 *
 * Outside a `withQueryLog` scope both functions are inert, so nothing that
 * uses the client independently of a tool call — the connection probe, the
 * installer's doctor script, tests — has to know this exists.
 */

/**
 * What one tool call accumulates about where its figures came from.
 *
 * `oldestFetchAt` exists because the response cache means "when this answer was
 * produced" and "when this data was read from TallyPrime" are no longer the same
 * moment. With the cache TTL at five minutes a figure can legitimately be
 * minutes old, and an envelope timestamped `now` would misdate it — in a
 * workpaper, that is a wrong provenance claim rather than a cosmetic one.
 */
export interface QueryScope {
  /** Every request body sent or served, in order. */
  queries: string[];
  /**
   * The EARLIEST moment any data contributing to this answer was actually read
   * from TallyPrime. Oldest rather than newest: an answer is only as fresh as the
   * stalest thing in it.
   */
  oldestFetchAt: number | null;
  /**
   * Requests already issued during this call, so an identical one made again
   * before the first has even returned shares that answer instead of queueing
   * behind it. Created on first use; discarded with the scope when the call
   * ends, so it can never serve data from an earlier question.
   */
  inFlight?: Map<string, Promise<unknown>>;
}

const storage = new AsyncLocalStorage<QueryScope>();

/**
 * Run `fn` with provenance capture active, recording into `scope`.
 *
 * `scope` is supplied by the caller rather than returned, deliberately: a tool
 * that fails part-way through still sent requests, and those are exactly the
 * ones worth seeing in the error. Because the caller already holds the object,
 * it keeps whatever was captured before the throw.
 */
export function withQueryLog<T>(scope: QueryScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/**
 * Run `fn` with provenance capture SUPPRESSED, sharing the caller's in-flight memo.
 *
 * ## What this is for
 *
 * `source_query` exists so a figure can be re-derived months later. A request
 * that produced no figure therefore does not belong in it — it is noise that
 * makes the record longer without making anything more reproducible.
 *
 * The clearest case is the company-list probe. Resolving "which company did the
 * caller mean, and how does TallyPrime spell it" sends `List of Companies`, and
 * it does so from several helpers on nearly every call. Measured across a short
 * audit sequence it was the single most repeated request in `source_query` —
 * sent on 4 of 4 calls at 649 bytes each — while contributing to no number in
 * any of them.
 *
 * `resolveCompanyId` already did exactly this with a hand-rolled throwaway
 * scope; this makes the pattern reusable rather than a one-off.
 *
 * ## What must NOT use this
 *
 * Anything whose answer reaches a figure or its LABEL. The currency lookup is
 * the live example: it produces no number, but it decides the currency every
 * amount is labelled with, and this project has already shipped dollar balances
 * labelled INR once. That request stays in the record.
 *
 * The in-flight memo is shared deliberately, so suppressing provenance does not
 * also cost an extra round trip. `queries` and `oldestFetchAt` are discarded:
 * a request that contributes no figure should not date the answer either.
 */
export function withoutQueryLog<T>(fn: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  const throwaway: QueryScope = {
    queries: [],
    oldestFetchAt: null,
    ...(current?.inFlight === undefined ? {} : { inFlight: current.inFlight }),
  };
  return storage.run(throwaway, fn);
}

/**
 * Run `fn` while ALSO recording its provenance separately, for a caller that
 * intends to replay it later.
 *
 * ## Why this exists
 *
 * `fetchCollection` memoises the parsed collection, so a second identical fetch
 * within the TTL never reaches `TallyClient.send` — and `send` is the one place
 * a request reports itself. Left alone, the cached answer would come back with
 * its request body missing from `source_query` and dated by nothing: a figure
 * presented as sourced that cannot be re-derived.
 *
 * Replaying needs a record of what the live path reported, and it must be the
 * WHOLE record, not just the collection response. Producing a parse also reads
 * the company's currency, which is older than the collection fetch and decides
 * the label on every amount. Dating a cache hit by the collection response
 * alone would claim the answer is fresher than the currency it is labelled in.
 *
 * ## Why not a plain `withQueryLog` child
 *
 * A replaced scope would hide these requests from the caller until the replay,
 * and — worse — would not share the caller's `inFlight` memo, so the currency
 * lookup inside would become a second real round trip. This forwards every note
 * to the parent as it happens AND keeps a copy, so the live call behaves exactly
 * as it did before and only the cached path gains anything.
 */
export async function captureProvenance<T>(
  fn: () => Promise<T>
): Promise<{ value: T; provenance: RecordedProvenance }> {
  const parent = storage.getStore();
  const child: QueryScope = {
    queries: [],
    oldestFetchAt: null,
    ...(parent?.inFlight === undefined ? {} : { inFlight: parent.inFlight }),
  };

  const value = await storage.run(child, fn);

  // Forward to the parent, so the live call records exactly what it always did.
  if (parent !== undefined) {
    parent.queries.push(...child.queries);
    if (child.oldestFetchAt !== null) {
      if (parent.oldestFetchAt === null || child.oldestFetchAt < parent.oldestFetchAt) {
        parent.oldestFetchAt = child.oldestFetchAt;
      }
    }
  }

  return { value, provenance: { queries: child.queries, oldestFetchAt: child.oldestFetchAt } };
}

/** What one production reported, kept so a later cache hit can report the same. */
export interface RecordedProvenance {
  queries: string[];
  oldestFetchAt: number | null;
}

/**
 * Report a previously captured provenance record as the current answer's.
 *
 * The counterpart to `captureProvenance`: what the live path told the query log,
 * told again on behalf of an answer served from a memoised parse.
 */
export function replayProvenance(provenance: RecordedProvenance): void {
  for (const body of provenance.queries) noteQuery(body);
  if (provenance.oldestFetchAt !== null) noteDataFetchedAt(provenance.oldestFetchAt);
}

/**
 * Record when data contributing to the current answer was read from Tally.
 *
 * Called with the original fetch time on a cache hit, not the time of the hit —
 * that is the entire point. Keeps the earliest, since freshness is bounded by the
 * stalest contribution.
 */
export function noteDataFetchedAt(fetchedAt: number): void {
  const scope = storage.getStore();
  if (scope === undefined) return;
  if (scope.oldestFetchAt === null || fetchedAt < scope.oldestFetchAt) {
    scope.oldestFetchAt = fetchedAt;
  }
}

/**
 * Record one request body against the active log, if there is one.
 *
 * Called for cache hits as well as live sends. A cached response was still
 * produced by this request, and provenance describes where a figure came
 * from, not whether the wire was touched to fetch it this time.
 */
export function noteQuery(body: string): void {
  storage.getStore()?.queries.push(body);
}

/**
 * Run `produce` at most once per `key` for the duration of the current tool
 * call, sharing its result with every later caller that asks for the same key.
 *
 * WHY: answering one question makes the same request several times over. A
 * single statement call resolves the loaded company, then its book year, then
 * its currency — three helpers that each send the identical company-list
 * request, and a multi-company report multiplies that by the company count.
 * The response cache already hides most of the cost, but it is TTL-gated, so
 * with the TTL configured to zero every one of those becomes a real round trip
 * through a queue that admits one request at a time.
 *
 * This is deliberately NOT a second cache. It is scoped to one call and cannot
 * outlive it, so it never returns anything the call would not have accepted
 * from a fresh send a moment later — within a single question, Tally's answer
 * to the same request cannot have legitimately changed.
 *
 * Stores the promise rather than the resolved value, so concurrent callers
 * (`Promise.all` over ledgers and groups, say) collapse onto one send instead
 * of each starting their own.
 *
 * A rejection is memoised along with everything else, deliberately. Nothing
 * beneath this retries, so an identical request repeated within the same call
 * would fail in exactly the same way — releasing the key on failure would buy
 * a second identical failure rather than a second chance. It matters more than
 * it sounds: an optional lookup such as the currency list fails on companies
 * that define none, and that is the ordinary case rather than the exception.
 *
 * Outside a scope it simply calls `produce`, like the rest of this module.
 */
export function memoizeWithinCall<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const scope = storage.getStore();
  if (scope === undefined) return produce();

  const inFlight = (scope.inFlight ??= new Map<string, Promise<unknown>>());
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing as Promise<T>;

  const started = produce();
  inFlight.set(key, started);
  return started;
}
