import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolDeps } from '../shared/toolResult.js';
import { registerCancelVoucherTool } from './voucher.js';

/** Every tool that cancels something in TallyPrime. Each one only previews; tally_confirm_write sends. */
export function registerCancelTools(server: McpServer, deps: ToolDeps): void {
  registerCancelVoucherTool(server, deps);
}
