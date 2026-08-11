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
}

/** A stand-in for McpServer that records registrations instead of serving them. */
export function createToolRegistry(): ToolRegistry {
  const handlers = new Map<string, ToolHandler>();
  const schemas = new Map<string, { parse: (value: unknown) => unknown } | undefined>();

  const server = {
    registerTool(
      name: string,
      config: { inputSchema?: { parse: (value: unknown) => unknown } },
      handler: ToolHandler
    ) {
      handlers.set(name, handler);
      schemas.set(name, config.inputSchema);
      return { name };
    },
    registerResource() {
      return { name: 'resource' };
    },
  } as unknown as McpServer;

  return { server, handlers, schemas };
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

/** Call a tool and assert it succeeded, returning the parsed payload. */
export async function callToolOk(
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
