import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerReportTools } from '../../src/tools/reports.js';

/**
 * What happens to figures when TallyPrime cannot transport the currency symbol.
 *
 * Found live 2026-08-14 on a German company. TallyPrime reported its base
 * currency as a literal `?` — byte 0x3F in the raw response, a substitution made
 * inside TallyPrime because the euro sign is absent from the codepage it exports
 * with. Ten candidate encoding settings were probed and every response came back
 * byte-identical, so the symbol is not recoverable.
 *
 * Two wrong answers were available and both are tested against here:
 *
 *  1. Pass `?` through. Every figure then carries `"currency": "?"`, which reads
 *     as data and is not a currency.
 *  2. Fall back to the INR default. That labels euro balances INR — the exact bug
 *     fixed on 2026-08-13, and the more dangerous shape, because the numbers are
 *     right and only the label lies.
 */

let mock: MockTallyServer;
let port: number;

/** A company whose currency symbol did not survive export. */
const GERMAN_COMPANY = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="INVENTED NUTRITION GMBH" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20230101</STARTINGFROM>
    <ENDINGAT TYPE="Date">20231231</ENDINGAT>
    <NAME TYPE="String">INVENTED NUTRITION GMBH</NAME>
    <CURRENCYNAME TYPE="String">?</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">Germany</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

/** The same books, but with a symbol that transported fine. */
const DOLLAR_COMPANY = GERMAN_COMPANY.replace(
  '<CURRENCYNAME TYPE="String">?</CURRENCYNAME>',
  '<CURRENCYNAME TYPE="String">$</CURRENCYNAME>'
);

/** Two currencies, one of them the unreadable base. */
const CURRENCIES = `<ENVELOPE><BODY><DATA><COLLECTION>
  <CURRENCY NAME="$" RESERVEDNAME=""><NAME TYPE="String">$</NAME></CURRENCY>
  <CURRENCY NAME="?" RESERVEDNAME=""><NAME TYPE="String">?</NAME></CURRENCY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

function build(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  registerReportTools(registry.server, makeDeps(port, overrides));
  return registry;
}

/** The book year of the fixture company, so the end date binds and nothing else warns. */
const PERIOD = { fromDate: '2023-01-01', toDate: '2023-12-31' };

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('<ID>Currencies</ID>', { body: CURRENCIES });
  mock.onBodyContaining('Trial Balance', { body: fixture('trial-balance.xml') });
});

interface Row {
  name: string;
  debit: { amount: string; currency: string } | null;
  credit: { amount: string; currency: string } | null;
}

async function statement(companyBody: string): Promise<Record<string, unknown>> {
  mock.onBodyContaining('List of Companies', { body: companyBody });
  return callToolOk(build(), 'tally_get_statement', {
    statement: 'trial_balance',
    ...PERIOD,
  });
}

describe('a company whose currency symbol TallyPrime could not transport', () => {
  it('does not label figures with the substituted question mark', async () => {
    const result = await statement(GERMAN_COMPANY);
    const currencies = (result.rows as Row[]).flatMap((row) =>
      [row.debit?.currency, row.credit?.currency].filter((c): c is string => c !== undefined)
    );

    expect(currencies.length).toBeGreaterThan(0);
    expect(currencies).not.toContain('?');
  });

  it('does not fall back to INR on a company that is plainly not Indian', async () => {
    // The dangerous outcome: correct numbers under a confidently wrong label.
    const result = await statement(GERMAN_COMPANY);
    const currencies = (result.rows as Row[]).flatMap((row) =>
      [row.debit?.currency, row.credit?.currency].filter((c): c is string => c !== undefined)
    );

    expect(currencies).not.toContain('INR');
  });

  it('labels them "unknown" — a word, not a symbol or a plausible code', async () => {
    const result = await statement(GERMAN_COMPANY);
    const currencies = new Set(
      (result.rows as Row[]).flatMap((row) =>
        [row.debit?.currency, row.credit?.currency].filter((c): c is string => c !== undefined)
      )
    );

    expect([...currencies]).toEqual(['unknown']);
  });

  it('explains what happened, names the country, and says the amounts are exact', async () => {
    const result = await statement(GERMAN_COMPANY);
    const warnings = (result.warnings as string[]).join(' ');

    expect(warnings).toMatch(/could not be read/i);
    expect(warnings).toMatch(/substitution/i);
    expect(warnings).toContain('Germany');
    // The reader must know the FIGURES are fine — only the label is missing.
    expect(warnings).toMatch(/never converted/i);
  });

  it('tells the reader not to infer the currency from the country', async () => {
    // This company also defines "$", so Germany does not imply euros. Inferring
    // would be inventing an assertion about the books.
    const result = await statement(GERMAN_COMPANY);
    const warnings = (result.warnings as string[]).join(' ');

    expect(warnings).toMatch(/do NOT assume a currency from the country/i);
  });

  it('flags the unreadable entry in the multi-currency list rather than listing "?" as a currency', async () => {
    const result = await statement(GERMAN_COMPANY);
    const warnings = (result.warnings as string[]).join(' ');

    expect(warnings).toMatch(/symbol not transportable/i);
  });
});

describe('a company whose currency symbol transported fine', () => {
  it('is unaffected — the symbol is used and no substitution warning appears', async () => {
    // The guard must be narrow. A working company gaining an "unknown" label or a
    // scary warning would be a regression caused by the fix.
    const result = await statement(DOLLAR_COMPANY);
    const currencies = new Set(
      (result.rows as Row[]).flatMap((row) =>
        [row.debit?.currency, row.credit?.currency].filter((c): c is string => c !== undefined)
      )
    );

    expect([...currencies]).toEqual(['$']);
    expect((result.warnings as string[]).join(' ')).not.toMatch(/could not be read/i);
  });
});

describe('TALLY_CURRENCY_LABEL closes the gap the symbol left', () => {
  /**
   * The one residue the plan called irreducible.
   *
   * The symbol is destroyed inside TallyPrime, so no request can recover it —
   * but the person running the server knows what currency the books are in, and
   * that is where the answer actually lives. Two properties make supplying it
   * safe rather than a new way to mislabel figures, and both are tested.
   */
  async function labelled(
    companyBody: string,
    overrides: Record<string, string>
  ): Promise<Record<string, unknown>> {
    mock.onBodyContaining('List of Companies', { body: companyBody });
    return callToolOk(build(overrides), 'tally_get_statement', {
      statement: 'trial_balance',
      ...PERIOD,
    });
  }

  it('labels the figures with the configured currency', async () => {
    const result = await labelled(GERMAN_COMPANY, { TALLY_CURRENCY_LABEL: 'EUR' });
    const rows = result.rows as Row[];
    expect(rows[0]?.debit?.currency ?? rows[0]?.credit?.currency).toBe('EUR');
  });

  it('says the label came from configuration, not from TallyPrime', async () => {
    // A label the operator supplied and a label Tally reported are different
    // kinds of fact. If the output cannot tell them apart, a wrong setting
    // becomes indistinguishable from ground truth.
    const result = await labelled(GERMAN_COMPANY, { TALLY_CURRENCY_LABEL: 'EUR' });
    expect((result.warnings as string[]).join(' ')).toContain(
      'CURRENCY LABEL SUPPLIED BY CONFIGURATION'
    );
  });

  it('refuses a bare label when more than one company is loaded', async () => {
    // Found on live data with three companies open. A German company and an
    // Indian company BOTH report their symbol as "?" — the euro and the rupee
    // are equally absent from Tally's export codepage — so a bare "EUR" would
    // have labelled rupee balances EUR. Numbers right, label a confident lie.
    const twoCompanies = GERMAN_COMPANY.replace(
      '</COLLECTION>',
      `<COMPANY NAME="MUDALS TECHNOLOGIES PRIVATE LIMITED" RESERVEDNAME="">
         <STARTINGFROM TYPE="Date">20210401</STARTINGFROM>
         <NAME TYPE="String">MUDALS TECHNOLOGIES PRIVATE LIMITED</NAME>
         <CURRENCYNAME TYPE="String">?</CURRENCYNAME>
         <COUNTRYNAME TYPE="String">India</COUNTRYNAME>
       </COMPANY></COLLECTION>`
    );
    const result = await labelled(twoCompanies, { TALLY_CURRENCY_LABEL: 'EUR' });
    const rows = result.rows as Row[];
    expect(rows[0]?.debit?.currency ?? rows[0]?.credit?.currency).toBe('unknown');
    // And it must say WHY, or an operator who configured it will think the
    // setting is broken rather than inapplicable. The reason is now the
    // stronger one: with several companies loaded and none named, we cannot
    // establish WHICH company answered, so there is no company to label.
    expect((result.warnings as string[]).join(' ')).toContain('CURRENCY NOT ESTABLISHED');
  });

  it('applies a per-company label even with several companies loaded', async () => {
    const result = await labelled(GERMAN_COMPANY, {
      TALLY_CURRENCY_LABEL: 'INVENTED NUTRITION GMBH=EUR;MUDALS TECHNOLOGIES PRIVATE LIMITED=INR',
    });
    const rows = result.rows as Row[];
    expect(rows[0]?.debit?.currency ?? rows[0]?.credit?.currency).toBe('EUR');
    expect((result.warnings as string[]).join(' ')).toContain('names this company specifically');
  });

  it('leaves a company the per-company setting does not mention as unknown', async () => {
    const result = await labelled(GERMAN_COMPANY, {
      TALLY_CURRENCY_LABEL: 'SOME OTHER COMPANY=INR',
    });
    const rows = result.rows as Row[];
    expect(rows[0]?.debit?.currency ?? rows[0]?.credit?.currency).toBe('unknown');
  });

  it('warns that a bare label will stop applying if a second company is opened', async () => {
    const result = await labelled(GERMAN_COMPANY, { TALLY_CURRENCY_LABEL: 'EUR' });
    expect((result.warnings as string[]).join(' ')).toContain('If a second company is opened');
  });

  it('NEVER overrides a symbol TallyPrime transported successfully', async () => {
    // The important one. A setting left over from a German company must not be
    // able to relabel a dollar company's figures as euro — so the override is
    // consulted only where Tally's own symbol was unusable.
    const result = await labelled(DOLLAR_COMPANY, { TALLY_CURRENCY_LABEL: 'EUR' });
    const rows = result.rows as Row[];
    expect(rows[0]?.debit?.currency ?? rows[0]?.credit?.currency).toBe('$');
  });

  it('still reports unknown when nothing was configured', async () => {
    const result = await labelled(GERMAN_COMPANY, {});
    const rows = result.rows as Row[];
    expect(rows[0]?.debit?.currency ?? rows[0]?.credit?.currency).toBe('unknown');
    expect((result.warnings as string[]).join(' ')).toContain('TALLY_CURRENCY_LABEL');
  });
});
