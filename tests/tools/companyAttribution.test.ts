import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolEnvelope,
  callToolError,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { registerGenericReportTools } from '../../src/tools/genericReport.js';
import { registerCompanyTools } from '../../src/tools/companies.js';
import { registerTieOutTools } from '../../src/tools/tieOut.js';

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
  registerCompanyTools(registry.server, deps);
  registerTieOutTools(registry.server, deps);
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

describe('the same assumption, swept out of three more places', () => {
  // Found by grepping for `data[0]` after the envelope bug. Each of these read
  // "the first company in the list" while meaning "the company being asked
  // about" — invisible with one company loaded, wrong with three.

  it('tally_get_company refuses to profile a company nobody named', async () => {
    // It used to describe whichever sorted first: ledger count, groups in use,
    // features — a full description of the WRONG books, under no name at all.
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });

    const error = await callToolError(build(), 'tally_get_company');

    expect(error.code).toBe('TALLY_COMPANY_NOT_LOADED');
    expect(error.message).toContain('3 companies loaded');
    // The fix is only useful if it says which ones can be named.
    expect(error.suggestion).toContain('AgEx Pharma LLC');
    expect(error.suggestion).toContain('MUDALS TECHNOLOGIES PRIVATE LIMITED');
  });

  it('tally_get_company still answers with no argument when one is loaded', async () => {
    mock.onBodyContaining('List of Companies', { body: ONE_COMPANY });
    mock.onBodyContaining('<FETCH>*</FETCH>', { body: fixture('ledger-list-allfields.xml') });

    const envelope = await callToolEnvelope(build(), 'tally_get_company');
    expect(envelope.company_id).toBe('AgEx Pharma LLC');
  });

  it('the accumulation-endpoint warning quotes the right company book end', async () => {
    // This feeds the caveat saying how far figures REALLY run when Tally
    // ignores the end date. AGBV's books end 2026-07-31 and AgEx's 2026-03-31,
    // so quoting the wrong one makes the correction itself wrong.
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });

    const envelope = await callToolEnvelope(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      company: 'AgEx Pharma LLC',
      fromDate: '2025-04-01',
      // Deliberately not a 31st, so the non-binding path runs.
      toDate: '2026-06-30',
    });

    const warnings = JSON.stringify(envelope.data);
    expect(warnings).not.toContain('2026-07-31');
  });

  it('tie-out says whose year it could not determine, instead of picking one', async () => {
    // The three run a German calendar year and two April years. Defaulting to
    // the first would check a period that company never closed against, and
    // every roll-forward difference would then be an artefact.
    mock.onBodyContaining('List of Companies', { body: THREE_COMPANIES });
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
    mock.onBodyContaining('<ID>Groups</ID>', {
      body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
    });
    mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('day-book.xml') });

    const envelope = await callToolEnvelope(build(), 'tally_check_tie_out');
    const text = JSON.stringify(envelope.data);
    expect(text).toContain('more than one company loaded');
  });
});
