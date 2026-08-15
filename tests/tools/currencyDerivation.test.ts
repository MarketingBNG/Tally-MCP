import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerReportTools } from '../../src/tools/reports.js';
import {
  currencyForCountry,
  currencyIsComparable,
  labelFromFormalName,
} from '../../src/utils/currencyFromCountry.js';

/**
 * Deriving a currency label from the company's country.
 *
 * The gap this closes: TallyPrime cannot transport `€` or `₹` and substitutes
 * `?`, so every figure for such a company was labelled "unknown". That is
 * honest but unhelpful on money.
 *
 * The gap it must NOT open: a country is where a company is registered, not
 * what its books are kept in. The rules below are what keep the fix from
 * becoming the confident-wrong-label bug it was written to avoid.
 */

let mock: MockTallyServer;
let port: number;

/** One company, symbol untransportable, country unambiguous. */
const GERMAN_ONLY = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="AGBV Nutrition GmbH" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20230101</STARTINGFROM>
    <ENDINGAT TYPE="Date">20261231</ENDINGAT>
    <NAME TYPE="String">AGBV Nutrition GmbH</NAME>
    <CURRENCYNAME TYPE="String">?</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">Germany</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

/** Same company, but its country is one the table deliberately does not carry. */
const UNMAPPED_COUNTRY = GERMAN_ONLY.replace('Germany', 'Ruritania');

const ONE_CURRENCY =
  '<ENVELOPE><BODY><DATA><COLLECTION>' +
  '<CURRENCY NAME="?"><NAME TYPE="String">?</NAME></CURRENCY>' +
  '</COLLECTION></DATA></BODY></ENVELOPE>';

/** The live shape that must block derivation: a second currency is defined. */
const TWO_CURRENCIES =
  '<ENVELOPE><BODY><DATA><COLLECTION>' +
  '<CURRENCY NAME="?"><NAME TYPE="String">?</NAME></CURRENCY>' +
  '<CURRENCY NAME="$"><NAME TYPE="String">$</NAME></CURRENCY>' +
  '</COLLECTION></DATA></BODY></ENVELOPE>';

/**
 * The real live shape, captured 2026-08-15 from AGBV Nutrition GmbH: the
 * symbol will not transport, but Tally sends the spelled-out MAILINGNAME for
 * the very same currency.
 */
const TWO_CURRENCIES_NAMED =
  '<ENVELOPE><BODY><DATA><COLLECTION>' +
  '<CURRENCY NAME="U$"><NAME TYPE="String">U$</NAME><MAILINGNAME TYPE="String">USD</MAILINGNAME></CURRENCY>' +
  '<CURRENCY NAME="?"><NAME TYPE="String">?</NAME><MAILINGNAME TYPE="String">European Euro</MAILINGNAME></CURRENCY>' +
  '</COLLECTION></DATA></BODY></ENVELOPE>';

/** Two untransportable currencies: the symbol match is ambiguous. */
const TWO_UNREADABLE =
  '<ENVELOPE><BODY><DATA><COLLECTION>' +
  '<CURRENCY NAME="?"><NAME TYPE="String">?</NAME><MAILINGNAME TYPE="String">European Euro</MAILINGNAME></CURRENCY>' +
  '<CURRENCY NAME="?"><NAME TYPE="String">?</NAME><MAILINGNAME TYPE="String">Indian Rupee</MAILINGNAME></CURRENCY>' +
  '</COLLECTION></DATA></BODY></ENVELOPE>';

function trialBalance(): string {
  return (
    '<ENVELOPE>' +
    '<DSPACCNAME><DSPDISPNAME>Sales</DSPDISPNAME></DSPACCNAME>' +
    '<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-1000</DSPCLDRAMTA></DSPCLDRAMT></DSPACCINFO>' +
    '</ENVELOPE>'
  );
}

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerReportTools(registry.server, makeDeps(port));
  return registry;
}

interface Row {
  debit?: { currency: string };
  credit?: { currency: string };
}

async function currenciesOn(): Promise<string[]> {
  const result = await callToolOk(build(), 'tally_get_statement', {
    statement: 'trial_balance',
    company: 'AGBV Nutrition GmbH',
    fromDate: '2026-01-01',
    toDate: '2026-01-31',
  });

  return [
    ...new Set(
      (result.rows as Row[]).flatMap((row) =>
        [row.debit?.currency, row.credit?.currency].filter((c): c is string => c !== undefined)
      )
    ),
  ];
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
  mock.onBodyContaining('List of Companies', { body: GERMAN_ONLY });
  mock.onBodyContaining('<ID>Currencies</ID>', { body: ONE_CURRENCY });
  mock.onBodyContaining('<ID>Ledgers</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
  mock.onBodyContaining('Trial Balance', { body: trialBalance() });
});

describe('a single-currency company whose symbol did not transport', () => {
  it('labels its figures from the country instead of leaving them unknown', async () => {
    expect(await currenciesOn()).toEqual(['EUR']);
  });

  it('says plainly that the label was inferred, not reported by TallyPrime', async () => {
    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      company: 'AGBV Nutrition GmbH',
      fromDate: '2026-01-01',
      toDate: '2026-01-31',
    });
    const warnings = (result.warnings as string[]).join(' ');

    expect(warnings).toMatch(/INFERRED FROM THE COUNTRY/i);
    expect(warnings).toMatch(/NOT A FACT ABOUT ITS BOOKS/i);
    // The reader must still know the figures themselves are untouched.
    expect(warnings).toMatch(/nothing is converted/i);
  });
});

describe("Tally's own spelled-out name, which outranks the country", () => {
  it('labels a euro company EUR even though it defines a second currency', async () => {
    // The live AGBV shape. The country derivation is correctly refused here
    // (two currencies defined), but the currency master still NAMES the base
    // currency — so the label is read from the books rather than guessed.
    mock.onBodyContaining('<ID>Currencies</ID>', { body: TWO_CURRENCIES_NAMED });

    expect(await currenciesOn()).toEqual(['EUR']);
  });

  it('says the label came from the spelled-out name, not from a guess', async () => {
    mock.onBodyContaining('<ID>Currencies</ID>', { body: TWO_CURRENCIES_NAMED });

    const result = await callToolOk(build(), 'tally_get_statement', {
      statement: 'trial_balance',
      company: 'AGBV Nutrition GmbH',
      fromDate: '2026-01-01',
      toDate: '2026-01-31',
    });
    const warnings = (result.warnings as string[]).join(' ');

    expect(warnings).toContain('European Euro');
    expect(warnings).toMatch(/read from the books, not inferred/i);
    // And it must NOT claim to have inferred anything from the country.
    expect(warnings).not.toMatch(/INFERRED FROM THE COUNTRY/i);
  });

  it('refuses when two currencies both failed to transport, because the match is ambiguous', async () => {
    // Both read "?", so there is no way to tell which one is the base.
    mock.onBodyContaining('<ID>Currencies</ID>', { body: TWO_UNREADABLE });

    expect(await currenciesOn()).toEqual(['unknown']);
  });
});

describe('what blocks the derivation', () => {
  it('refuses to derive when the company defines a second currency', async () => {
    // The live case. AGBV also defines "$", so "registered in Germany" cannot
    // establish that its books are in euros — this is exactly the guess the
    // "unknown" behaviour exists to prevent.
    mock.onBodyContaining('<ID>Currencies</ID>', { body: TWO_CURRENCIES });

    expect(await currenciesOn()).toEqual(['unknown']);
  });

  it('refuses to derive from a country the table does not carry', async () => {
    // An absent country returns null rather than a best guess.
    mock.onBodyContaining('List of Companies', { body: UNMAPPED_COUNTRY });

    expect(await currenciesOn()).toEqual(['unknown']);
  });

  it('never overrides a symbol TallyPrime transported successfully', async () => {
    // The guard must stay narrow: a company reporting a usable symbol must be
    // completely unaffected by any of this.
    mock.onBodyContaining('List of Companies', {
      body: GERMAN_ONLY.replace('<CURRENCYNAME TYPE="String">?</CURRENCYNAME>', '<CURRENCYNAME TYPE="String">$</CURRENCYNAME>'),
    });

    expect(await currenciesOn()).toEqual(['$']);
  });
});

describe('the country table itself', () => {
  it('maps only what is unambiguous, and is case- and space-insensitive', () => {
    expect(currencyForCountry('Germany')).toBe('EUR');
    expect(currencyForCountry('  india  ')).toBe('INR');
    expect(currencyForCountry('United States of America')).toBe('USD');
  });

  it('returns null rather than guessing', () => {
    expect(currencyForCountry('Ruritania')).toBeNull();
    expect(currencyForCountry('')).toBeNull();
    expect(currencyForCountry(null)).toBeNull();
    expect(currencyForCountry(undefined)).toBeNull();
  });
});

describe('labelFromFormalName', () => {
  it('maps the spelled-out names Tally actually sends to ISO', () => {
    expect(labelFromFormalName('European Euro')).toBe('EUR');
    expect(labelFromFormalName('  indian rupee ')).toBe('INR');
  });

  it('passes an ISO-shaped name straight through', () => {
    // MUDALS reports exactly this, live.
    expect(labelFromFormalName('INR')).toBe('INR');
    expect(labelFromFormalName('usd')).toBe('USD');
  });

  it('keeps an unrecognised name verbatim rather than discarding it', () => {
    // Still better than "unknown": it came from the company's own master.
    expect(labelFromFormalName('Ruritanian Crown')).toBe('Ruritanian Crown');
  });

  it('returns null when there is no usable name', () => {
    expect(labelFromFormalName(null)).toBeNull();
    expect(labelFromFormalName('   ')).toBeNull();
  });
});

describe('an inferred label may not be subtracted across companies', () => {
  it('treats only established labels as comparable', () => {
    // The property that keeps two "EUR"-by-inference companies from being
    // subtracted: matching labels are not enough, the label must be a fact.
    expect(currencyIsComparable('tally')).toBe(true);
    expect(currencyIsComparable('configuration')).toBe(true);
    expect(currencyIsComparable('derived-from-country')).toBe(false);
    expect(currencyIsComparable('unresolved')).toBe(false);
  });
});
