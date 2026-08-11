import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';

/** Capture stderr, and separately assert stdout is never touched. */
function captureStreams() {
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];

  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(chunk.toString());
      return true;
    });
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdoutLines.push(chunk.toString());
      return true;
    });

  return {
    stderrLines,
    stdoutLines,
    restore: () => {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('writes to stderr and never to stdout', () => {
    // stdout is the MCP stdio channel — one stray write corrupts the
    // JSON-RPC stream and Claude Desktop drops the connection.
    const streams = captureStreams();
    const log = createLogger('debug');

    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');

    expect(streams.stderrLines).toHaveLength(4);
    expect(streams.stdoutLines).toHaveLength(0);
    streams.restore();
  });

  it('emits one JSON object per line', () => {
    const streams = captureStreams();
    createLogger('info').info('hello', { tool: 'tally_list_ledgers' });

    const line = streams.stderrLines[0] ?? '';
    expect(line.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.tool).toBe('tally_list_ledgers');
    expect(typeof parsed.ts).toBe('string');
    streams.restore();
  });

  it('suppresses messages below the configured level', () => {
    const streams = captureStreams();
    const log = createLogger('warn');

    log.debug('no');
    log.info('no');
    log.warn('yes');
    log.error('yes');

    expect(streams.stderrLines).toHaveLength(2);
    streams.restore();
  });

  it('redacts sensitive field names at every level', () => {
    const streams = captureStreams();
    createLogger('debug').info('connecting', {
      host: '127.0.0.1',
      password: 'hunter2',
      apiKey: 'sk-live-abc',
      nested: { authToken: 'zzz' },
    });

    const line = streams.stderrLines[0] ?? '';
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('sk-live-abc');
    expect(line).not.toContain('zzz');
    expect(line).toContain('[redacted]');
    expect(line).toContain('127.0.0.1');
    streams.restore();
  });

  it('withholds raw Tally payloads unless DEBUG is enabled', () => {
    const streams = captureStreams();
    const payload = '<ENVELOPE><LEDGER>Confidential Party Ltd</LEDGER></ENVELOPE>';

    createLogger('info').logRawPayload('voucher', payload);
    expect(streams.stderrLines).toHaveLength(0);

    createLogger('debug').logRawPayload('voucher', payload);
    expect(streams.stderrLines).toHaveLength(1);
    expect(streams.stderrLines[0]).toContain('Confidential Party Ltd');
    streams.restore();
  });

  it('never throws on unserialisable fields', () => {
    const streams = captureStreams();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => createLogger('info').info('circular', circular)).not.toThrow();
    expect(streams.stderrLines).toHaveLength(1);
    streams.restore();
  });

  it('merges child bindings into every line', () => {
    const streams = captureStreams();
    createLogger('info', { component: 'client' }).child({ requestId: 'r1' }).info('sent');

    const parsed = JSON.parse(streams.stderrLines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.component).toBe('client');
    expect(parsed.requestId).toBe('r1');
    streams.restore();
  });
});
