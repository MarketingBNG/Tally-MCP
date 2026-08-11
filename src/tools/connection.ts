import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TallyClient } from '../tally/TallyClient.js';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import { TallyError } from '../tally/TallyError.js';
import { buildConnectionProbeRequest } from '../tally/requests.js';
import { READ_ONLY_NOTICE } from '../schemas/common.js';

/**
 * Connectivity check.
 *
 * This tool is implementable without ground-truth samples because it asks
 * only "did TallyPrime answer?", never "what did it say?". It deliberately
 * does not parse the payload beyond measuring it.
 */

export interface ConnectionStatusResult {
  connected: boolean;
  endpoint: string;
  /** Round-trip time for the probe, in milliseconds. */
  responseTimeMs?: number;
  /** Wire format Tally actually replied in, once known. */
  responseFormat?: 'json' | 'xml';
  /** Encoding detected from the response bytes. */
  encoding?: string;
  /** Malformations repaired while reading the response, if any. */
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    suggestion: string;
  };
}

const DESCRIPTION = [
  'Check whether TallyPrime is running and reachable over its HTTP interface.',
  '',
  'WHEN TO USE: as a first step when any other Tally tool fails, or to confirm setup ' +
    'before starting an analysis. Cheap and safe to call at any time.',
  '',
  'RETURNS: whether the connection succeeded, the endpoint tried, round-trip time, ' +
    'the wire format and character encoding TallyPrime replied with, and — on failure — ' +
    'a stable error code with a specific suggestion for fixing it.',
  '',
  'DOES NOT RETURN: any accounting data. It does not read ledgers, vouchers or reports, ' +
    'and does not tell you which company is loaded — use tally_list_companies for that.',
  '',
  'PAGINATION: not applicable.',
  '',
  READ_ONLY_NOTICE,
].join('\n');

export function registerConnectionTools(
  server: McpServer,
  deps: { client: TallyClient; config: AppConfig; logger: Logger }
): void {
  server.registerTool(
    'tally_connection_status',
    {
      description: DESCRIPTION,
      inputSchema: z.object({}),
    },
    async () => {
      const result = await checkConnection(deps);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        // A failed connectivity probe is a real tool failure, so flag it —
        // but the payload is still structured, never a stack trace.
        ...(result.connected ? {} : { isError: true }),
      };
    }
  );
}

export async function checkConnection(deps: {
  client: TallyClient;
  config: AppConfig;
  logger: Logger;
}): Promise<ConnectionStatusResult> {
  const { client, config, logger } = deps;
  const startedAt = Date.now();

  try {
    const response = await client.send(buildConnectionProbeRequest(), 'standard');
    const elapsed = Date.now() - startedAt;

    logger.info('connection probe succeeded', {
      elapsedMs: elapsed,
      encoding: response.encoding,
    });

    return {
      connected: true,
      endpoint: config.tallyBaseUrl,
      responseTimeMs: elapsed,
      responseFormat: response.isJson ? 'json' : 'xml',
      encoding: response.encoding,
      ...(response.repairs.length > 0 ? { warnings: response.repairs } : {}),
    };
  } catch (error) {
    const tallyError = TallyError.from(error, 'Could not reach TallyPrime.');

    // Log the full detail locally; return only the sanitised payload.
    logger.error('connection probe failed', {
      code: tallyError.code,
      message: tallyError.message,
    });

    return {
      connected: false,
      endpoint: config.tallyBaseUrl,
      error: tallyError.toClientPayload().error,
    };
  }
}
