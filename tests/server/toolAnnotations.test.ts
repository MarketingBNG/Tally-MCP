import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../../src/server/mcpServer.js';
import { loadConfig } from '../../src/config/config.js';
import { makeDeps } from '../tools/harness.js';

/** Claude files tools under read-only or write/delete by these hints. */
describe('tool annotations', () => {
  const { config, logger } = makeDeps(1);
  const server = createMcpServer({ config: config ?? loadConfig({}), logger });
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { annotations?: Record<string, boolean> }>;
    }
  )._registeredTools;

  it('marks every read tool read-only', () => {
    const reads = Object.keys(tools).filter(
      (name) => !/^tally_(create|alter|cancel|delete|confirm)_/.test(name)
    );
    expect(reads.length).toBeGreaterThan(20);
    for (const name of reads) expect(tools[name]?.annotations?.readOnlyHint, name).toBe(true);
  });

  it('marks every write tool as not read-only, and alter/cancel/delete/confirm as destructive', () => {
    for (const name of [
      'tally_create_voucher',
      'tally_alter_voucher',
      'tally_cancel_voucher',
      'tally_delete_ledger',
      'tally_confirm_write',
    ]) {
      expect(tools[name]?.annotations?.readOnlyHint, name).toBe(false);
    }
    expect(tools.tally_create_ledger?.annotations?.destructiveHint).toBe(false);
    expect(tools.tally_delete_voucher?.annotations?.destructiveHint).toBe(true);
    expect(tools.tally_confirm_write?.annotations?.destructiveHint).toBe(true);
    expect(tools.tally_list_write_log?.annotations?.readOnlyHint).toBe(true);
  });
});
