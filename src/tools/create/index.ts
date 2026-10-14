import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolDeps } from '../shared/toolResult.js';
import { registerCreateMasterTool } from './master.js';
import { registerCreateVoucherTool } from './voucher.js';
import { registerCreateLedgerTool } from './ledger.js';
import { registerCreateStockJournalTool } from './stockJournal.js';

/** Every tool that creates something in TallyPrime. Each one only previews; tally_confirm_write sends. */
export function registerCreateTools(server: McpServer, deps: ToolDeps): void {
  registerCreateLedgerTool(server, deps);
  registerCreateVoucherTool(server, deps);
  registerCreateMasterTool(server, deps);
  registerCreateStockJournalTool(server, deps);
}
