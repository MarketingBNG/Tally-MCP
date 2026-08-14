import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockTallyServer, callToolOk, createToolRegistry, makeDeps } from './harness.js';
import { registerCompanyTools } from '../../src/tools/companies.js';

/**
 * A5: a CAPPED distinct-value count was reported as if it were a total.
 *
 * `tally_get_company` stops collecting distinct values per field at 25, which is
 * sound — anything above one already means "this field varies", so retaining
 * every GUID buys nothing. But the capped figure was then emitted as
 * `distinctValues: 25`. Measured live on a company with 330 ledgers, GUID and
 * ALTERID both reported `distinctValues: 25` when the true count for each is 330.
 *
 * A number that is wrong by an order of magnitude is still a wrong number, and
 * the accuracy rule for this server has no exemption for being only somewhat
 * wrong. So a capped count is reported as `atLeast`, which cannot be read as
 * exact, while an uncapped one keeps `distinctValues`.
 */

let mock: MockTallyServer;
let port: number;

/** A ledger list where GUID is unique per ledger and PARENT is shared. */
function ledgersWithDistinctGuids(count: number): string {
  const ledgers = Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return [
      `<LEDGER NAME="Ledger ${n}">`,
      `<NAME>Ledger ${n}</NAME>`,
      `<GUID>guid-${n}</GUID>`,
      '<PARENT>Sundry Debtors</PARENT>',
      // Constant across every ledger, so it must be folded into uniformFields
      // rather than counted as varying — the control for this test. PARENT would
      // not do: the normaliser maps it to a top-level property, so it never
      // reaches the open `fields` map this folding operates on.
      '<ISBILLWISEON>No</ISBILLWISEON>',
      '</LEDGER>',
    ].join('');
  }).join('');

  return `<ENVELOPE><BODY><DATA><COLLECTION>${ledgers}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

const COMPANY = [
  '<ENVELOPE><BODY><DATA><COLLECTION>',
  '<COMPANY NAME="CAP TEST LIMITED">',
  '<ENDINGAT TYPE="Date">20270331</ENDINGAT>',
  '<STARTINGFROM TYPE="Date">20260401</STARTINGFROM>',
  '<NAME TYPE="String">CAP TEST LIMITED</NAME>',
  '</COMPANY>',
  '</COLLECTION></DATA></BODY></ENVELOPE>',
].join('');

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: COMPANY });
});

function build() {
  const registry = createToolRegistry();
  registerCompanyTools(registry.server, makeDeps(port));
  return registry;
}

type FieldStat = { ledgers: number; distinctValues?: number; atLeast?: number };

describe('distinct-value counting is honest about its own cap', () => {
  it('reports a lower bound, not an exact figure, once the cap is reached', async () => {
    // 30 ledgers, each with its own GUID: past the cap of 25.
    mock.onBodyContaining('<FETCH>*</FETCH>', { body: ledgersWithDistinctGuids(30) });

    const result = await callToolOk(build(), 'tally_get_company');
    const fields = result.distinguishingFields as Record<string, FieldStat>;

    expect(fields.GUID?.ledgers).toBe(30);
    // The fix: a bound, clearly labelled.
    expect(fields.GUID?.atLeast).toBe(25);
    // The bug: an exact-looking 25 where the truth is 30.
    expect(fields.GUID?.distinctValues).toBeUndefined();
  });

  it('still reports an exact count when the field stays under the cap', async () => {
    // 5 ledgers: the count is genuinely known, so it must not be hedged. A fix
    // that labelled everything "atLeast" would lose real information.
    mock.onBodyContaining('<FETCH>*</FETCH>', { body: ledgersWithDistinctGuids(5) });

    const result = await callToolOk(build(), 'tally_get_company');
    const fields = result.distinguishingFields as Record<string, FieldStat>;

    expect(fields.GUID?.distinctValues).toBe(5);
    expect(fields.GUID?.atLeast).toBeUndefined();
  });

  it('leaves a field with one value out of the varying list entirely', async () => {
    // ISBILLWISEON is identical on every ledger, so it is a TallyPrime default
    // rather than something this company recorded — it belongs in uniformFields.
    mock.onBodyContaining('<FETCH>*</FETCH>', { body: ledgersWithDistinctGuids(30) });

    const result = await callToolOk(build(), 'tally_get_company');
    const fields = result.distinguishingFields as Record<string, FieldStat>;

    expect(fields.ISBILLWISEON).toBeUndefined();
    expect(result.uniformFields).toMatchObject({ ISBILLWISEON: 'No' });
  });
});
