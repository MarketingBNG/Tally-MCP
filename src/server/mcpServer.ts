import { McpServer } from '@modelcontextprotocol/server';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import { TallyClient } from '../tally/TallyClient.js';
import { registerConnectionTools } from '../tools/read/connection.js';
import { checkConnection } from '../tools/read/connection.js';
import { registerCompanyTools } from '../tools/read/companies.js';
import { registerMasterTools } from '../tools/read/masters.js';
import { registerVoucherTestTools } from '../tools/read/testVouchers.js';
import { registerGenericReportTools } from '../tools/read/genericReport.js';
import { registerLedgerTransactionTools } from '../tools/read/ledgerTransactions.js';
import { registerReportTools } from '../tools/read/reports.js';
import { registerVoucherTools } from '../tools/read/vouchers.js';
import { registerBankReconciliationTools } from '../tools/read/bankReconciliation.js';
import { registerInventoryTools } from '../tools/read/inventory.js';
import { registerClosingStockTools } from '../tools/read/closingStock.js';
import { registerOutstandingTools } from '../tools/read/outstanding.js';
import { registerGstTools } from '../tools/read/gst.js';
import { registerTdsTools } from '../tools/read/tds.js';
import { registerWorkpaperTools } from '../tools/read/workpaper.js';
import { registerPartyMatchingTools } from '../tools/read/partyMatching.js';
import { registerFixedAssetTools } from '../tools/read/fixedAssets.js';
import { registerConfirmationTools } from '../tools/read/confirmations.js';
import { registerSearchTools } from '../tools/read/search.js';
import { registerPartyStatementTools } from '../tools/read/partyStatement.js';
import { registerTieOutTools } from '../tools/read/tieOut.js';
import { registerMaterialityTools } from '../tools/read/materiality.js';
import { registerSummaryTools } from '../tools/read/summarise.js';
import { registerExportedBookTools } from '../tools/read/exportedBooks.js';
import { registerCreateTools } from '../tools/create/index.js';
import { registerAlterTools } from '../tools/alter/index.js';
import { registerCancelTools } from '../tools/cancel/index.js';
import { registerDeleteTools } from '../tools/delete/index.js';
import { registerConfirmTools } from '../tools/confirm/register.js';
import { registerPrompts } from './prompts.js';
import { serializeToolPayload } from '../tools/shared/toolResult.js';
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
  // Reads the exported files on this machine, so it works with TallyPrime closed
  // and without Google Drive. Registered first among the data tools because it
  // is the fallback when Tally cannot be reached.
  registerExportedBookTools(server, toolDeps);
  registerCompanyTools(server, toolDeps);
  registerMasterTools(server, toolDeps);
  registerLedgerTransactionTools(server, toolDeps);
  registerReportTools(server, toolDeps);
  registerVoucherTools(server, toolDeps);
  registerSummaryTools(server, toolDeps);
  registerBankReconciliationTools(server, toolDeps);
  registerInventoryTools(server, toolDeps);
  registerClosingStockTools(server, toolDeps);
  registerOutstandingTools(server, toolDeps);
  registerGstTools(server, toolDeps);
  registerTdsTools(server, toolDeps);
  registerSearchTools(server, toolDeps);
  registerPartyStatementTools(server, toolDeps);
  registerTieOutTools(server, toolDeps);
  registerMaterialityTools(server, toolDeps);
  registerVoucherTestTools(server, toolDeps);
  registerWorkpaperTools(server, toolDeps);
  registerPartyMatchingTools(server, toolDeps);
  registerFixedAssetTools(server, toolDeps);
  registerConfirmationTools(server, toolDeps);
  registerGenericReportTools(server, toolDeps);

  // Write tools, one folder per kind of change (src/tools/create, alter, cancel, delete).
  // Each only PREVIEWS; nothing reaches TallyPrime until tally_confirm_write.
  registerCreateTools(server, toolDeps);
  registerAlterTools(server, toolDeps);
  registerCancelTools(server, toolDeps);
  registerDeleteTools(server, toolDeps);
  registerConfirmTools(server, toolDeps);

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
