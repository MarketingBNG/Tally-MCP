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
});
