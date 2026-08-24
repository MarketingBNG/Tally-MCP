import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerFixedAssetTools } from '../../src/tools/fixedAssets.js';

/**
 * The fixed asset movement schedule.
 *
 * The control under test is the tie-out: opening plus additions less disposals
 * against the closing balance, where the two sides come from different places —
 * the balances from the ledger masters, the movements from the voucher entries.
 * A tool that silently made those agree would destroy the only evidence the
 * schedule produces, so the untied row and the unreadable balance are tested as
 * carefully as the row that works.
 */

let mock: MockTallyServer;
let port: number;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerFixedAssetTools(registry.server, makeDeps(port));
  return registry;
}

const PERIOD = { fromDate: '2026-07-01', toDate: '2026-07-31' };

interface Row {
  ledger: string;
  additions: string;
  disposals: string;
  ties: boolean | null;
  difference: string | null;
  additionVouchers: { voucherNumber: string }[];
  disposalVouchers: { voucherNumber: string }[];
}

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Groups</ID>', { body: fixture('groups-common.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list-fixedassets.xml') });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('vouchers-fixedassets.xml') });
});

async function schedule(args: Record<string, unknown> = {}): Promise<Row[]> {
  const result = await callToolOk(build(), 'tally_get_fixed_assets', { ...PERIOD, ...args });
  return result.schedule as Row[];
}

describe('the movement schedule', () => {
  it('reads an addition from the debit side and ties it to the closing balance', async () => {
    // 100,000 opening + 50,000 bought = 150,000 closing.
    const laptop = (await schedule()).find((row) => row.ledger === 'Laptop');
    expect(laptop?.additions).toBe('50000');
    expect(laptop?.disposals).toBe('0');
    expect(laptop?.ties).toBe(true);
    expect(laptop?.additionVouchers.map((v) => v.voucherNumber)).toEqual(['FA-1']);
  });

  it('reads a disposal from the credit side', async () => {
    // 500,000 opening − 100,000 sold = 400,000 closing.
    const car = (await schedule()).find((row) => row.ledger === 'Car');
    expect(car?.disposals).toBe('100000');
    expect(car?.additions).toBe('0');
    expect(car?.ties).toBe(true);
    expect(car?.disposalVouchers.map((v) => v.voucherNumber)).toEqual(['FA-2']);
  });

  it('reports a row that does not tie, with the size of the gap', async () => {
    // The whole point of the schedule. A balance that moved with no voucher to
    // explain it is the finding, and it must not be smoothed over.
    const plant = (await schedule()).find((row) => row.ledger === 'Untied Plant');
    expect(plant?.ties).toBe(false);
    expect(plant?.difference).toBe('89999');
  });

  it('does not attempt a tie-out when a balance is unreadable', async () => {
    // Null, not false and not zero. Defaulting the missing closing balance to
    // zero would make this row look like a large unexplained disposal.
    const missing = (await schedule()).find((row) => row.ledger === 'No Balance Asset');
    expect(missing?.ties).toBeNull();
    expect(missing?.difference).toBeNull();
  });

  it('counts the untied rows and says what usually causes it', async () => {
    const result = await callToolOk(build(), 'tally_get_fixed_assets', PERIOD);
    expect(result.ledgersNotTying).toBe(1);
    expect((result.warnings as string[]).join(' ')).toContain('do NOT tie');
  });

  it('leaves non-asset ledgers out of the schedule', async () => {
    const names = (await schedule()).map((row) => row.ledger);
    expect(names).not.toContain('Bank');
    expect(names).not.toContain('Accumulated Depreciation');
  });
});

describe('depreciation', () => {
  it('reports what was charged and never recomputes it', async () => {
    const result = await callToolOk(build(), 'tally_get_fixed_assets', PERIOD);
    const depreciation = result.depreciation as { totalCharged: string; entries: unknown[] };

    expect(depreciation.totalCharged).toBe('25000');
    expect(depreciation.entries).toHaveLength(1);
    // No rate, no life, no recomputed figure anywhere in the payload.
    expect(JSON.stringify(result)).not.toContain('Schedule II rate applied');
  });

  it('discloses that depreciation ledgers are found by name, which is weak', async () => {
    const result = await callToolOk(build(), 'tally_get_fixed_assets', {
      ...PERIOD,
      depreciationHints: ['nothing-matches-this'],
    });
    const depreciation = result.depreciation as { totalCharged: string };

    expect(depreciation.totalCharged).toBe('0');
    expect((result.warnings as string[]).join(' ')).toContain('identified by');
  });

  it('says plainly that this is not a fixed asset register', async () => {
    // A reader who takes a ledger balance for an asset's cost will misstate
    // both the gross block and the depreciation on it.
    const result = await callToolOk(build(), 'tally_get_fixed_assets', PERIOD);
    expect(String(result.notARegister)).toContain('NOT A FIXED ASSET REGISTER');
  });
});

describe('when the groups are wrong', () => {
  it('returns an empty schedule with a warning, not an error', async () => {
    const result = await callToolOk(build(), 'tally_get_fixed_assets', {
      ...PERIOD,
      assetGroups: ['Tangible Assets'],
    });

    expect(result.schedule).toEqual([]);
    expect((result.warnings as string[]).join(' ')).toContain('groups them under a different name');
  });
});
