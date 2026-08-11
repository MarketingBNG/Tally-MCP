import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { MockTallyServer } from '../../mock-tally/server.js';

/**
 * End-to-end test over the real stdio transport.
 *
 * This exercises the path that only breaks in the real host: process launch,
 * ESM resolution, the MCP handshake, and — critically — that nothing pollutes
 * stdout. A stray write there corrupts the JSON-RPC stream and Claude Desktop
 * drops the connection with an error that points nowhere useful.
 *
 * Requires `npm run build` first; skipped with a clear message otherwise.
 */

const DIST = 'dist/index.js';
const built = existsSync(DIST);

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
}

class StdioHarness {
  #proc: ChildProcessWithoutNullStreams;
  #stdout = '';
  #stderr = '';

  constructor(env: Record<string, string>) {
    this.#proc = spawn('node', [DIST], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    this.#proc.stdout.on('data', (chunk: Buffer) => (this.#stdout += chunk.toString()));
    this.#proc.stderr.on('data', (chunk: Buffer) => (this.#stderr += chunk.toString()));
  }

  send(message: Record<string, unknown>): void {
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  get stderr(): string {
    return this.#stderr;
  }

  get stdoutRaw(): string {
    return this.#stdout;
  }

  /** Every stdout line parsed as JSON-RPC. Throws if any line is not JSON. */
  messages(): JsonRpcMessage[] {
    return this.#stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as JsonRpcMessage;
        } catch {
          throw new Error(`Non-JSON content on stdout, which corrupts MCP: ${line}`);
        }
      });
  }

  async waitFor(id: number, timeoutMs = 5000): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages().find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for response id=${String(id)}.\nstderr:\n${this.#stderr}`);
  }

  async handshake(): Promise<void> {
    this.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1.0.0' },
      },
    });
    await this.waitFor(1);
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  kill(): void {
    this.#proc.kill();
  }
}

describe.skipIf(!built)('stdio integration', () => {
  let mock: MockTallyServer;
  let mockPort: number;

  beforeAll(async () => {
    mock = new MockTallyServer();
    mockPort = await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it('completes the MCP handshake and advertises its tools', async () => {
    const harness = new StdioHarness({ LOG_LEVEL: 'error', TALLY_PORT: String(mockPort) });
    try {
      await harness.handshake();

      harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const response = await harness.waitFor(2);

      const tools = (response.result as { tools: { name: string; description: string }[] }).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('tally_connection_status');

      // Tool descriptions are load-bearing: Claude selects on them.
      const status = tools.find((tool) => tool.name === 'tally_connection_status');
      expect(status?.description).toMatch(/WHEN TO USE/);
      expect(status?.description).toMatch(/read-only/i);
    } finally {
      harness.kill();
    }
  });

  it('runs a tool call end to end against a mock Tally', async () => {
    mock.reset();
    mock.onBodyContaining('ENVELOPE', {
      body: '<ENVELOPE><COMPANY><NAME>Acme Traders</NAME></COMPANY></ENVELOPE>',
    });

    const harness = new StdioHarness({ LOG_LEVEL: 'error', TALLY_PORT: String(mockPort) });
    try {
      await harness.handshake();
      harness.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'tally_connection_status', arguments: {} },
      });

      const response = await harness.waitFor(3);
      const result = response.result as { content: { text: string }[]; isError?: boolean };
      const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
        connected: boolean;
        responseFormat: string;
      };

      expect(payload.connected).toBe(true);
      expect(payload.responseFormat).toBe('xml');
      expect(result.isError).toBeUndefined();
      expect(mock.requests.length).toBeGreaterThan(0);
    } finally {
      harness.kill();
    }
  });

  it('returns a structured error, not a stack trace, when Tally is unreachable', async () => {
    const harness = new StdioHarness({ LOG_LEVEL: 'error', TALLY_PORT: '49321' });
    try {
      await harness.handshake();
      harness.send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'tally_connection_status', arguments: {} },
      });

      const response = await harness.waitFor(4);
      const result = response.result as { content: { text: string }[]; isError?: boolean };
      const text = result.content[0]?.text ?? '';

      expect(result.isError).toBe(true);
      expect(text).toContain('TALLY_NOT_RUNNING');
      expect(text).toMatch(/Client\/Server configuration/);
      // No stack trace may cross the MCP boundary.
      expect(text).not.toMatch(/\n\s+at /);
      expect(text).not.toContain('.ts:');
    } finally {
      harness.kill();
    }
  });

  it('writes diagnostics to stderr and keeps stdout pure JSON-RPC', async () => {
    const harness = new StdioHarness({ LOG_LEVEL: 'debug', TALLY_PORT: String(mockPort) });
    try {
      await harness.handshake();
      harness.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
      await harness.waitFor(5);

      // At debug level there is definitely log output; it must all be stderr.
      expect(harness.stderr.length).toBeGreaterThan(0);
      expect(harness.stderr).toContain('tally-mcp ready');

      // messages() throws on any non-JSON line, so this asserts stdout purity.
      expect(() => harness.messages()).not.toThrow();
      expect(harness.stdoutRaw).not.toContain('tally-mcp ready');
    } finally {
      harness.kill();
    }
  });
});

describe.skipIf(built)('stdio integration (skipped)', () => {
  it('needs a build first', () => {
    expect.soft(built, 'Run `npm run build` before the integration tests.').toBe(true);
  });
});
