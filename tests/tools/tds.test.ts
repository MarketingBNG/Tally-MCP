import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerTdsTools } from '../../src/tools/tds.js';

/**
 * The TDS/TCS tools.
 *
 * The point every test here defends: Tally stamps the TDS flags onto EVERY
 * ledger as explicit negatives, including at companies that have never deducted
 * tax. So the failure mode is not "no data" — it is reporting all 330 ledgers
 * as TDS-configured because the field was present. Presence is not evidence;
 * an affirmative value is.
 */

let mock: MockTallyServer;
let port: number;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerTdsTools(registry.server, makeDeps(port));
  return registry;
}

function serveTdsLedgers(): void {
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
  mock.onBodyContaining('<ID>Groups</ID>', { body: fixture('groups-common.xml') });
  mock.onBodyContaining('<FETCH>*</FETCH>', { body: fixture('ledger-list-tds.xml') });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list-tds.xml') });
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
  serveTdsLedgers();
});

interface SummaryShape {
  ledgersExamined: number;
  counts: Record<string, number>;
  taxLedgers: { name: string }[];
  deducteeLedgers: { name: string; tdsFields: Record<string, string> }[];
  expenseLedgers: { name: string }[];
  specialRateLedgers: { name: string; tdsFields: Record<string, string> }[];
  ignoringExemptionLimit: { name: string }[];
  warnings?: string[];
}

describe('tally_get_tds summary', () => {
  it('counts only ledgers with an affirmative flag, not every ledger carrying the field', async () => {
    // The whole test. All four fixture ledgers carry ISTDSAPPLICABLE; exactly
    // one says Yes. A presence check would report four.
    const result = (await callToolOk(build(), 'tally_get_tds', {
      view: 'summary',
    })) as unknown as SummaryShape;

    expect(result.ledgersExamined).toBe(4);
    expect(result.counts.deducteeLedgers).toBe(1);
    expect(result.deducteeLedgers[0]?.name).toBe('Kulkarni Consulting');
  });

  it('finds the tax ledger by its TAXTYPE, not by hoping the name says TDS', async () => {
    const result = (await callToolOk(build(), 'tally_get_tds', {
      view: 'summary',
    })) as unknown as SummaryShape;

    expect(result.taxLedgers.map((l) => l.name)).toEqual(['TDS on Professional Charges']);
  });

  it('separates the expense ledger from the deductee party', async () => {
    // Different questions: which expense attracts TDS, versus whom tax is
    // deducted from. Collapsing them would misreport both.
    const result = (await callToolOk(build(), 'tally_get_tds', {
      view: 'summary',
    })) as unknown as SummaryShape;

    expect(result.expenseLedgers.map((l) => l.name)).toEqual(['Professional Fees']);
    expect(result.deducteeLedgers.map((l) => l.name)).toEqual(['Kulkarni Consulting']);
  });

  it('surfaces a special deduction rate and says why it matters', async () => {
    // Normally the 206AA no-PAN rate. A reviewer must see it, because the flag
    // records a decision without recording whether the decision was right.
    const result = (await callToolOk(build(), 'tally_get_tds', {
      view: 'summary',
    })) as unknown as SummaryShape;

    expect(result.specialRateLedgers.map((l) => l.name)).toEqual(['Kulkarni Consulting']);
    expect(result.specialRateLedgers[0]?.tdsFields.TDSDEDUCTEESPECIALRATE).toBe('20');
    expect(result.warnings?.join(' ')).toContain('206AA');
  });

  it('flags a ledger set to ignore the exemption limit', async () => {
    const result = (await callToolOk(build(), 'tally_get_tds', {
      view: 'summary',
    })) as unknown as SummaryShape;

    expect(result.ignoringExemptionLimit.map((l) => l.name)).toEqual(['Professional Fees']);
    expect(result.warnings?.join(' ')).toContain('exemption');
  });

  it('drops the explicit negatives from the reported fields', async () => {
    // "ISTCSAPPLICABLE: No" on a TDS party is noise, and enough of it buries
    // the two fields that carry the finding.
    const result = (await callToolOk(build(), 'tally_get_tds', {
      view: 'summary',
    })) as unknown as SummaryShape;

    const fields = result.deducteeLedgers[0]?.tdsFields ?? {};
    expect(fields.ISTDSAPPLICABLE).toBe('Yes');
    expect(fields).not.toHaveProperty('ISTCSAPPLICABLE');
    expect(fields).not.toHaveProperty('TDSDEDUCTEESPECIALRATE0');
  });

  it('reports an unconfigured company as a finding rather than a failure', async () => {
    mock.reset();
    mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
    mock.onBodyContaining('<ID>Groups</ID>', { body: fixture('groups-common.xml') });
    mock.onBodyContaining('<FETCH>*</FETCH>', { body: fixture('ledger-list-allfields.xml') });
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list-allfields.xml') });

    const result = (await callToolOk(build(), 'tally_get_tds', {
      view: 'summary',
    })) as unknown as SummaryShape;

    expect(result.counts.deducteeLedgers).toBe(0);
    expect(result.warnings?.join(' ')).toContain('positive finding');
  });
});
