import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockTallyServer } from '../../mock-tally/server.js';
import { TallyClient, decodeTallyPayload } from '../../src/tally/TallyClient.js';
import { loadConfig, type AppConfig } from '../../src/config/config.js';
import { createLogger } from '../../src/utils/logger.js';
import type { TallyError } from '../../src/tally/TallyError.js';

const silentLogger = createLogger('error');

let mock: MockTallyServer;
let port: number;

function configFor(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    TALLY_HOST: '127.0.0.1',
    TALLY_PORT: String(port),
    LOG_LEVEL: 'error',
    ...overrides,
  });
}

const OK_XML = '<ENVELOPE><DATA>ok</DATA></ENVELOPE>';

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
});

describe('TallyClient.send', () => {
  it('posts the body and returns the decoded response', async () => {
    mock.onBodyContaining('ENVELOPE', { body: OK_XML, contentType: 'text/xml;charset=utf-8' });

    const client = new TallyClient(configFor(), silentLogger);
    const response = await client.send('<ENVELOPE><HEADER/></ENVELOPE>');

    expect(response.body).toBe(OK_XML);
    expect(response.isJson).toBe(false);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.method).toBe('POST');
  });

  it('detects a JSON response', async () => {
    mock.onBodyContaining('ENVELOPE', {
      body: '{"ok":true}',
      contentType: 'application/json',
    });

    const response = await new TallyClient(configFor(), silentLogger).send('<ENVELOPE/>');

    expect(response.isJson).toBe(true);
    expect(response.body).toBe('{"ok":true}');
    // JSON needs no XML sanitisation.
    expect(response.repairs).toEqual([]);
  });

  it('decodes a UTF-16LE response, which is what Tally commonly sends', async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(OK_XML, 'utf16le'),
    ]).toString('binary');

    mock.onBodyContaining('ENVELOPE', {
      body: utf16,
      contentType: 'text/xml;charset=utf-16',
    });

    // The mock writes the string back as latin1 bytes, preserving the exact
    // byte sequence the client must decode.
    const response = await new TallyClient(configFor(), silentLogger).send('<ENVELOPE/>');
    expect(response.body).toContain('ok');
  });

  it('sanitises a malformed payload and reports the repairs', async () => {
    mock.onBodyContaining('ENVELOPE', {
      body: '<ENVELOPE><NARRATION>Gupta & Co&#4; ref 1</NARRATION></ENVELOPE>',
    });

    const response = await new TallyClient(configFor(), silentLogger).send('<ENVELOPE/>');

    expect(response.body).not.toContain('&#4;');
    expect(response.body).toContain('&amp;');
    expect(response.repairs.length).toBeGreaterThan(0);
  });

  it('serialises concurrent calls so only one request is in flight', async () => {
    // Tally serves one request at a time; overlapping here would mean
    // overlapping there.
    let concurrent = 0;
    let maxConcurrent = 0;

    mock.onBodyContaining('ENVELOPE', () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      concurrent -= 1;
      return { body: OK_XML, delayMs: 15 };
    });

    const client = new TallyClient(configFor(), silentLogger);
    await Promise.all([
      client.send('<ENVELOPE>1</ENVELOPE>'),
      client.send('<ENVELOPE>2</ENVELOPE>'),
      client.send('<ENVELOPE>3</ENVELOPE>'),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(mock.requests).toHaveLength(3);
  });
});

describe('TallyClient error mapping', () => {
  it('maps a refused connection to TALLY_NOT_RUNNING with setup guidance', async () => {
    // A valid but closed high port. (Low ports such as 1 are rejected by Node
    // as "bad port" before a connection is attempted, so they exercise a
    // different path entirely.)
    const client = new TallyClient(
      loadConfig({ TALLY_HOST: '127.0.0.1', TALLY_PORT: '49321' }),
      silentLogger
    );

    try {
      await client.send('<ENVELOPE/>');
      expect.unreachable('should have thrown');
    } catch (error) {
      const tallyError = error as TallyError;
      expect(tallyError.code).toBe('TALLY_NOT_RUNNING');
      expect(tallyError.suggestion).toMatch(/Client\/Server configuration/);
    }
  });

  it('maps an aborted request to TALLY_TIMEOUT', async () => {
    // The config floor for TALLY_TIMEOUT_MS is 1000ms, so an abort is injected
    // rather than making the suite wait a real second.
    const aborting: typeof fetch = () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    };

    const client = new TallyClient(configFor(), silentLogger, { fetchImpl: aborting });

    await expect(client.send('<ENVELOPE/>')).rejects.toMatchObject({ code: 'TALLY_TIMEOUT' });
  });

  it('maps an HTTP error status to TALLY_INVALID_RESPONSE', async () => {
    mock.onBodyContaining('ENVELOPE', { status: 500, body: 'Internal error' });

    await expect(new TallyClient(configFor(), silentLogger).send('<ENVELOPE/>')).rejects.toMatchObject(
      { code: 'TALLY_INVALID_RESPONSE' }
    );
  });

  it('treats an empty body as invalid and points at the loaded company', async () => {
    mock.onBodyContaining('ENVELOPE', { body: '' });

    try {
      await new TallyClient(configFor(), silentLogger).send('<ENVELOPE/>');
      expect.unreachable('should have thrown');
    } catch (error) {
      const tallyError = error as TallyError;
      expect(tallyError.code).toBe('TALLY_INVALID_RESPONSE');
      expect(tallyError.suggestion).toMatch(/company is loaded/i);
    }
  });

  it('never leaks a stack trace through the client payload', async () => {
    mock.onBodyContaining('ENVELOPE', { status: 503, body: 'nope' });

    try {
      await new TallyClient(configFor(), silentLogger).send('<ENVELOPE/>');
      expect.unreachable('should have thrown');
    } catch (error) {
      const tallyError = error as TallyError;
      const payload = tallyError.toClientPayload();

      // The error carries a stack internally; the client payload must not.
      expect(tallyError.stack).toBeTruthy();
      expect(Object.keys(payload.error).sort()).toEqual(['code', 'message', 'suggestion']);

      const serialised = JSON.stringify(payload);
      expect(serialised).not.toContain('.ts:');
      expect(serialised).not.toMatch(/\n\s+at /);
      expect(serialised).not.toContain('TallyClient');
    }
  });
});

describe('decodeTallyPayload', () => {
  it('honours a UTF-16LE byte-order mark', () => {
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<A>x</A>', 'utf16le')]);
    expect(decodeTallyPayload(raw, null)).toEqual({ text: '<A>x</A>', encoding: 'utf-16le' });
  });

  it('honours a UTF-8 byte-order mark', () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<A>x</A>', 'utf8')]);
    expect(decodeTallyPayload(raw, null).encoding).toBe('utf-8');
  });

  it('detects UTF-16LE without a BOM from its interleaved zero bytes', () => {
    const raw = Buffer.from('<A>x</A>', 'utf16le');
    expect(decodeTallyPayload(raw, null)).toEqual({ text: '<A>x</A>', encoding: 'utf-16le' });
  });

  it('falls back to the declared charset when bytes are ambiguous', () => {
    const raw = Buffer.from('<A>x</A>', 'utf16le');
    expect(decodeTallyPayload(raw, 'text/xml;charset=utf-16').encoding).toBe('utf-16le');
  });

  it('defaults to UTF-8', () => {
    expect(decodeTallyPayload(Buffer.from('<A>x</A>', 'utf8'), null).encoding).toBe('utf-8');
  });

  it('handles an empty payload without throwing', () => {
    expect(decodeTallyPayload(Buffer.alloc(0), null)).toEqual({ text: '', encoding: 'utf-8' });
  });

  /**
   * Regression, found live 2026-08-14. TallyPrime answered
   * `Content-Type: text/xml; charset=utf-8` with a body full of ISO-8859-1 bytes.
   * The decode used to be non-fatal UTF-8, so each of those bytes became U+FFFD
   * and around twenty real party names in that company arrived corrupted with
   * nothing reporting a problem.
   *
   * A name is an identity here — `tally_get_masters({name})`, `tally_search` and
   * the party statement all match on it — so a mangled name silently fails to
   * find the party it names.
   */
  describe('single-byte payloads that lie about being UTF-8', () => {
    // "Allgäuer Ölmühle GmbH" in Latin-1: ä=0xE4, Ö=0xD6, ü=0xFC. Byte-for-byte
    // what the live install sent, so this fails if the strict-decode step is
    // removed. Not real data — the name is from a fixture, not from samples/.
    const latin1Name = Buffer.from([
      0x3c, 0x41, 0x3e, // <A>
      0x41, 0x6c, 0x6c, 0x67, 0xe4, 0x75, 0x65, 0x72, 0x20, // Allgäuer
      0xd6, 0x6c, 0x6d, 0xfc, 0x68, 0x6c, 0x65, // Ölmühle
      0x3c, 0x2f, 0x41, 0x3e, // </A>
    ]);

    it('recovers accented characters instead of replacing them', () => {
      const { text } = decodeTallyPayload(latin1Name, 'text/xml; charset=utf-8');

      expect(text).toBe('<A>Allgäuer Ölmühle</A>');
      // The specific corruption this fixes.
      expect(text).not.toContain('�');
    });

    it('reports the encoding it actually used, not the declared one', () => {
      // The header said utf-8 and was wrong. Believing it is the bug.
      expect(decodeTallyPayload(latin1Name, 'text/xml; charset=utf-8').encoding).toBe(
        'windows-1252'
      );
    });

    it('loses nothing: every byte maps to a character', () => {
      // Single-byte decoding is total, so no input can produce a replacement
      // character. Sweeping the whole byte range proves there is no silent gap.
      const everyByte = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      const { text } = decodeTallyPayload(everyByte, null);
      expect(text).not.toContain('�');
    });

    it('still prefers UTF-8 when the bytes really are UTF-8', () => {
      // The same characters, correctly encoded. Multi-byte UTF-8 must not be
      // mistaken for two Latin-1 characters — that would be mojibake introduced
      // by the fix rather than removed by it.
      const utf8 = Buffer.from('<A>Allgäuer Ölmühle</A>', 'utf8');
      expect(decodeTallyPayload(utf8, null)).toEqual({
        text: '<A>Allgäuer Ölmühle</A>',
        encoding: 'utf-8',
      });
    });

    it('leaves pure ASCII on the UTF-8 path', () => {
      // ASCII is valid UTF-8, so nothing changes for the vast majority of
      // responses and the fallback stays confined to payloads that need it.
      expect(decodeTallyPayload(Buffer.from('<A>plain</A>', 'utf8'), null).encoding).toBe('utf-8');
    });
  });
});

describe('response cache and the liveness exception', () => {
  /**
   * These tests exist because their absence shipped a real bug.
   *
   * `tally_connection_status` sends a byte-identical probe body every time, so
   * with a five-minute cache TTL every call after the first was answered from
   * memory. On 2026-08-14, with TallyPrime parked behind a modal "incorrect
   * object type" dialog and serving nothing, it reported
   * `connected: true, responseTimeMs: 0` while a real request timed out at 30s.
   *
   * That is worse than a cosmetic wrong answer: every probe script under
   * `scripts/` calls that tool to decide whether it is safe to send the next
   * request, so the false green disabled the only guard standing between a
   * wedged Tally and a script that keeps pushing requests at it.
   */
  it('serves an identical request from cache rather than re-sending it', async () => {
    mock.onBodyContaining('ENVELOPE', { body: OK_XML, contentType: 'text/xml;charset=utf-8' });
    const client = new TallyClient(configFor({ TALLY_CACHE_TTL_MS: '60000' }), silentLogger);

    await client.send('<ENVELOPE>same</ENVELOPE>');
    await client.send('<ENVELOPE>same</ENVELOPE>');

    // The baseline the cache exists for. If this ever becomes 2, the caching
    // behaviour the performance work depends on has regressed.
    expect(mock.requests.length).toBe(1);
  });

  it('reaches Tally every time when bypassCache is set', async () => {
    mock.onBodyContaining('ENVELOPE', { body: OK_XML, contentType: 'text/xml;charset=utf-8' });
    const client = new TallyClient(configFor({ TALLY_CACHE_TTL_MS: '60000' }), silentLogger);

    await client.send('<ENVELOPE>same</ENVELOPE>', 'standard', { bypassCache: true });
    await client.send('<ENVELOPE>same</ENVELOPE>', 'standard', { bypassCache: true });

    // The fix: a liveness question must be answered by Tally, not by memory.
    expect(mock.requests.length).toBe(2);
  });

  it('does not populate the cache from a bypassed send', async () => {
    mock.onBodyContaining('ENVELOPE', { body: OK_XML, contentType: 'text/xml;charset=utf-8' });
    const client = new TallyClient(configFor({ TALLY_CACHE_TTL_MS: '60000' }), silentLogger);

    // If a bypassed send WROTE to the cache, a health probe would silently
    // satisfy a later real request for the same body — turning the liveness
    // check into a source of stale data rather than merely a poor check.
    await client.send('<ENVELOPE>same</ENVELOPE>', 'standard', { bypassCache: true });
    await client.send('<ENVELOPE>same</ENVELOPE>');

    expect(mock.requests.length).toBe(2);
  });

  it('reports a failure when Tally stops answering, even after a success', async () => {
    mock.onBodyContaining('ENVELOPE', { body: OK_XML, contentType: 'text/xml;charset=utf-8' });
    const client = new TallyClient(
      configFor({ TALLY_CACHE_TTL_MS: '60000', TALLY_TIMEOUT_MS: '1000' }),
      silentLogger
    );

    // Succeed once so the cache is warm for this exact body — the precise
    // situation in which the shipped bug reported a false green.
    await client.send('<ENVELOPE>probe</ENVELOPE>', 'standard', { bypassCache: true });

    await mock.stop();
    await expect(
      client.send('<ENVELOPE>probe</ENVELOPE>', 'standard', { bypassCache: true })
    ).rejects.toThrow();

    // Restore for any later test in the file: the shared server is stopped above.
    port = await mock.start();
  });
});
