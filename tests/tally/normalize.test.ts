import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Decimal } from 'decimal.js';
import {
  normalizeCompanies,
  normalizeCurrencies,
  normalizeLedgers,
  normalizeTrialBalance,
  normalizeBalanceSheet,
  normalizeProfitLoss,
  normalizeMonthlyFlow,
  normalizeVouchers,
  normalizeGroups,
} from '../../src/tally/normalize.js';
import { sanitizeTallyXml } from '../../src/tally/sanitizeXml.js';
import { TallyError } from '../../src/tally/TallyError.js';

/**
 * These run against redacted copies of real TallyPrime 7.x responses — see
 * tests/fixtures/README.md. Structure is untouched; only names and amounts
 * are fake. Fixtures go through the sanitiser first, exactly as the client
 * does, so the tests exercise the real pipeline rather than a tidied shortcut.
 */
function fixture(name: string): string {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return sanitizeTallyXml(readFileSync(path, 'utf-8')).xml;
}

describe('normalizeCompanies', () => {
  it('reads the company and its opening date', () => {
    const { data } = normalizeCompanies(fixture('company-list.xml'));

    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({
      name: 'EXAMPLE TRADING PRIVATE LIMITED',
      startingFrom: '2021-04-01',
      // This fixture predates CurrencyName being requested, so both are null —
      // which is the fallback path: callers then label figures DEFAULT_CURRENCY.
      currency: null,
      country: null,
      source: {
        system: 'tallyprime',
        entityType: 'company',
        identifier: 'EXAMPLE TRADING PRIVATE LIMITED',
      },
    });
  });

  /**
   * CMPINFO contains <COMPANY>0</COMPANY> as a record counter. Counting it as
   * a company would report a phantom entry named "" on every call.
   */
  it('ignores the CMPINFO counter element', () => {
    const { data } = normalizeCompanies(fixture('company-list.xml'));
    expect(data.map((c) => c.name)).not.toContain('');
  });
});

describe('normalizeCurrencies', () => {
  const TWO =
    '<ENVELOPE><BODY><DATA>' +
    // The CMPINFO counter shares the record tag name, as everywhere else.
    '<CURRENCY>0</CURRENCY>' +
    '<CURRENCY NAME="$"><NAME>$</NAME><MAILINGNAME>Dollar</MAILINGNAME>' +
    '<DECIMALPLACES> 2</DECIMALPLACES></CURRENCY>' +
    '<CURRENCY NAME="Rs."><NAME>Rs.</NAME><MAILINGNAME>Rupees</MAILINGNAME>' +
    '<DECIMALPLACES> 2</DECIMALPLACES></CURRENCY>' +
    '</DATA></BODY></ENVELOPE>';

  it('reads each currency with its spelled-out name', () => {
    const { data } = normalizeCurrencies(TWO);

    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({ name: '$', formalName: 'Dollar', decimalPlaces: '2' });
  });

  /**
   * The count is the whole point: it decides whether the multi-currency caveat is
   * disclosed, so a phantom counter would raise it on every single-currency company
   * and train the reader to ignore the warning.
   */
  it('ignores the CMPINFO counter so the count is trustworthy', () => {
    const { data } = normalizeCurrencies(TWO);
    expect(data.map((entry) => entry.name)).not.toContain('0');
  });

  it('reports one currency for a single-currency company', () => {
    const { data } = normalizeCurrencies(
      '<ENVELOPE><BODY><DATA><CURRENCY>0</CURRENCY>' +
        '<CURRENCY NAME="$"><NAME>$</NAME></CURRENCY></DATA></BODY></ENVELOPE>'
    );
    expect(data).toHaveLength(1);
    expect(data[0]?.formalName).toBeNull();
  });
});

describe('normalizeLedgers', () => {
  it('reads names, parents and balances', () => {
    const { data } = normalizeLedgers(fixture('ledger-list.xml'));

    expect(data).toHaveLength(8);
    const salary = data.find((l) => l.name === 'Aylward Singh_Salary Payable');
    expect(salary?.parent).toBe('SALARY PAYABLE');
    expect(salary?.closingBalance).toEqual({ amount: '-77700', currency: 'INR' });
  });

  /**
   * The distinction the whole null-vs-zero rule exists for: this ledger has
   * an empty closing balance and a real zero opening balance, in the same
   * record. They must not come out the same.
   */
  it('reports an empty balance as null and a real zero as zero', () => {
    const { data } = normalizeLedgers(fixture('ledger-list.xml'));
    const charges = data.find((l) => l.name === 'Accounting Charges');

    expect(charges?.closingBalance).toBeNull();
    expect(charges?.openingBalance).toEqual({ amount: '0', currency: 'INR' });
  });

  it('preserves an ampersand in a party name', () => {
    const { data } = normalizeLedgers(fixture('ledger-list.xml'));
    expect(data.map((l) => l.name)).toContain('Bramley & Sons Accessories Private Limited');
  });

  it('reads a GSTIN where one is present and null where it is not', () => {
    const { data } = normalizeLedgers(fixture('ledger-list.xml'));

    expect(data.find((l) => l.name.startsWith('Bramley'))?.gstin).toBe('29AABCE1234F1Z5');
    expect(data.find((l) => l.name === 'Northwind Retail')?.gstin).toBeNull();
  });

  it('reports no warnings for a clean export', () => {
    expect(normalizeLedgers(fixture('ledger-list.xml')).warnings).toEqual([]);
  });
});

/**
 * No live-Tally group-list export has been captured yet (unlike the other
 * masters here), so this exercises the parser against a hand-built payload
 * shaped like Tally's documented Group collection response rather than a
 * redacted real one.
 */
describe('normalizeGroups', () => {
  const xml =
    '<ENVELOPE><BODY><DATA>' +
    '<GROUP>0</GROUP>' +
    '<GROUP NAME="Sundry Debtors"><PARENT>Current Assets</PARENT>' +
    '<ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>' +
    '<GROUP NAME="Direct Expenses"><PARENT></PARENT>' +
    '<ISREVENUE>Yes</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>' +
    '</DATA></BODY></ENVELOPE>';

  it('reads name, parent and the revenue/debit classification', () => {
    const { data } = normalizeGroups(xml);

    expect(data).toHaveLength(2);
    expect(data.find((g) => g.name === 'Sundry Debtors')).toEqual({
      name: 'Sundry Debtors',
      parent: 'Current Assets',
      isRevenue: false,
      isDeemedPositive: true,
      source: { system: 'tallyprime', entityType: 'group', identifier: 'Sundry Debtors' },
    });
  });

  it('reports an empty parent as null for a primary group', () => {
    const { data } = normalizeGroups(xml);
    expect(data.find((g) => g.name === 'Direct Expenses')?.parent).toBeNull();
  });

  it('ignores the CMPINFO counter element', () => {
    const { data } = normalizeGroups(xml);
    expect(data.map((g) => g.name)).not.toContain('');
  });
});

describe('normalizeTrialBalance', () => {
  it('pairs each account with its own debit and credit', () => {
    const { data } = normalizeTrialBalance(fixture('trial-balance.xml'));

    expect(data).toHaveLength(4);
    expect(data[0]).toEqual({
      name: 'Capital Account',
      // Tally reports debits negative. The sign is passed through untouched.
      debit: { amount: '-2222222.22', currency: 'INR' },
      credit: { amount: '555050.05', currency: 'INR' },
    });
  });

  it('reports an empty column as null rather than zero', () => {
    const { data } = normalizeTrialBalance(fixture('trial-balance.xml'));
    const loans = data.find((r) => r.name === 'Loans (Liability)');

    expect(loans?.debit).toBeNull();
    expect(loans?.credit).toEqual({ amount: '666000', currency: 'INR' });
  });

  it('keeps a genuine zero balance distinct from an absent one', () => {
    const { data } = normalizeTrialBalance(fixture('trial-balance.xml'));
    const suspense = data.find((r) => r.name.startsWith('Suspense'));

    expect(suspense?.debit).toEqual({ amount: '0', currency: 'INR' });
    expect(suspense?.credit).toEqual({ amount: '0', currency: 'INR' });
  });

  it('decodes an escaped ampersand in an account name', () => {
    const { data } = normalizeTrialBalance(fixture('trial-balance.xml'));
    expect(data.map((r) => r.name)).toContain('Suspense A/c & Others');
  });
});

describe('normalizeBalanceSheet', () => {
  it('reads rows through the extra BSNAME wrapper', () => {
    const { data } = normalizeBalanceSheet(fixture('balance-sheet.xml'));

    expect(data).toHaveLength(4);
    expect(data[0]).toEqual({
      name: 'Capital Account',
      amount: { amount: '-3333333.33', currency: 'INR' },
      subAmount: null,
    });
  });

  it('reads the sub-total column where one is present', () => {
    const { data } = normalizeBalanceSheet(fixture('balance-sheet.xml'));
    expect(data.find((r) => r.name === 'Current Liabilities')?.subAmount).toEqual({
      amount: '-12345',
      currency: 'INR',
    });
  });

  it('reports a row with both columns empty as two nulls, not zeros', () => {
    const { data } = normalizeBalanceSheet(fixture('balance-sheet.xml'));
    const difference = data.find((r) => r.name === 'Difference in Opening Balances');

    expect(difference?.amount).toBeNull();
    expect(difference?.subAmount).toBeNull();
  });
});

describe('normalizeProfitLoss', () => {
  /**
   * The P&L value block is PLAMT but its main column is BSMAINAMT — Tally
   * reuses the balance sheet tag. Reading PLMAINAMT instead would return an
   * empty P&L with no error at all.
   */
  it('reads the main column from BSMAINAMT inside PLAMT', () => {
    const { data } = normalizeProfitLoss(fixture('profit-loss.xml'));

    expect(data).toHaveLength(6);
    expect(data[0]).toEqual({
      name: 'Sales Accounts',
      amount: { amount: '12345678.91', currency: 'INR' },
      subAmount: null,
    });
  });

  it('preserves the negative sign Tally uses for expenses', () => {
    const { data } = normalizeProfitLoss(fixture('profit-loss.xml'));
    expect(data.find((r) => r.name === 'Indirect Expenses')?.amount).toEqual({
      amount: '-9876543.21',
      currency: 'INR',
    });
  });

  it('reads the sub-total column', () => {
    const { data } = normalizeProfitLoss(fixture('profit-loss.xml'));
    expect(data.find((r) => r.name === 'Direct Expenses')?.subAmount).toEqual({
      amount: '-1111111.11',
      currency: 'INR',
    });
  });
});

describe('normalizeMonthlyFlow', () => {
  it('pairs each month with its own three columns positionally', () => {
    const { data } = normalizeMonthlyFlow(fixture('cash-flow.xml'), 'cash flow');

    expect(data.map((row) => row.period)).toEqual(['April', 'May', 'June', 'July']);
    expect(data[0]).toEqual({
      period: 'April',
      // Debits arrive negative; the sign is passed through untouched.
      debit: { amount: '-1111111.11', currency: 'INR' },
      credit: { amount: '1000000', currency: 'INR' },
      net: { amount: '-111111.11', currency: 'INR' },
    });
  });

  it('reads the funds flow shape with the same pairing', () => {
    const { data } = normalizeMonthlyFlow(fixture('funds-flow.xml'), 'funds flow');

    expect(data).toHaveLength(4);
    // Each month's debit equals the previous month's credit in Tally's own
    // export: opening and closing funds. Columns must not get mixed up.
    expect(data[1]?.debit).toEqual(data[0]?.credit);
    expect(data[2]?.debit).toEqual(data[1]?.credit);
  });

  it('reports a month with no amount block as nulls plus a warning, never zeros', () => {
    const xml = '<ENVELOPE><DSPPERIOD>April</DSPPERIOD></ENVELOPE>';
    const { data, warnings } = normalizeMonthlyFlow(xml, 'cash flow');

    expect(data).toEqual([{ period: 'April', debit: null, credit: null, net: null }]);
    expect(warnings.some((w) => w.includes('April'))).toBe(true);
  });
});

describe('normalizeVouchers', () => {
  it('reads the header fields of each voucher', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'));

    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      date: '2026-07-28',
      voucherType: 'Payment',
      voucherNumber: '111',
      partyLedgerName: 'Northwind Retail Limited',
      isCancelled: false,
      isOptional: false,
    });
  });

  /**
   * `<VOUCHER>0</VOUCHER>` from the CMPINFO preamble must never become a record.
   *
   * Every other normaliser filters these out by requiring a NAME attribute, but a
   * voucher has none, so this was the one record type that could return a
   * phantom — null date, null number, no entries. It inflated the voucher count
   * AND handed the tie-out control an unbalanced voucher. Only reachable when the
   * response omits the `<DATA>` wrapper, which Tally really does on empty results
   * (see stock-items-empty.xml).
   */
  it('ignores the CMPINFO counter when the response has no DATA wrapper', () => {
    const { data } = normalizeVouchers(
      '<ENVELOPE><BODY><DESC><CMPINFO><COMPANY>0</COMPANY><VOUCHER>0</VOUCHER></CMPINFO></DESC>' +
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment"><DATE>20260728</DATE>' +
        '<VOUCHERNUMBER>111</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></BODY></ENVELOPE>'
    );

    expect(data).toHaveLength(1);
    expect(data[0]?.voucherNumber).toBe('111');
  });

  /**
   * Tally emits numeric character references, and fast-xml-parser decodes named
   * entities but not numeric ones. A real bank narration arrived as
   * "...530943&#13;&#10;RECURRING..." — six literal escape characters where the
   * statement has a line break, which also broke narration search across it.
   */
  it('decodes numeric character references in text', () => {
    const { data } = normalizeVouchers(
      '<ENVELOPE><BODY><DATA><VOUCHER VCHTYPE="Payment">' +
        '<NARRATION>Ref 123&#13;&#10;Bank: HDFC</NARRATION></VOUCHER></DATA></BODY></ENVELOPE>'
    );

    expect(data[0]?.narration).toBe('Ref 123\r\nBank: HDFC');
  });

  /**
   * An invoice carries BOTH entry lists, with LEDGERENTRIES.LIST repeating the
   * party that ALLLEDGERENTRIES.LIST already holds. Reading both counted the
   * party twice and failed 29 of 453 real vouchers on double entry.
   */
  it('prefers ALLLEDGERENTRIES and does not also read the duplicate LEDGERENTRIES', () => {
    const { data } = normalizeVouchers(
      '<ENVELOPE><BODY><DATA><VOUCHER VCHTYPE="Sales">' +
        '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Party</LEDGERNAME>' +
        '<AMOUNT>-100</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST>' +
        '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME>' +
        '<AMOUNT>100</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST>' +
        '<LEDGERENTRIES.LIST><LEDGERNAME>Party</LEDGERNAME>' +
        '<AMOUNT>-100</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></LEDGERENTRIES.LIST>' +
        '</VOUCHER></DATA></BODY></ENVELOPE>'
    );

    const entries = data[0]?.entries ?? [];
    expect(entries.map((entry) => entry.ledgerName)).toEqual(['Party', 'Sales']);
    // The whole point: the voucher balances only if the party is counted once.
    const total = entries.reduce((sum, entry) => sum + Number(entry.amount?.amount ?? 0), 0);
    expect(total).toBe(0);
  });

  it('labels amounts with the currency it is given, not a hard-coded INR', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'), false, '$');
    expect(data[0]?.entries[0]?.amount?.currency).toBe('$');
  });

  it('handles a non-numeric voucher number', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'));
    // Kept as a string: "MT/2026/0042" is a perfectly ordinary Tally number.
    expect(data[1]?.voucherNumber).toBe('MT/2026/0042');
  });

  it('reads ledger entries with the side Tally assigned them', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'));
    const entries = data[0]?.entries ?? [];

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      ledgerName: 'Northwind Retail Limited',
      amount: { amount: '-150505.05', currency: 'INR' },
      side: 'debit',
    });
    expect(entries[1]).toEqual({
      ledgerName: 'HDFC Bank Current A/c',
      amount: { amount: '150505.05', currency: 'INR' },
      side: 'credit',
    });
  });

  it('reads a three-entry voucher without dropping the tax line', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'));
    const entries = data[1]?.entries ?? [];

    expect(entries.map((e) => e.ledgerName)).toEqual([
      'Bramley & Sons Accessories Private Limited',
      'Sales - Domestic',
      'Output IGST',
    ]);
  });

  /**
   * <GSTCLASS>&#4; Not Applicable</GSTCLASS> appears verbatim in real exports.
   * The sanitiser strips the control reference; this asserts the voucher still
   * parses afterwards rather than the whole day book failing on one field.
   */
  it('survives the &#4; control reference Tally embeds in entry fields', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'));
    expect(data[0]?.entries[0]?.ledgerName).toBe('Northwind Retail Limited');
  });

  it('reads a narration and reports an empty one as null', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'));

    expect(data[0]?.narration).toContain('NEFT/FAKEREF0000001');
    expect(data[1]?.narration).toBeNull();
  });

  it('prefers the GUID as identity', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'));
    expect(data[0]?.guid).toBe('00000000-1111-2222-3333-444444444444-00000af3');
  });

  it('reports no warnings for a clean export', () => {
    expect(normalizeVouchers(fixture('day-book.xml')).warnings).toEqual([]);
  });
});

describe('double-entry invariant', () => {
  /**
   * Every voucher's entries must sum to zero. This is the strongest available
   * check that amounts and their signs survived parsing intact — a misread
   * digit, a dropped entry or a flipped sign all break it, and none of those
   * would be caught by asserting on individual fields.
   *
   * Verified against the unredacted originals too: all 30 vouchers in the real
   * July 2026 register balance, and the real trial balance nets to exactly
   * 0.00 across a debit and credit column of 135,555,995.89 each.
   */
  it('every voucher balances to zero', () => {
    const { data } = normalizeVouchers(fixture('day-book.xml'));
    expect(data.length).toBeGreaterThan(0);

    for (const voucher of data) {
      const total = voucher.entries.reduce(
        (sum, entry) => sum.plus(entry.amount?.amount ?? 0),
        new Decimal(0)
      );
      expect(total.toFixed(2), `voucher ${voucher.voucherNumber ?? '?'} does not balance`).toBe(
        '0.00'
      );
    }
  });
});

describe('warnings rather than invented values', () => {
  it('reports an unreadable amount as null and says so', () => {
    const xml = `<ENVELOPE><DATA><COLLECTION>
      <LEDGER NAME="Broken"><CLOSINGBALANCE TYPE="Amount">not a number</CLOSINGBALANCE></LEDGER>
    </COLLECTION></DATA></ENVELOPE>`;
    const { data, warnings } = normalizeLedgers(xml);

    expect(data[0]?.closingBalance).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/closing balance of "Broken"/);
  });

  it('reports an unreadable voucher date rather than guessing one', () => {
    const xml = `<ENVELOPE><DATA><TALLYMESSAGE>
      <VOUCHER VCHTYPE="Payment"><DATE>notadate</DATE><VOUCHERNUMBER>7</VOUCHERNUMBER></VOUCHER>
    </TALLYMESSAGE></DATA></ENVELOPE>`;
    const { data, warnings } = normalizeVouchers(xml);

    expect(data[0]?.date).toBeNull();
    expect(warnings[0]).toMatch(/unreadable date "notadate"/);
  });

  it('flags a report row that arrived with no amount block', () => {
    const xml = `<ENVELOPE>
      <DSPACCNAME><DSPDISPNAME>Orphan</DSPDISPNAME></DSPACCNAME>
    </ENVELOPE>`;
    const { data, warnings } = normalizeTrialBalance(xml);

    expect(data[0]).toEqual({ name: 'Orphan', debit: null, credit: null });
    expect(warnings[0]).toMatch(/no amount block/);
  });
});

describe('non-data payloads', () => {
  it('refuses the liveness reply instead of reporting an empty result set', () => {
    // Reporting "0 ledgers" here would look like an empty company rather than
    // a request Tally never treated as a data request.
    expect(() => normalizeLedgers('<RESPONSE>TallyPrime Server is Running</RESPONSE>')).toThrow(
      TallyError
    );
  });

  it('propagates a LINEERROR as a TallyError', () => {
    expect(() =>
      normalizeLedgers('<ENVELOPE><LINEERROR>Could not find description</LINEERROR></ENVELOPE>')
    ).toThrow(TallyError);
  });
});
