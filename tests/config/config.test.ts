import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config/config.js';

/** Isolate each case from the ambient environment and any real .env file. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return overrides;
}

describe('loadConfig', () => {
  it('applies the documented defaults when nothing is set', () => {
    const config = loadConfig(env());

    expect(config.tallyHost).toBe('127.0.0.1');
    expect(config.tallyPort).toBe(9000);
    expect(config.tallyProtocol).toBe('http');
    expect(config.tallyTimeoutMs).toBe(30_000);
    expect(config.tallyPreferredFormat).toBe('json');
    expect(config.tallyMaxRecords).toBe(5000);
    expect(config.logLevel).toBe('info');
  });

  it('derives a usable base URL', () => {
    expect(loadConfig(env()).tallyBaseUrl).toBe('http://127.0.0.1:9000');
    expect(
      loadConfig(env({ TALLY_PROTOCOL: 'https', TALLY_HOST: 'tally.local', TALLY_PORT: '8000' }))
        .tallyBaseUrl
    ).toBe('https://tally.local:8000');
  });

  it('defaults the report timeout to four times the base timeout', () => {
    // Report-class requests are legitimately slow; sharing the 30s general
    // timeout would surface them as TALLY_TIMEOUT rather than completing.
    expect(loadConfig(env({ TALLY_TIMEOUT_MS: '10000' })).tallyReportTimeoutMs).toBe(40_000);
  });

  it('honours an explicit report timeout', () => {
    const config = loadConfig(env({ TALLY_TIMEOUT_MS: '10000', TALLY_REPORT_TIMEOUT_MS: '90000' }));
    expect(config.tallyReportTimeoutMs).toBe(90_000);
  });

  it('coerces numeric strings, since env vars are always strings', () => {
    const config = loadConfig(env({ TALLY_PORT: '9001', TALLY_MAX_RECORDS: '250' }));
    expect(config.tallyPort).toBe(9001);
    expect(config.tallyMaxRecords).toBe(250);
  });

  it('fails fast with an actionable message on an invalid port', () => {
    try {
      loadConfig(env({ TALLY_PORT: '70000' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('tallyPort');
      // The message must point at where the value really comes from.
      expect((error as ConfigError).message).toContain('claude_desktop_config.json');
    }
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig(env({ TALLY_PORT: 'nine thousand' }))).toThrow(ConfigError);
  });

  it('rejects an unsupported protocol', () => {
    expect(() => loadConfig(env({ TALLY_PROTOCOL: 'ftp' }))).toThrow(ConfigError);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig(env({ LOG_LEVEL: 'verbose' }))).toThrow(ConfigError);
  });

  it('rejects an unknown wire format', () => {
    expect(() => loadConfig(env({ TALLY_PREFERRED_FORMAT: 'yaml' }))).toThrow(ConfigError);
  });

  /**
   * The default is set by the CONTEXT budget, not the transport one. It used to
   * be 900,000 — headroom under a client's 1MB message cap — which let a single
   * legal response run to roughly 225,000 tokens and dominate the conversation it
   * belonged to. A real audit page cost about 54,000 tokens before this changed.
   */
  it('defaults the response ceiling to a context-sized budget, well under the 1MB transport cap', () => {
    expect(loadConfig(env()).tallyMaxResponseBytes).toBe(150_000);
    expect(loadConfig(env()).tallyMaxResponseBytes).toBeLessThan(1_048_576);
  });

  it('still allows the ceiling to be raised for a deliberate deep dive', () => {
    expect(loadConfig(env({ TALLY_MAX_RESPONSE_BYTES: '900000' })).tallyMaxResponseBytes).toBe(
      900_000
    );
  });

  it('honours an explicit response ceiling', () => {
    expect(loadConfig(env({ TALLY_MAX_RESPONSE_BYTES: '250000' })).tallyMaxResponseBytes).toBe(
      250_000
    );
  });

  it('rejects a response ceiling too small to hold any useful page', () => {
    expect(() => loadConfig(env({ TALLY_MAX_RESPONSE_BYTES: '500' }))).toThrow(ConfigError);
  });

  it('rejects an empty host rather than building a malformed URL', () => {
    expect(() => loadConfig(env({ TALLY_HOST: '' }))).toThrow(ConfigError);
  });

  it('reports every invalid value at once, not just the first', () => {
    try {
      loadConfig(env({ TALLY_PORT: '0', TALLY_PROTOCOL: 'ftp', LOG_LEVEL: 'verbose' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain('tallyPort');
      expect(message).toContain('tallyProtocol');
      expect(message).toContain('logLevel');
    }
  });

  it('returns a frozen object so config cannot drift at runtime', () => {
    expect(Object.isFrozen(loadConfig(env()))).toBe(true);
  });
});
