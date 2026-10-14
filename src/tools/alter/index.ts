import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolDeps } from '../shared/toolResult.js';
import { registerAlterMasterTool } from './master.js';
import { registerAlterVoucherTool } from './voucher.js';
import { registerAlterLedgerTool } from './ledger.js';

/** Every tool that alters something in TallyPrime. Each one only previews; tally_confirm_write sends. */
export function registerAlterTools(server: McpServer, deps: ToolDeps): void {
  registerAlterLedgerTool(server, deps);
  registerAlterVoucherTool(server, deps);
  registerAlterMasterTool(server, deps);
}
