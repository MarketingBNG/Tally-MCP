import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerClosingStockTools } from '../../src/tools/closingStock.js';

/**
 * `tally_get_closing_stock`, built 2026-08-14 once a company finally populated
 * the Stock Summary and Godown Summary reports.
 *
 * Written against the ways this could report a plausible wrong figure rather
 * than the happy path: a rounded rate multiplied back into a value, an empty
 * quantity read as zero, a subtotal row stealing the next row's figures, an
 * empty report read as "there is no stock".
 */

let mock: MockTallyServer;
let port: number;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerClosingStockTools(registry.server, makeDeps(port));
  return registry;
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
  mock.onBodyContaining('<ID>Stock Summary</ID>', { body: fixture('stock-summary.xml') });
  mock.onBodyContaining('<ID>Godown Summary</ID>', { body: fixture('godown-summary.xml') });
});

interface StockRow {
  name: string;
  closingQuantity: string | null;
  closingRate: string | null;
  closingValue: { amount: string } | null;
}

async function rowsFor(by: 'item' | 'godown'): Promise<StockRow[]> {
  const result = await callToolOk(build(), 'tally_get_closing_stock', { by });
  return result.rows as StockRow[];
}

describe('tally_get_closing_stock by item', () => {
  it('reads name, quantity, rate and value per item', async () => {
    const rows = await rowsFor('item');
    const first = rows[0];

    expect(first?.name).toBe('Invented Widget 10mm');
    // Quantity keeps its unit: a bare stock number is meaningless.
    expect(first?.closingQuantity).toBe('400.00 Nos');
    expect(first?.closingRate).toBe('2.50');
    expect(first?.closingValue?.amount).toBe('-1004.32');
  });

  /**
   * The reason the description forbids recomputing value from rate. Tally rounds
   * the displayed rate, so the product is wrong by a plausible margin — here
   * 400.00 x 2.50 = 1,000.00 against a reported 1,004.32. The value must be
   * Tally's own figure, passed through untouched.
   */
  it("passes through Tally's value rather than quantity x rate", async () => {
    const rows = await rowsFor('item');
    const first = rows[0];

    expect(first?.closingValue?.amount).toBe('-1004.32');
    expect(first?.closingValue?.amount).not.toBe('-1000.00');
  });

  it('preserves the negative sign on stock held', async () => {
    // Tally encodes debit balances negatively and stock is an asset. Flipping
    // it here would make the figure disagree with what Tally shows on screen.
    const rows = await rowsFor('item');
    expect(rows[0]?.closingValue?.amount.startsWith('-')).toBe(true);
  });

  it('reports an empty quantity as null, not zero', async () => {
    const rows = await rowsFor('item');
    const gasket = rows.find((row) => row.name === 'Invented Gasket');

    expect(gasket?.closingQuantity).toBeNull();
    // The value on the same row is present, so this is a missing field rather
    // than a missing row — null must not be contagious. Note the amount is
    // normalised ("-70.00" in, "-70" out): Money holds a Decimal, so trailing
    // zeros are not significant. The quantity string keeps Tally's formatting
    // because it is passed through rather than parsed.
    expect(gasket?.closingValue?.amount).toBe('-70');
  });

  it('keeps a genuine zero distinguishable from a null', async () => {
    const rows = await rowsFor('item');
    const zero = rows.find((row) => row.name === 'Invented Zero Stock Item');

    expect(zero?.closingValue?.amount).toBe('0');
    expect(zero?.closingValue).not.toBeNull();
  });

  it('reports an unreadable amount as null with a warning, never a salvaged number', async () => {
    const result = await callToolOk(build(), 'tally_get_closing_stock', { by: 'item' });
    const rows = result.rows as StockRow[];
    const bad = rows.find((row) => row.name === 'Invented Unreadable Item');

    expect(bad?.closingValue).toBeNull();
    expect(
      (result.warnings as string[]).some((w) => /Invented Unreadable Item/.test(w))
    ).toBe(true);
  });

  /**
   * The silent failure that positional pairing exists to prevent. A row with a
   * name but no figures block must not absorb the figures of the row after it —
   * that would shift every subsequent row by one and misattribute real numbers
   * to the wrong item, with nothing visibly wrong in the output.
   */
  it('does not let a figureless row consume the next row figures', async () => {
    const rows = await rowsFor('item');
    const subtotalIndex = rows.findIndex((row) => row.name === 'Invented Subtotal Row');
    const subtotal = rows[subtotalIndex];
    const next = rows[subtotalIndex + 1];

    expect(subtotal?.closingQuantity).toBeNull();
    expect(subtotal?.closingValue).toBeNull();

    // The row after it keeps its own identity and its own (unreadable) figures.
    expect(next?.name).toBe('Invented Unreadable Item');
    expect(next?.closingQuantity).toBe('12.00 Kg');
  });

  it('returns every row in the report', async () => {
    const rows = await rowsFor('item');
    expect(rows).toHaveLength(5);
  });

  it('names the basis so the figure can be attributed', async () => {
    // tally_get_stock_items answers the same question from the masters. Saying
    // which basis produced a figure is what stops the two being conflated.
    const result = await callToolOk(build(), 'tally_get_closing_stock', { by: 'item' });
    expect(result.basis).toMatch(/stock summary/i);
    expect(result.groupedBy).toMatch(/stock item/i);
  });
});

describe('tally_get_closing_stock by godown', () => {
  it('fetches the godown report, not the stock report', async () => {
    const rows = await rowsFor('godown');

    expect(rows.map((row) => row.name)).toEqual([
      'Invented Main Store',
      'Invented Overflow Shed',
    ]);
  });

  it('keeps one row per location rather than a single total', async () => {
    const rows = await rowsFor('godown');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.closingValue?.amount).toBe('-750');
    expect(rows[1]?.closingValue?.amount).toBe('-254.32');
  });

  it('labels the grouping as a location', async () => {
    const result = await callToolOk(build(), 'tally_get_closing_stock', { by: 'godown' });
    expect(result.basis).toMatch(/godown summary/i);
    expect(result.groupedBy).toMatch(/godown|location/i);
  });
});

describe('tally_get_closing_stock on a company without inventory', () => {
  /**
   * The empty envelope is what four of the six probed report IDs still return.
   * It means "the company does not use this feature", and the one thing that
   * must never happen is for it to be read as a nil stock position.
   */
  it('explains an empty report instead of implying stock is zero', async () => {
    mock.reset();
    mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
    mock.onBodyContaining('<ID>Stock Summary</ID>', { body: '<ENVELOPE></ENVELOPE>' });

    const result = await callToolOk(build(), 'tally_get_closing_stock', { by: 'item' });

    expect(result.rows).toEqual([]);
    const warnings = (result.warnings as string[]).join(' ');
    expect(warnings).toMatch(/does not maintain inventory/i);
    expect(warnings).toMatch(/does NOT mean stock is zero/i);
  });
});
