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

  /*
   * Say something on the way out, whatever the way out was.
   *
   * Every other exit path here logs: a config failure, an uncaught exception, a
   * signal. What did NOT log was the ordinary one — the process simply ending —
   * and that turned out to be the case that actually happens. Twice on
   * 2026-08-22 the Desktop log showed only "Server transport closed
   * unexpectedly, this is likely due to the process exiting early", with nothing
   * from this process at all, which is indistinguishable from a crash. It was
   * neither: a GPU hang took Claude Desktop down and this process went with its
   * parent, both times while idle with no tool call in flight.
   *
   * Diagnosing that took Windows event logs, because the one thing the server
   * could have said — "my input closed, so I am done" — it never said. An exit
   * code and a reason cost nothing and make the difference between a five-minute
   * answer and an afternoon of guessing.
   *
   * `exit` handlers must be synchronous: the loop is already draining, so the
   * logger's write is the last thing that can happen.
   */
  let stdinEnded = false;
  process.stdin.on('end', () => {
    stdinEnded = true;
  });
  process.on('exit', (code) => {
    logger.info('exiting', {
      code,
      // Which of the two it was. Desktop closes stdin when it shuts a server
      // down deliberately; a parent that dies takes this process with it and
      // never gets that far.
      reason: stdinEnded ? 'input stream closed' : 'process ended without input close',
    });
  });
}

await main();
