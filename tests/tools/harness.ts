import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import { MockTallyServer } from '../../mock-tally/server.js';
import { TallyClient } from '../../src/tally/TallyClient.js';
import { loadConfig, type AppConfig } from '../../src/config/config.js';
import { createLogger } from '../../src/utils/logger.js';
import type { ToolDeps } from '../../src/tools/toolResult.js';

/**
 * Test harness for tool handlers.
 *
 * Rather than standing up the MCP protocol, this captures what each tool
 * registers and calls the handler directly. The handler, its Zod schema and
 * the whole client/parser stack underneath are the real thing — only the
 * transport is skipped, and there is a separate stdio integration test for
 * that.
 */

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

export interface ToolRegistry {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
  schemas: Map<string, { parse: (value: unknown) => unknown } | undefined>;
  /**
   * Each tool's description, captured so tests can assert on it.
   *
   * Descriptions are load-bearing rather than documentation — Claude selects
   * tools on them, and a consolidated tool's per-variant caveats live nowhere
   * else. A merge that flattened them would pass every other test in this
   * suite, so the text has to be assertable.
   */
  descriptions: Map<string, string>;
}

/** A stand-in for McpServer that records registrations instead of serving them. */
export function createToolRegistry(): ToolRegistry {
  const handlers = new Map<string, ToolHandler>();
  const schemas = new Map<string, { parse: (value: unknown) => unknown } | undefined>();
  const descriptions = new Map<string, string>();

  const server = {
    registerTool(
      name: string,
      config: { inputSchema?: { parse: (value: unknown) => unknown }; description?: string },
      handler: ToolHandler
    ) {
      handlers.set(name, handler);
      schemas.set(name, config.inputSchema);
      descriptions.set(name, config.description ?? '');
      return { name };
    },
    registerResource() {
      return { name: 'resource' };
    },
  } as unknown as McpServer;

  return { server, handlers, schemas, descriptions };
}

/**
 * Call a tool the way the MCP runtime would: validate the arguments against
 * the tool's own schema first, then hand the parsed result to the handler.
 * Skipping the schema would let tests pass arguments the real runtime rejects.
 */
export async function callTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const handler = registry.handlers.get(name);
  if (!handler) throw new Error(`Tool "${name}" was never registered.`);

  const schema = registry.schemas.get(name);
  const parsed = schema ? (schema.parse(args) as Record<string, unknown>) : args;

  const output = await handler(parsed);
  const text = output.content[0]?.text ?? '';
  return JSON.parse(text) as unknown;
}

/**
 * Call a tool and assert it succeeded, returning the tool's own payload.
 *
 * Data tools wrap their payload in the §4 envelope, so this unwraps `data` and
 * a test can go on asserting about the tool's own shape. Use
 * `callToolEnvelope` when the envelope itself is what is under test.
 *
 * The unwrap is conditional rather than unconditional because
 * `tally_connection_status` deliberately does not go through `runTool` — it
 * returns no accounting data, so it has nothing to put in the envelope's
 * fields, and forcing one on it would be a fiction.
 */
export async function callToolOk(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const payload = await callToolEnvelope(registry, name, args);
  return isEnveloped(payload) ? (payload.data as Record<string, unknown>) : payload;
}

/** Call a tool and assert it succeeded, returning the whole envelope. */
export async function callToolEnvelope(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const handler = registry.handlers.get(name);
  if (!handler) throw new Error(`Tool "${name}" was never registered.`);

  const schema = registry.schemas.get(name);
  const parsed = schema ? (schema.parse(args) as Record<string, unknown>) : args;
  const output = await handler(parsed);
  const payload = JSON.parse(output.content[0]?.text ?? '{}') as Record<string, unknown>;

  if (output.isError === true) {
    throw new Error(`Tool "${name}" failed: ${JSON.stringify(payload)}`);
  }
  return payload;
}

/** Distinguish an enveloped response from a bare one, on more than one field. */
function isEnveloped(payload: Record<string, unknown>): boolean {
  return 'data' in payload && 'as_of_timestamp' in payload && 'truncated' in payload;
}

/** Call a tool expecting failure, returning the error payload. */
export async function callToolError(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ code: string; message: string; suggestion: string }> {
  const handler = registry.handlers.get(name);
  if (!handler) throw new Error(`Tool "${name}" was never registered.`);

  const schema = registry.schemas.get(name);
  const parsed = schema ? (schema.parse(args) as Record<string, unknown>) : args;
  const output = await handler(parsed);
  const payload = JSON.parse(output.content[0]?.text ?? '{}') as {
    error?: { code: string; message: string; suggestion: string };
  };

  if (output.isError !== true || !payload.error) {
    throw new Error(`Tool "${name}" was expected to fail but did not.`);
  }
  return payload.error;
}

/** Redacted real Tally responses — see tests/fixtures/README.md. */
export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf-8');
}

export function makeDeps(mockPort: number, overrides: Record<string, string> = {}): ToolDeps {
  const config: AppConfig = loadConfig({
    TALLY_HOST: '127.0.0.1',
    TALLY_PORT: String(mockPort),
    LOG_LEVEL: 'error',
    ...overrides,
  });
  const logger = createLogger('error');
  return { client: new TallyClient(config, logger), config, logger };
}

export { MockTallyServer };
