import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import { TallyError } from './TallyError.js';
import { RequestQueue } from './requestQueue.js';
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

export class TallyClient {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #queue: RequestQueue;
  readonly #fetchImpl: typeof fetch;

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
   * Every call is serialised behind the shared queue.
   */
  async send(body: string, requestClass: RequestClass = 'standard'): Promise<TallyResponse> {
    return this.#queue.run(() => this.#sendNow(body, requestClass));
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

  return { text: new TextDecoder('utf-8').decode(raw), encoding: 'utf-8' };
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
