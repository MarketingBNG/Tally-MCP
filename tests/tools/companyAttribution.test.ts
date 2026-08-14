import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolEnvelope,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { registerGenericReportTools } from '../../src/tools/genericReport.js';

/**
 * Which company do the figures actually belong to?
 *
 * ## The bug this file exists for
 *
 * Found live on 14 Aug 2026, minutes after a third company was opened in
 * TallyPrime. A request correctly scoped to `AgEx Pharma LLC` fetched AgEx's
 * figures and returned them in an envelope reading
 * `company_id: "AGBV Nutrition GmbH"`. Right numbers, wrong company's name on
 * them, no error raised.
 *
 * The cause was one line — `normalizeCompanies(...).data[0]` — resting on a
 * premise written into the comment above it: "TallyPrime serves one company at a
 * time, so the loaded company IS the scope". That is false. Tally holds several
 * open and `SVCURRENTCOMPANY` selects per request, so `data[0]` is whichever
 * company sorts first, not the one that was asked about.
 *
 * **Every fixture in this suite had a single company, so nothing failed.** That
 * is the lesson worth encoding: these tests load THREE, because one-company
 * fixtures cannot see this class of bug at all.
 */

let mock: MockTallyServer;
let port: number;

/** Three companies, deliberately NOT in the order they are asked for. */
const THREE_COMPANIES = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="AGBV Nutrition GmbH" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20230101</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260731</ENDINGAT>
    <NAME TYPE="String">AGBV Nutrition GmbH</NAME>
    <CURRENCYNAME TYPE="String">?</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">Germany</COUNTRYNAME>
  </COMPANY>
  <COMPANY NAME="AgEx Pharma LLC" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">AgEx Pharma LLC</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
  <COMPANY NAME="MUDALS TECHNOLOGIES PRIVATE LIMITED" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20210401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260728</ENDINGAT>
    <NAME TYPE="String">MUDALS TECHNOLOGIES PRIVATE LIMITED</NAME>
    <CURRENCYNAME TYPE="String">?</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">India</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const ONE_COMPANY = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="AgEx Pharma LLC" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">AgEx Pharma LLC</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const NEGATIVE_LEDGERS =
  '<ENVELOPE>' +
  '<DSPACCNAME><DSPDISPNAME>Owner Drawings</DSPDISPNAME></DSPACCNAME>' +
  '<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-8492.97</DSPCLDRAMTA></DSPCLDRAMT></DSPACCINFO>' +
  '</ENVELOPE>';

function build(): ToolRegistry {
  const registry = createToolRegistry();
  const deps = makeDeps(port);
  registerReportTools(registry.server, deps);
  registerGenericReportTools(registry.server, deps);
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
  mock.onBodyContaining('<ID>Negative Ledgers</ID>', { body: NEGATIVE_LEDGERS });
  mock.onBodyContaining('Trial Balance', { body: fixture('trial-balance.xml') });
  mock.onBodyContaining('<ID>Currencies</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
});

describe('company_id names the company that was actually asked about', () => {
  it('does NOT name the first company in the list', async () => {
    // The exact live failure: ask about AgEx with AGBV sorting first, and the
    // envelope used to read "AGBV Nutrition GmbH".
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });

    const envelope = await callToolEnvelope(build(), 'tally_get_report', {
      report: 'negative_ledgers',
      company: 'AgEx Pharma LLC',
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    });

    expect(envelope.company_id).toBe('AgEx Pharma LLC');
    expect(envelope.company_id).not.toBe('AGBV Nutrition GmbH');
  });

  it('names each of the three correctly in turn', async () => {
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });

    const names = [
      'AGBV Nutrition GmbH',
      'AgEx Pharma LLC',
      'MUDALS TECHNOLOGIES PRIVATE LIMITED',
    ];
    for (const name of names) {
      const envelope = await callToolEnvelope(build(), 'tally_get_report', {
        report: 'negative_ledgers',
        company: name,
        fromDate: '2025-04-01',
        toDate: '2026-03-31',
      });
      expect(envelope.company_id).toBe(name);
    }
  });

  it('resolves the company from the request that was actually sent', async () => {
    // The envelope's company must agree with SVCURRENTCOMPANY on the wire.
    // Anything re-derived afterwards can disagree with what was asked; the sent
    // body cannot.
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });

    const envelope = await callToolEnvelope(build(), 'tally_get_report', {
      report: 'negative_ledgers',
      company: 'MUDALS TECHNOLOGIES PRIVATE LIMITED',
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    });

    const sent = (envelope.source_query as string[]).find((body) =>
      body.includes('Negative Ledgers')
    );
    expect(sent).toContain(
      '<SVCURRENTCOMPANY>MUDALS TECHNOLOGIES PRIVATE LIMITED</SVCURRENTCOMPANY>'
    );
    expect(envelope.company_id).toBe('MUDALS TECHNOLOGIES PRIVATE LIMITED');
  });

  it('reports null rather than guessing when several are loaded and none is named', async () => {
    // TallyPrime answers from whichever company is ACTIVE on the desktop, and
    // nothing in the response says which. Null means "not resolved" — naming a
    // company here would be the original bug with extra steps.
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });

    const envelope = await callToolEnvelope(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    });

    expect(envelope.company_id).toBeNull();
  });

  it('still names the sole company when only one is loaded', async () => {
    // The single-company case must not regress into an unhelpful null — that is
    // the ordinary install and it is unambiguous.
    mock.onBodyContaining('List of Companies', { body: ONE_COMPANY });

    const envelope = await callToolEnvelope(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    });

    expect(envelope.company_id).toBe('AgEx Pharma LLC');
  });
});

describe('currency is never taken from the wrong company', () => {
  it('refuses to label figures when several are loaded and none is named', async () => {
    // AgEx is in dollars; AGBV and MUDALS both report "?". Taking the first
    // company's currency would put a euro or rupee label on dollar figures, or
    // the reverse — the same bug as company_id, one field over.
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });

    const envelope = await callToolEnvelope(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    });

    const rows = (envelope.data as { rows: { debit: { currency: string } | null }[] }).rows;
    expect(rows[0]?.debit?.currency ?? 'unknown').toBe('unknown');
  });

  it('uses the named company own currency, not the first one', async () => {
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });

    const envelope = await callToolEnvelope(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      company: 'AgEx Pharma LLC',
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    });

    const rows = (envelope.data as { rows: { debit: { currency: string } | null }[] }).rows;
    expect(rows[0]?.debit?.currency).toBe('$');
  });
});
