#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, ConfigError } from './config/config.js';
import { createLogger } from './utils/logger.js';
import { createMcpServer } from './server/mcpServer.js';

/**
 * Entry point.
 *
 * Claude Desktop launches this process and speaks MCP over stdio. That makes
 * stdout the protocol channel: every diagnostic here goes to stderr, and
 * nothing may write to stdout except the transport itself.
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Configuration failures happen before a logger exists, and before the
    // transport is connected — stderr directly is the only safe channel.
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`tally-mcp: startup failed.\n${message}\n`);
    process.exit(1);
  }

  const logger = createLogger(config.logLevel, { service: 'tally-mcp' });

  // Surface late failures on stderr rather than dying silently, which under
  // Claude Desktop would otherwise appear as an unexplained disconnect.
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { message: error.message });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { reason: String(reason) });
    process.exit(1);
  });

  const server = createMcpServer({ config, logger });
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info('tally-mcp ready', {
    endpoint: config.tallyBaseUrl,
    transport: 'stdio',
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

await main();
