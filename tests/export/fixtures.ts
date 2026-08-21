import type { CompanyData } from '../../src/export/collect.js';
import type { Voucher, Ledger } from '../../src/tally/normalize.js';

/**
 * Hand-built records, so a column's MEANING can be asserted.
 *
 * Deliberately not fixtures captured from a live company: the point of these
 * tests is that the debit column is a debit and the date column is a date, and
 * that only holds if the input is something a person wrote down on purpose.
 */

export function money(amount: string, currency = 'USD'): { amount: string; currency: string } {
  return { amount, currency };
}

export function voucher(over: Partial<Voucher> = {}): Voucher {
  return {
    guid: 'guid-1',
    date: '2026-07-15',
    voucherType: 'Sales',
    voucherNumber: 'INV-1',
    partyLedgerName: 'ACME Ltd',
    narration: 'Sale of goods',
    isCancelled: false,
    isOptional: false,
    isOrderVoucher: false,
    isInventoryVoucher: false,
    lastWrittenAt: '2026-07-16T09:30:00',
    entries: [
      { ledgerName: 'ACME Ltd', amount: money('-1000.00'), side: 'debit' },
      { ledgerName: 'Sales', amount: money('1000.00'), side: 'credit' },
    ],
    source: { system: 'tallyprime', entityType: 'voucher', identifier: 'guid-1' },
    fields: { ISDELETED: 'No', REFERENCE: 'PO-9' },
    ...over,
  };
}

export function ledger(over: Partial<Ledger> = {}): Ledger {
  return {
    name: 'ACME Ltd',
    parent: 'Sundry Debtors',
    openingBalance: money('-500.00'),
    closingBalance: money('-1500.00'),
    gstin: null,
    isRelatedParty: false,
    source: { system: 'tallyprime', entityType: 'ledger', identifier: 'ACME Ltd' },
    fields: { ISDELETED: 'No', BILLCREDITPERIOD: '30 Days' },
    ...over,
  };
}

/** A whole company, minimally populated but structurally complete. */
export function companyData(over: Partial<CompanyData> = {}): CompanyData {
  const vouchers = [
    voucher(),
    voucher({
      guid: 'guid-2',
      voucherNumber: 'SO-1',
      voucherType: 'Sales Order',
      isOrderVoucher: true,
      entries: [],
      fields: { ISDELETED: 'No', REFERENCE: 'PO-10' },
    }),
  ];

  const statement = (rows: unknown[]): CompanyData['profitLoss'] => ({
    statement: 'profit_loss',
    period: { fromDate: '2026-04-01', toDate: '2027-03-31' },
    coversPeriodRequested: true,
    figuresActuallyCover: null,
    rows,
    warnings: [],
    comparison: null,
    figuresOf: () => [],
  });

  return {
    company: {
      name: 'EXAMPLE TRADING PRIVATE LIMITED',
      startingFrom: '2021-04-01',
      endingAt: '2026-07-31',
      currency: '$',
      country: 'United States of America',
      source: { system: 'tallyprime', entityType: 'company', identifier: 'EXAMPLE' },
    },
    currency: { label: 'USD', source: 'tally', comparable: true },
    // The voucher tabs now span every book year the company holds, so the
    // fixture's voucher period starts before the statement period on purpose.
    period: { fromDate: '2021-04-01', toDate: '2027-03-31' },
    statementPeriod: { fromDate: '2026-04-01', toDate: '2027-03-31' },
    asOf: '2026-08-19T12:00:00.000Z',
    vouchers,
    ledgers: [ledger(), ledger({ name: 'Sales', parent: 'Sales Accounts' })],
    groups: [
      {
        name: 'Sundry Debtors',
        parent: 'Current Assets',
        isRevenue: false,
        isDeemedPositive: true,
        source: { system: 'tallyprime', entityType: 'group', identifier: 'Sundry Debtors' },
      },
    ],
    voucherTypes: [
      { name: 'Sales', parent: 'Sales', numberingSeries: [], isDeemedPositive: false },
    ],
    stockItems: [],
    currencies: [{ name: '$', formalName: 'US Dollar', decimalPlaces: '2' }],
    trialBalance: statement([
      { name: 'Sundry Debtors', debit: money('-1500.00'), credit: null },
    ]),
    profitLoss: statement([{ name: 'Sales Accounts', amount: money('1000.00'), subAmount: null }]),
    balanceSheet: statement([
      { name: 'Current Assets', amount: money('-1500.00'), subAmount: null },
    ]),
    receivables: {
      side: 'receivable',
      period: { fromDate: '2026-04-01', toDate: '2027-03-31' },
      groupsUsed: ['Sundry Debtors'],
      ageingBasis: null,
      rows: [
        {
          party: 'ACME Ltd',
          group: 'Sundry Debtors',
          closingBalance: money('-1500.00'),
          bills: [],
        },
      ],
      warnings: [],
    },
    payables: {
      side: 'payable',
      period: { fromDate: '2026-04-01', toDate: '2027-03-31' },
      groupsUsed: ['Sundry Creditors'],
      ageingBasis: null,
      rows: [],
      warnings: [],
    },
    closingStock: {
      basis: 'TallyPrime Stock Summary report',
      groupedBy: 'Stock item',
      rows: [],
      warnings: [],
    },
    godowns: null,
    cashFlow: null,
    fundsFlow: null,
    reports: [],
    statementsByYear: [],
    simpleMasters: [],
    warnings: ['A warning TallyPrime produced during this run.'],
    ...over,
  };
}
