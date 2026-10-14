import type { McpServer } from '@modelcontextprotocol/server';

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * MCP tool annotations, decided by tool name in one place.
 *
 * Claude groups a connector's tools by these hints in its permission settings
 * (read-only vs write/delete). Without them every tool lands in "Other tools",
 * and a user cannot block all writes in one click.
 */
export function annotationsFor(name: string): ToolAnnotations {
  if (name === 'tally_confirm_write') {
    // The one tool that actually sends a change to TallyPrime.
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
  }
  if (/^tally_(delete|cancel|alter)_/.test(name)) {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
  }
  if (/^tally_create_/.test(name)) {
    return {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    };
  }
  return { readOnlyHint: true, openWorldHint: false };
}

/** Make every registerTool call on this server carry its annotations. */
export function annotateTools(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
    name: unknown,
    config: unknown,
    callback: unknown
  ) => {
    const settings = config as { annotations?: ToolAnnotations };
    return register(
      name,
      { ...settings, annotations: { ...annotationsFor(String(name)), ...settings.annotations } },
      callback
    );
  };
}
