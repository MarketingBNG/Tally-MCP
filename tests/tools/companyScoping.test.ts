import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerCompanyTools } from '../../src/tools/companies.js';

/**
 * `tally_get_company` must scope its ledger fetch to the company it was asked
 * about.
 *
 * THE BUG. The handler resolved the named company correctly out of the company
 * list, then built its ledger request with no `company` at all — while the
 * `includeFeatures` stock request eighty lines below it passed one. So the most
 * expensive call in the server, whose entire output describes a company, read
 * ledgers from whichever company TallyPrime happened to have current.
 *
 * That is wrong on its own. What made it undetectable is the second half: an
 * unscoped request omits `<SVCURRENTCOMPANY>` entirely, so the request body is
 * BYTE-IDENTICAL whichever company was named — and `TallyClient` keys its
 * response cache on the request body. Asking about a second company therefore
 * returned the first company's ledgers out of memory: same ledger count, same
 * GUIDs, no second request, no warning, no error. Caught in review only by
 * cross-checking against `tally_get_masters`, and a review that did not
 * cross-check would have carried a false ledger count into an audit file.
 *
 * Both halves are pinned below, and the cache is left ON here precisely because
 * switching it off would hide the failure this is written to catch.
 */

let mock: MockTallyServer;
let port: number;

const FIRST = 'AgEx Pharma LLC';
const SECOND = 'AGBV Nutrition GmbH';

const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${FIRST}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">${FIRST}</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
  <COMPANY NAME="${SECOND}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20230101</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260731</ENDINGAT>
    <NAME TYPE="String">${SECOND}</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">Germany</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

/** A ledger collection of `count` ledgers, named so the two are distinguishable. */
function ledgerList(prefix: string, count: number): string {
  const ledgers = Array.from(
    { length: count },
    (_, index) =>
      `<LEDGER NAME="${prefix} ${String(index)}">` +
      `<NAME TYPE="String">${prefix} ${String(index)}</NAME>` +
      `<PARENT TYPE="String">Sundry Debtors</PARENT>` +
      `</LEDGER>`
  ).join('');
  return `<ENVELOPE><BODY><DATA><COLLECTION>${ledgers}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

function build(): ToolRegistry {
  const registry = createToolRegistry();
  // Cache left at its default TTL on purpose — see the header comment.
  registerCompanyTools(registry.server, makeDeps(port));
  return registry;
}

/** Ledger requests only; the company-list probe is deliberately unscoped. */
function ledgerRequests(): string[] {
  return mock.requests
    .map((request) => request.body)
    .filter((body) => body.includes('<ID>Ledgers</ID>'));
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
  mock.onBodyContaining('List of Companies', { body: COMPANY_LIST });
});

describe('tally_get_company scopes its ledger fetch to the named company', () => {
  it('sends SVCURRENTCOMPANY on the ledger request', async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: ledgerList('AGEX', 3) });

    await callToolOk(build(), 'tally_get_company', { company: FIRST });

    const sent = ledgerRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`<SVCURRENTCOMPANY>${FIRST}</SVCURRENTCOMPANY>`);
  });

  it("uses TallyPrime's spelling, not the caller's casing", async () => {
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: ledgerList('AGEX', 3) });

    await callToolOk(build(), 'tally_get_company', { company: 'agex pharma llc' });

    const sent = ledgerRequests().join('\n');
    expect(sent).toContain(`<SVCURRENTCOMPANY>${FIRST}</SVCURRENTCOMPANY>`);
    // Tally matches SVCURRENTCOMPANY exactly and answers from the loaded
    // company on a mismatch rather than erroring, so the caller's spelling
    // reaching the wire is itself the defect.
    expect(sent).not.toContain('agex pharma llc');
  });

  it('scopes even when the company was not named and only one is loaded', async () => {
    // The path `args.company` leaves undefined. Scoping it anyway is what keeps
    // the cache key distinct per company rather than shared across all of them.
    mock.reset();
    mock.onBodyContaining('List of Companies', {
      body: COMPANY_LIST.replace(
        /<COMPANY NAME="AGBV Nutrition GmbH"[\s\S]*?<\/COMPANY>/,
        ''
      ),
    });
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: ledgerList('AGEX', 3) });

    await callToolOk(build(), 'tally_get_company', {});

    expect(ledgerRequests()[0]).toContain(`<SVCURRENTCOMPANY>${FIRST}</SVCURRENTCOMPANY>`);
  });
});

describe('a second company is not served the first one from cache', () => {
  it('re-requests, and reports the second company own ledger count', async () => {
    // THE REGRESSION. One registry, so one TallyClient and one live cache —
    // exactly the shape of a real session where an auditor asks about two
    // companies in a row. With the requests byte-identical, the second call
    // never reached the mock at all and reported the first company figures.
    const registry = build();

    mock.onBodyContaining(`<SVCURRENTCOMPANY>${FIRST}</SVCURRENTCOMPANY>`, {
      body: ledgerList('AGEX', 3),
    });
    mock.onBodyContaining(`<SVCURRENTCOMPANY>${SECOND}</SVCURRENTCOMPANY>`, {
      body: ledgerList('AGBV', 7),
    });

    const first = await callToolOk(registry, 'tally_get_company', { company: FIRST });
    const second = await callToolOk(registry, 'tally_get_company', { company: SECOND });

    expect(first.ledgerCount).toBe(3);
    expect(second.ledgerCount).toBe(7);

    // The load-bearing negative: two DISTINCT requests reached Tally. Asserting
    // only on the counts would still pass if the cache were keyed correctly but
    // the scope were dropped some other way.
    const sent = ledgerRequests();
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
  });

  it('names each company as itself in the payload', async () => {
    const registry = build();
    mock.onBodyContaining(`<SVCURRENTCOMPANY>${FIRST}</SVCURRENTCOMPANY>`, {
      body: ledgerList('AGEX', 3),
    });
    mock.onBodyContaining(`<SVCURRENTCOMPANY>${SECOND}</SVCURRENTCOMPANY>`, {
      body: ledgerList('AGBV', 7),
    });

    await callToolOk(registry, 'tally_get_company', { company: FIRST });
    const second = await callToolOk(registry, 'tally_get_company', { company: SECOND });

    // The company record was always right — it came from the list, not the
    // ledger fetch. That is what made the wrong ledger count so hard to see:
    // the name above it said the company you asked for.
    expect((second.company as { name: string }).name).toBe(SECOND);
  });
});
