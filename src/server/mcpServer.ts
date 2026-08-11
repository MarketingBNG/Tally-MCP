import { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import { TallyClient } from '../tally/TallyClient.js';
import { registerConnectionTools } from '../tools/connection.js';
import { checkConnection } from '../tools/connection.js';
import { registerCompanyTools } from '../tools/companies.js';
import { registerLedgerTools } from '../tools/ledgers.js';
import { registerLedgerTransactionTools } from '../tools/ledgerTransactions.js';
import { registerReportTools } from '../tools/reports.js';
import { registerVoucherTools } from '../tools/vouchers.js';
import { registerTradingTools } from '../tools/trading.js';
import { registerInventoryTools } from '../tools/inventory.js';
import { registerOutstandingTools } from '../tools/outstanding.js';
import { registerGstTools } from '../tools/gst.js';
import { registerFlowReportTools } from '../tools/flowReports.js';
import { registerSearchTools } from '../tools/search.js';
import { registerPrompts } from './prompts.js';
import { buildCompanyListRequest } from '../tally/requests.js';
import { normalizeCompanies } from '../tally/normalize.js';
import { TallyError } from '../tally/TallyError.js';

/**
 * MCP server assembly.
 *
 * One TallyClient is shared by every tool, so all outbound traffic passes
 * through a single request queue — which is what keeps concurrent tool calls
 * from overlapping at Tally's single-threaded HTTP listener.
 */

export interface ServerDeps {
  config: AppConfig;
  logger: Logger;
  client?: TallyClient;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const { config, logger } = deps;
  const client = deps.client ?? new TallyClient(config, logger);

  const server = new McpServer({
    name: 'tally-mcp',
    version: '0.1.0',
  });

  // One client, so every tool shares the single request queue.
  const toolDeps = { client, config, logger };

  registerConnectionTools(server, toolDeps);
  registerCompanyTools(server, toolDeps);
  registerLedgerTools(server, toolDeps);
  registerLedgerTransactionTools(server, toolDeps);
  registerReportTools(server, toolDeps);
  registerVoucherTools(server, toolDeps);
  registerTradingTools(server, toolDeps);
  registerInventoryTools(server, toolDeps);
  registerOutstandingTools(server, toolDeps);
  registerGstTools(server, toolDeps);
  registerFlowReportTools(server, toolDeps);
  registerSearchTools(server, toolDeps);

  registerResources(server, toolDeps);
  registerPrompts(server);

  logger.info('MCP server constructed', {
    endpoint: config.tallyBaseUrl,
    preferredFormat: config.tallyPreferredFormat,
  });

  return server;
}

/**
 * Resources.
 *
 * Two only: connection status and the loaded company. Resources deliberately
 * do not mirror every tool — these two are the ambient context a client
 * benefits from having without asking, and everything else is a question with
 * parameters, which is what tools are for.
 */
function registerResources(
  server: McpServer,
  deps: { client: TallyClient; config: AppConfig; logger: Logger }
): void {
  server.registerResource(
    'connection-status',
    'tally://connection',
    {
      title: 'TallyPrime connection status',
      description:
        'Whether the server can currently reach TallyPrime, including the endpoint and, on failure, a diagnostic error code.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const status = await checkConnection(deps);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'loaded-company',
    'tally://company',
    {
      title: 'Loaded TallyPrime company',
      description:
        'The company TallyPrime currently has open, with the date its books begin. Tally serves ' +
        'one company at a time, so this is the company every query will read from.',
      mimeType: 'application/json',
    },
    async (uri) => {
      // Deliberately the cheap company-list request rather than the full
      // profile: a resource is ambient context a client may read
      // speculatively, and it should never trigger a multi-megabyte fetch.
      let body: unknown;
      try {
        const response = await deps.client.send(buildCompanyListRequest(), 'standard');
        const { data, warnings } = normalizeCompanies(response.body);
        body = {
          loadedCompany: data[0] ?? null,
          ...(data.length > 1 ? { alsoReported: data.slice(1) } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      } catch (error) {
        // A resource read must not throw a raw error across the boundary;
        // an unreachable Tally is ordinary here, not exceptional.
        body = TallyError.from(error, 'Could not read the loaded company.').toClientPayload();
      }

      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) },
        ],
      };
    }
  );
}
