import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolDeps } from '../shared/toolResult.js';
import { registerDeleteMasterTool } from './master.js';
import { registerDeleteVoucherTool } from './voucher.js';
import { registerDeleteLedgerTool } from './ledger.js';

/** Every tool that deletes something in TallyPrime. Each one only previews; tally_confirm_write sends. */
export function registerDeleteTools(server: McpServer, deps: ToolDeps): void {
  registerDeleteLedgerTool(server, deps);
  registerDeleteVoucherTool(server, deps);
  registerDeleteMasterTool(server, deps);
}
