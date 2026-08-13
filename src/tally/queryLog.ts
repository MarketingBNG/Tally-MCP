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
