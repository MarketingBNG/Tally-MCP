import { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import { TallyClient } from '../tally/TallyClient.js';
import { registerConnectionTools } from '../tools/connection.js';
import { checkConnection } from '../tools/connection.js';
import { registerCompanyTools } from '../tools/companies.js';
import { registerLedgerTools } from '../tools/ledgers.js';
import { registerGroupTools } from '../tools/groups.js';
import { registerLedgerTransactionTools } from '../tools/ledgerTransactions.js';
import { registerReportTools } from '../tools/reports.js';
import { registerVoucherTools } from '../tools/vouchers.js';
import { registerVoucherTypeTools } from '../tools/voucherTypes.js';
import { registerBankReconciliationTools } from '../tools/bankReconciliation.js';
import { registerInventoryTools } from '../tools/inventory.js';
import { registerOutstandingTools } from '../tools/outstanding.js';
import { registerGstTools } from '../tools/gst.js';
import { registerSearchTools } from '../tools/search.js';
import { registerPartyStatementTools } from '../tools/partyStatement.js';
import { registerTieOutTools } from '../tools/tieOut.js';
import { registerMaterialityTools } from '../tools/materiality.js';
import { registerSummaryTools } from '../tools/summarise.js';
import { registerPrompts } from './prompts.js';
import { serializeToolPayload } from '../tools/toolResult.js';
import { buildCompanyListRequest } from '../tally/requests.js';
import { normalizeCompanies } from '../tally/normalize.js';
import { TallyError } from '../tally/TallyError.js';
import { SERVER_VERSION } from '../version.js';

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
    version: SERVER_VERSION,
  });

  // One client, so every tool shares the single request queue.
  const toolDeps = { client, config, logger };

  registerConnectionTools(server, toolDeps);
  registerCompanyTools(server, toolDeps);
  registerLedgerTools(server, toolDeps);
  registerGroupTools(server, toolDeps);
  registerLedgerTransactionTools(server, toolDeps);
  registerReportTools(server, toolDeps);
  registerVoucherTools(server, toolDeps);
  registerSummaryTools(server, toolDeps);
  registerVoucherTypeTools(server, toolDeps);
  registerBankReconciliationTools(server, toolDeps);
  registerInventoryTools(server, toolDeps);
  registerOutstandingTools(server, toolDeps);
  registerGstTools(server, toolDeps);
  registerSearchTools(server, toolDeps);
  registerPartyStatementTools(server, toolDeps);
  registerTieOutTools(server, toolDeps);
  registerMaterialityTools(server, toolDeps);

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
            text: serializeToolPayload(status),
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
          { uri: uri.href, mimeType: 'application/json', text: serializeToolPayload(body) },
        ],
      };
    }
  );
}
