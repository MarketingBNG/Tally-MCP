import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import { TallyError } from './TallyError.js';
import { RequestQueue } from './requestQueue.js';
import { memoizeWithinCall, noteDataFetchedAt, noteQuery } from './queryLog.js';
import { sanitizeTallyXml, normalizeEncodingDeclaration } from './sanitizeXml.js';

/**
 * Low-level HTTP transport for TallyPrime.
 *
 * Responsibilities, deliberately narrow:
 *   - POST a request body to Tally and return a decoded, sanitised string
 *   - decode whatever encoding Tally actually used (frequently UTF-16LE)
 *   - serialise requests so only one is ever in flight
 *   - map transport failures onto stable TallyError codes
 *
 * It does NOT know what any response means. Interpreting payloads is the
 * parser's job, and that needs ground-truth samples this layer does not.
 */

/** How a request should be timed out. Reports get a longer allowance. */
export type RequestClass = 'standard' | 'report';

/** Per-request overrides. */
export interface SendOptions {
  /**
   * Bypass the response cache entirely — neither read from it nor write to it.
   *
   * Required for any request whose purpose is to establish that TallyPrime is
   * ANSWERING, because such a request is byte-identical every time and is
   * therefore the most cacheable request this server makes. Verified live on
   * 2026-08-14: with TallyPrime parked behind a modal "incorrect object type"
   * dialog and serving nothing, the connection probe returned
   * `connected: true, responseTimeMs: 0` from cache while a real request timed
   * out at 30 seconds.
   *
   * That false green is not merely cosmetic. Every probe script in `scripts/`
   * uses a health check to decide whether it is safe to send the next request,
   * so a liveness answer served from memory disables the one guard standing
   * between a wedged Tally and a script that keeps pushing requests at it.
   *
   * Writing is skipped as well as reading, so a liveness probe can never
   * displace a real cache entry, and repeated checks always reach Tally.
   */
  bypassCache?: boolean;
}

export interface TallyResponse {
  /** Decoded and sanitised body text. */
  body: string;
  /** Encoding actually used, as detected from the bytes. */
  encoding: string;
  /** Repairs applied by sanitisation. Surfaced to callers as warnings. */
  repairs: string[];
  /** True when the payload looks like JSON rather than XML. */
  isJson: boolean;
}

/** Upper bound on distinct cache entries, so a long session cannot grow this unboundedly. */
const MAX_CACHE_ENTRIES = 200;

/**
 * Upper bound on the BYTES this cache holds, which is the bound that matters.
 *
 * A count of 200 is not a memory bound when the entries are Tally responses.
 * Measured live 2026-08-22 on a 330-ledger book, one all-fields ledger response
 * was 5.22 MB — 200 of those is about 1 GB — and the voucher responses recorded
 * in requests.ts run to 39 MB and 79 MB, where 200 entries is more memory than
 * the machine has. The count was never reached in practice, so nothing evicted,
 * so the ceiling was whatever the session happened to ask for.
 *
 * 64 MB, so a working set of the ordinary requests (a curated ledger fetch is
 * 190 KB, a company list 649 bytes) all fit comfortably while two large voucher
 * payloads cannot sit here unnoticed. Both bounds apply: the count still stops a
 * long session accumulating thousands of tiny entries.
 */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

interface CacheEntry {
  expiresAt: number;
  /** Payload size, so eviction can bound bytes without re-measuring. */
  bytes: number;
  /**
   * When this response was actually read from TallyPrime. Reported as provenance
   * on every cache hit, so an answer served from memory is dated by when its
   * data was fetched rather than by when it was handed over.
   */
  fetchedAt: number;
  response: TallyResponse;
}

export class TallyClient {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #queue: RequestQueue;
  readonly #fetchImpl: typeof fetch;
  readonly #cache = new Map<string, CacheEntry>();
  /** Running total of `bytes` across #cache, kept in step with every add and delete. */
  #cacheBytes = 0;

  constructor(
    config: AppConfig,
    logger: Logger,
    options: { queue?: RequestQueue; fetchImpl?: typeof fetch } = {}
  ) {
    this.#config = config;
    this.#logger = logger.child({ component: 'TallyClient' });
    // The queue is shared across all callers by default: the constraint is
    // Tally's, not any single caller's.
    this.#queue = options.queue ?? new RequestQueue();
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Queue depth, for logging and tests. */
  get queueDepth(): number {
    return this.#queue.depth;
  }

  /**
   * Send a request body to Tally and return the decoded response.
   *
   * Identical requests (same body and request class) made within
   * `tallyCacheTtlMs` are served from memory rather than re-sent. This is the
   * common case within a single user question: resolving "Mr Sai" by name,
   * then pulling his salary ledger and his professional fees ledger, all
   * re-fetch the same full ledger master, and a search across the same
   * financial year followed by a ledger statement re-fetch the same voucher
   * register. Only a cache hit skips the queue entirely — a miss still goes
   * through it, so the one-request-at-a-time constraint on Tally itself is
   * unaffected.
   *
   * Above that sits a per-tool-call memo, which is what makes the several
   * helpers that each re-resolve the loaded company cost one request rather
   * than three. Unlike the cache it is not TTL-gated, so those duplicates stay
   * free even when caching is switched off entirely; unlike the cache it cannot
   * outlive the call. `bypassCache` opts out of both, so a liveness probe still
   * reaches the wire every time it is asked to.
   */
  async send(
    body: string,
    requestClass: RequestClass = 'standard',
    options: SendOptions = {}
  ): Promise<TallyResponse> {
    // Provenance first, before any early return: a request served from cache
    // or from the memo is still the request that produced the caller's figures.
    noteQuery(body);

    if (options.bypassCache === true) return this.#fetchOrServe(body, requestClass, true);

    // Separator is a NUL escape for the same reason as the cache key below: it
    // cannot occur in an XML body, so no two (class, body) pairs can collide.
    return memoizeWithinCall(`${requestClass}\0${body}`, () =>
      this.#fetchOrServe(body, requestClass, false)
    );
  }

  /**
   * The response cache and the send behind it.
   *
   * `noteDataFetchedAt` is called from in here, which is correct even though a
   * memo hit skips it: it keeps the EARLIEST contributing fetch time, so noting
   * one moment once and noting that same moment three times give the same
   * answer.
   */
  async #fetchOrServe(
    body: string,
    requestClass: RequestClass,
    bypassCache: boolean
  ): Promise<TallyResponse> {
    const ttlMs = this.#config.tallyCacheTtlMs;
    // NOTE: the separator below is a literal NUL, not a space. It is committed
    // that way deliberately — a NUL cannot occur in an XML request body, so it
    // is the one separator that cannot make two different (class, body) pairs
    // collide. It also makes this file read as binary to grep, so search it
    // with `grep -a` and edit this line byte-exactly.
    //
    // bypassCache leaves the key undefined, which skips the read below AND the
    // write further down: a liveness probe then never displaces a real entry,
    // and every repeat check actually reaches Tally. It also skips the
    // per-call memo in `send`, for the same reason.
    const key =
      ttlMs > 0 && !bypassCache ? `${requestClass}\0${body}` : undefined;

    if (key !== undefined) {
      const cached = this.#cache.get(key);
      if (cached !== undefined && cached.expiresAt > Date.now()) {
        this.#logger.debug('served Tally request from cache', { requestClass });
        // Dated by the original fetch, not by this hit. With the cache TTL at
        // five minutes the difference is material, and an answer claiming to be
        // current when its data is minutes old is a wrong provenance claim.
        noteDataFetchedAt(cached.fetchedAt);
        return cached.response;
      }
    }

    const response = await this.#queue.run(() => this.#sendNow(body, requestClass));

    /*
     * ONE clock reading, used for both the answer's provenance and the cache
     * entry's.
     *
     * These used to be two separate `Date.now()` calls a few lines apart. When
     * a millisecond ticked between them the cache recorded a `fetchedAt` LATER
     * than the live answer had just reported, so the same data was dated
     * differently depending on whether it arrived fresh or from the cache —
     * and the cached copy claimed to be the fresher of the two, which is
     * backwards. One read cannot disagree with itself.
     */
    const fetchedAt = Date.now();
    // A live send is the freshest an answer can be.
    noteDataFetchedAt(fetchedAt);

    if (key !== undefined) {
      this.#cacheStore(key, response, ttlMs, fetchedAt);
    }

    return response;
  }

  #cacheStore(
    key: string,
    response: TallyResponse,
    ttlMs: number,
    /** When the data was read. The TTL runs from then, not from this store. */
    fetchedAt: number
  ): void {
    const bytes = response.body.length;

    // Replacing a key: drop the old weight before adding the new.
    this.#forget(key);

    // Both bounds, oldest first. Insertion order — which Map preserves — is
    // close enough to LRU for a bound whose only job is to stop unbounded
    // growth. The byte loop can evict several entries for one large arrival,
    // which is the point: without it a single 79 MB voucher response sat here
    // until the TTL expired, however little else fitted alongside it.
    while (this.#cache.size >= MAX_CACHE_ENTRIES || this.#cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#forget(oldest);
    }

    // A single payload larger than the whole budget is not cached at all rather
    // than emptying the cache to hold one thing it will evict again shortly.
    if (bytes > MAX_CACHE_BYTES) {
      this.#logger.debug('response too large to cache', { bytes });
      return;
    }

    this.#cache.set(key, { expiresAt: fetchedAt + ttlMs, fetchedAt, bytes, response });
    this.#cacheBytes += bytes;
  }

  /** Remove one entry and its weight together, so the running total cannot drift. */
  #forget(key: string): void {
    const existing = this.#cache.get(key);
    if (existing === undefined) return;
    this.#cacheBytes -= existing.bytes;
    this.#cache.delete(key);
  }

  async #sendNow(body: string, requestClass: RequestClass): Promise<TallyResponse> {
    const timeoutMs =
      requestClass === 'report' ? this.#config.tallyReportTimeoutMs : this.#config.tallyTimeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    this.#logger.debug('sending request to Tally', {
      bytes: body.length,
      requestClass,
      timeoutMs,
    });

    let response: Response;
    try {
      response = await this.#fetchImpl(this.#config.tallyBaseUrl, {
        method: 'POST',
        // Tally accepts the request body as XML regardless of the response
        // format requested via SVEXPORTFORMAT.
        headers: { 'Content-Type': 'text/xml;charset=utf-8' },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw this.#mapTransportError(error, timeoutMs);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new TallyError(
        'TALLY_INVALID_RESPONSE',
        `TallyPrime returned HTTP ${String(response.status)} (${response.statusText}).`,
        { context: { status: response.status } }
      );
    }

    const raw = Buffer.from(await response.arrayBuffer());
    const { text, encoding } = decodeTallyPayload(raw, response.headers.get('content-type'));

    this.#logger.debug('received response from Tally', {
      bytes: raw.byteLength,
      encoding,
      elapsedMs: Date.now() - startedAt,
    });

    if (text.trim() === '') {
      throw new TallyError(
        'TALLY_INVALID_RESPONSE',
        'TallyPrime returned an empty response.',
        // An empty body usually means the company is not loaded, so point there.
        {
          suggestion:
            'Check that a company is loaded in TallyPrime and that the request targets it.',
        }
      );
    }

    const isJson = looksLikeJson(text);

    if (isJson) {
      // JSON needs no XML sanitisation; malformed JSON surfaces at parse time.
      return { body: text, encoding, repairs: [], isJson: true };
    }

    const encodingFix = normalizeEncodingDeclaration(text, encoding);
    const sanitised = sanitizeTallyXml(encodingFix.xml);
    const repairs = [
      ...(encodingFix.repair ? [encodingFix.repair] : []),
      ...sanitised.repairs,
    ];

    if (repairs.length > 0) {
      this.#logger.warn('repaired a malformed Tally payload', { repairs });
      // Full payload only at DEBUG — these contain complete accounting records.
      this.#logger.logRawPayload('tally response', text);
    }

    return { body: sanitised.xml, encoding, repairs, isJson: false };
  }

  /** Turn a fetch/network failure into a stable, actionable TallyError. */
  #mapTransportError(error: unknown, timeoutMs: number): TallyError {
    if (error instanceof Error && error.name === 'AbortError') {
      return new TallyError(
        'TALLY_TIMEOUT',
        `TallyPrime did not respond within ${String(timeoutMs)}ms.`,
        { cause: error }
      );
    }

    const code = extractSystemErrorCode(error);

    if (code === 'ECONNREFUSED') {
      return new TallyError(
        'TALLY_NOT_RUNNING',
        `Nothing is listening at ${this.#config.tallyBaseUrl}.`,
        {
          suggestion:
            'Start TallyPrime, load a company, and enable its HTTP server: F1 > Settings > Connectivity > Client/Server configuration, with "TallyPrime acts as" set to Both or Server and the port matching TALLY_PORT.',
          cause: error,
        }
      );
    }

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new TallyError(
        'TALLY_CONNECTION_FAILED',
        `The host "${this.#config.tallyHost}" could not be resolved.`,
        { suggestion: 'Check TALLY_HOST. For a local install this should be 127.0.0.1.', cause: error }
      );
    }

    return new TallyError(
      'TALLY_CONNECTION_FAILED',
      `Could not reach TallyPrime at ${this.#config.tallyBaseUrl}.`,
      { cause: error }
    );
  }
}

/**
 * Dig a Node system error code out of a fetch failure.
 *
 * Node wraps network failures as `TypeError: fetch failed` whose `cause` is
 * often an AggregateError — one entry per address tried, e.g. IPv6 and IPv4
 * for localhost. The useful code (ECONNREFUSED) is inside that array, so a
 * plain cause-chain walk misses it and everything degrades to a generic
 * connection failure with no actionable suggestion.
 */
function extractSystemErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 5 || error === null || error === undefined || typeof error !== 'object') {
    return undefined;
  }

  if ('code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }

  if ('errors' in error) {
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const nested of errors as unknown[]) {
        const found = extractSystemErrorCode(nested, depth + 1);
        if (found !== undefined) return found;
      }
    }
  }

  if ('cause' in error) {
    return extractSystemErrorCode((error as { cause?: unknown }).cause, depth + 1);
  }

  return undefined;
}

/**
 * Decode a Tally payload, detecting the encoding from the bytes themselves.
 *
 * Tally commonly returns UTF-16LE while declaring something else, or while
 * the Content-Type header says otherwise. Byte inspection is authoritative
 * here; the declaration is treated as a hint at best.
 */
export function decodeTallyPayload(
  raw: Buffer,
  contentType: string | null
): { text: string; encoding: string } {
  if (raw.byteLength === 0) return { text: '', encoding: 'utf-8' };

  const b0 = raw[0];
  const b1 = raw[1];

  // Byte-order marks are definitive.
  if (b0 === 0xff && b1 === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(raw.subarray(2)), encoding: 'utf-16le' };
  }
  if (b0 === 0xfe && b1 === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(raw.subarray(2)), encoding: 'utf-16be' };
  }
  if (b0 === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(raw.subarray(3)), encoding: 'utf-8' };
  }

  // No BOM. UTF-16LE ASCII text puts a zero in every second byte, which is a
  // reliable tell for the markup Tally emits.
  const looksUtf16Le = raw.byteLength >= 4 && b1 === 0x00 && raw[3] === 0x00 && b0 !== 0x00;
  if (looksUtf16Le) {
    return { text: new TextDecoder('utf-16le').decode(raw), encoding: 'utf-16le' };
  }

  // A declared charset is only a hint, and Tally's is often wrong. Honour it
  // solely when the bytes do not contradict it — decoding single-byte text as
  // UTF-16 produces silent mojibake rather than an error, which would then
  // flow into the parser as unreadable ledger names.
  const declared = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  if ((declared === 'utf-16' || declared === 'utf-16le') && containsNullBytes(raw)) {
    return { text: new TextDecoder('utf-16le').decode(raw), encoding: 'utf-16le' };
  }

  /*
   * Single byte per character, and NOT necessarily UTF-8.
   *
   * Verified live 2026-08-14 against a German company: TallyPrime answered with
   * `Content-Type: text/xml; charset=utf-8` and a body containing ISO-8859-1
   * bytes. `<LEDGER NAME="Allg\xE4uer \xD6lm\xFChle GmbH">` is "Allgäuer Ölmühle
   * GmbH" in Latin-1, and every one of those bytes is INVALID UTF-8.
   *
   * This mattered because the decode below used to be non-fatal, which is
   * TextDecoder's default: an invalid byte became U+FFFD silently. So roughly
   * twenty real party and ledger names in that company arrived corrupted —
   * "Allg�uer �lm�hle GmbH" — with nothing anywhere reporting a problem. Worse
   * than cosmetic: a name is an identity here. `tally_get_ledgers({ name: ... })`
   * matches on it, `tally_search` searches it, and a party statement is keyed by
   * it, so a corrupted name silently fails to match the party it names.
   *
   * So: attempt UTF-8 STRICTLY. A clean decode means it really was UTF-8 and
   * nothing is assumed. A throw means it was not, and the bytes are read as a
   * single-byte Windows codepage instead, which is lossless — every byte 0x00
   * to 0xFF maps to a character, so there is no replacement character and no
   * silent loss.
   *
   * windows-1252 rather than iso-8859-1 because Tally is a Windows application
   * and the two agree on every byte from 0xA0 up; they differ only in 0x80-0x9F,
   * where Latin-1 has unusable C1 controls and cp1252 has real punctuation
   * (curly quotes, dashes, the euro sign). Choosing cp1252 can only turn a
   * control character into a printable one.
   *
   * What this canNOT recover: a character TallyPrime substituted BEFORE export.
   * The same company's euro symbol arrives as a literal `0x3F` question mark,
   * because the euro is not in the codepage Tally exported with. That loss
   * happens inside Tally and no decoding fixes it — see `currencyIsUnavailable`
   * in normalize.ts, which reports it rather than passing "?" off as a symbol.
   */
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), encoding: 'utf-8' };
  } catch {
    return { text: decodeSingleByte(raw), encoding: 'windows-1252' };
  }
}

/**
 * Decode as Windows-1252, falling back to Latin-1 where that label is missing.
 *
 * The fallback is not theoretical: `TextDecoder` only supports non-UTF encodings
 * when Node is built with full ICU, and a small-ICU build throws on the label.
 * Latin-1 via `Buffer` is always available and agrees with cp1252 on every byte
 * that carries an accented character, so the degradation is confined to the
 * 0x80-0x9F punctuation range.
 */
function decodeSingleByte(raw: Buffer): string {
  try {
    return new TextDecoder('windows-1252').decode(raw);
  } catch {
    return raw.toString('latin1');
  }
}

/** Sample the head of the payload for the null bytes UTF-16 text would contain. */
function containsNullBytes(raw: Buffer): boolean {
  const limit = Math.min(raw.byteLength, 64);
  for (let i = 0; i < limit; i += 1) {
    if (raw[i] === 0x00) return true;
  }
  return false;
}

/** Cheap structural check: does this payload look like JSON rather than XML? */
function looksLikeJson(text: string): boolean {
  const start = text.trimStart()[0];
  return start === '{' || start === '[';
}
