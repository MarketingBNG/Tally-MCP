import type { AppConfig } from '../../config/config.js';
import { TallyError } from '../../tally/TallyError.js';
import { UNSCOPED, type TallyRequestOptions } from '../../tally/requests.js';
import type { Normalized } from '../../tally/normalize.js';
import {
  captureProvenance,
  replayProvenance,
  type RecordedProvenance,
} from '../../tally/queryLog.js';
import { resolveCompanyCurrency } from './currency.js';
import { assertCompanyIsLoaded, type ToolDeps } from '../toolResult.js';

/**
 * Fetching a master collection, and the ceiling on how much may come back.
 *
 * Moved out of toolResult.ts unchanged. One fetch path shared by every master
 * (ledgers, groups, stock items, voucher types, currencies, simple masters),
 * plus the parse cache that keeps a second identical fetch within one call from
 * paying for the parse again, plus the record-count guard that has to run after
 * the fetch because Tally cannot paginate.
 */

/**
 * Guard a fully-fetched result set against the in-memory ceiling.
 *
 * Tally cannot paginate, so the check necessarily happens *after* the fetch:
 * the size is unknowable until the whole payload is in hand. Refusing here
 * still protects the caller from being handed an unusable wall of records,
 * and the message says how to narrow the query.
 */
export function assertResultSetFits(count: number, config: AppConfig, hint: string): void {
  if (count > config.tallyMaxRecords) {
    throw new TallyError(
      'RESULT_LIMIT_EXCEEDED',
      `TallyPrime returned ${String(count)} records, above the limit of ${String(config.tallyMaxRecords)}.`,
      { suggestion: hint }
    );
  }
}

/**
 * One full fetch of a master collection: confirm the company, build, send,
 * normalise, and merge the parser's repairs into the warnings.
 *
 * Every master fetcher (ledgers, groups, stock items) did these five steps
 * identically, differing only in builder, normaliser and timeout class — so
 * they share this and keep only their own naming. Identical fetches within
 * TALLY_CACHE_TTL_MS are served from TallyClient's cache rather than re-sent,
 * which is what makes the multi-fetch tools affordable.
 */
/**
 * Parsed master collections, memoised per client for the configured cache TTL.
 *
 * The same reasoning as `parsedVoucherCache` in vouchers.ts, for the collection
 * side, where it had no equivalent: TallyClient's body cache removes the round
 * trip but not the cost of turning the payload back into records, and that cost
 * is the whole cost of a curated parse. Measured on this parser, a curated
 * `normalize*` call is essentially 100% `parseTallyXml` time — see the note on
 * `tagNameOf` in TallyResponseParser.ts — so a repeat parse buys nothing at all
 * and costs the full parse again.
 *
 * It was being paid. Within ONE `tally_get_report` call, reports.ts fetches the
 * ledger list twice (once for the statement, once for the masters divergence
 * check); an all-fields ledger payload is ~5.5MB for 330 ledgers. The company
 * list is worse — six separate call sites re-parse the identical cached body.
 *
 * Keyed on the client instance, so two servers or two tests in one process
 * cannot see each other's records. Keyed within that on `kind` plus the request
 * text: the request already encodes the company and the field set, and `kind`
 * separates two collections whose requests could otherwise coincide.
 */
const parsedCollectionCache = new WeakMap<
  object,
  Map<
    string,
    { at: number; provenance: RecordedProvenance; value: Normalized<readonly unknown[]> }
  >
>();

/**
 * The most parsed collections held per client.
 *
 * Deliberately larger than the six of `parsedVoucherCache`, because these are
 * far smaller parses and there are more distinct kinds in flight: a single audit
 * sequence touches ledgers (curated and all-fields), groups, stock items,
 * voucher types, currencies and companies — seven entries before a second
 * company is opened.
 */
const MAX_PARSED_COLLECTIONS = 16;

export async function fetchCollection<T>(
  deps: ToolDeps,
  company: string | undefined,
  spec: {
    /**
     * Identifies the collection for the parse cache. Two specs with the same
     * `kind` must be interchangeable for a given request.
     */
    kind: string;
    build: (options: TallyRequestOptions) => string;
    /**
     * `currency` is the loaded company's own, resolved here so no fetcher has to
     * remember to do it. A normaliser that returns no money may ignore it.
     */
    normalize: (xml: string, currency: string) => Normalized<T[]>;
    /**
     * Full-field fetches are large enough to deserve the report timeout;
     * curated ones are not. Defaults to the standard timeout.
     */
    timeoutClass?: 'standard' | 'report';
  }
): Promise<Normalized<T[]>> {
  // Tally's own spelling, not the caller's — but NOT for the reason this comment
  // used to give. Measured 14 Aug 2026 against three loaded companies:
  // SVCURRENTCOMPANY matching is case-INSENSITIVE and tolerates leading and
  // trailing whitespace, and a name that matches nothing returns an EMPTY report
  // rather than another company's figures. So the wrong-attribution hazard
  // originally claimed here does not exist on this build.
  //
  // Canonicalising is still right, for two smaller reasons: the envelope's
  // company_id then carries Tally's own spelling rather than the caller's, and
  // `assertCompanyIsLoaded` rejects a name Tally does not know BEFORE the request
  // — which matters, because the real failure mode is an unmatched name coming
  // back as an empty report that reads as "this company has no data".
  const canonicalCompany = await assertCompanyIsLoaded(deps, company);

  const request = spec.build({
    company: canonicalCompany ?? UNSCOPED,
    format: deps.config.tallyPreferredFormat,
  });

  const ttl = deps.config.tallyCacheTtlMs;
  const key = `${spec.kind}|${request}`;

  let perClient = parsedCollectionCache.get(deps.client);
  if (perClient === undefined) {
    perClient = new Map();
    parsedCollectionCache.set(deps.client, perClient);
  }

  if (ttl > 0) {
    const hit = perClient.get(key);
    if (hit !== undefined && Date.now() - hit.at < ttl) {
      deps.logger.debug('collection parse served from cache', { kind: spec.kind });
      /*
       * Report what the live path reported. Serving a parse means
       * `TallyClient.send` is never reached, and that is the one place a request
       * reports itself — so without this the answer comes back with its request
       * body MISSING from `source_query` and dated by nothing: a figure
       * presented as sourced that cannot be re-derived. Build Spec v1.0 §6 rule
       * 2 is not satisfied by "the same body appeared on an earlier call".
       *
       * The whole record, not just this collection's request: the parse also
       * rests on the currency read, which is older and labels every amount.
       * Dated by those original reads rather than by this hit, so a cached
       * answer never claims to be fresher than the data in it.
       */
      replayProvenance(hit.provenance);
      // Re-insert to move this key to the end. Map iterates in insertion order,
      // so evicting the FIRST key drops the least recently USED rather than the
      // least recently fetched.
      perClient.delete(key);
      perClient.set(key, hit);
      // Safe by the `kind` contract above: one kind yields one record type, and
      // the request text pins the field set within it.
      return hit.value as Normalized<T[]>;
    }
  }

  const { value: result, provenance } = await captureProvenance(async () => {
    const currencyWarnings: string[] = [];
    const currency = await resolveCompanyCurrency(deps, canonicalCompany, currencyWarnings);
    const response = await deps.client.send(request, spec.timeoutClass ?? 'standard');
    const { data, warnings } = spec.normalize(response.body, currency);

    const produced: Normalized<T[]> = {
      data,
      warnings: [...response.repairs, ...currencyWarnings, ...warnings],
    };
    return produced;
  });

  if (ttl > 0) {
    const now = Date.now();
    // Expired entries first, so a slot is not held by an entry this cache would
    // refuse to serve.
    for (const [entryKey, entry] of perClient) {
      if (now - entry.at >= ttl) perClient.delete(entryKey);
    }
    if (perClient.size >= MAX_PARSED_COLLECTIONS) {
      const evictable = perClient.keys().next().value;
      if (evictable !== undefined) perClient.delete(evictable);
    }
    perClient.set(key, { at: now, provenance, value: result });
  }

  return result;
}

/**
 * Find a named record, exact match first, then case-insensitively.
 *
 * The fallback matters: TallyPrime preserves the capitalisation a user typed,
 * so requiring an exact match would report a real ledger as missing over a
 * difference in case. Preferring the exact match first keeps two records that
 * differ only in capitalisation resolvable.
 */
export function findByName<T>(
  records: readonly T[],
  name: string,
  nameOf: (record: T) => string
): T | undefined {
  const lowered = name.toLowerCase();
  return (
    records.find((record) => nameOf(record) === name) ??
    records.find((record) => nameOf(record).toLowerCase() === lowered)
  );
}
