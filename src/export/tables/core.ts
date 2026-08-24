import type { Money } from '../../utils/numbers.js';
import type { CompanyData } from '../collect.js';

/**
 * Turning normalised records into sheets — and nothing else.
 *
 * ## Pure on purpose
 *
 * No TallyPrime access, no filesystem, no clock. Every function here takes
 * records and returns `{ title, columns, rows }`, so what a column MEANS can be
 * tested against hand-built records rather than against whatever a live company
 * happens to hold. That is the difference between a test that proves the
 * `Voucher entries` debit column is a debit and a test that proves the export
 * did not crash.
 *
 * ## Human-readable is a requirement, not a polish item
 *
 * Real column headings, not Tally's tag names: `Voucher number`, never
 * `VOUCHERNUMBER`. Someone opens this in Google Sheets and reads it; so does
 * Claude, and a heading is the only thing telling either of them what a column
 * is.
 */
import {
  amount,
  byName,
  flag,
  isoDate,
  orderedVouchers,
  type CellValue,
  type Column,
  type Table,
  varyingFieldKeys,
} from './shared.js';

/**
 * The core tables: trial balance, ledger balances, vouchers, entries,
 * receivables and payables, and the two statements.
 *
 * Split out of tables.ts at 1,309 lines. These are the sheets an accountant
 * opens first, which is why they are the ones held together.
 */

export function trialBalanceTable(data: CompanyData): Table {
  return {
    title: 'Trial balance',
    description:
      "TallyPrime's own Trial Balance. Debit and credit columns as Tally reports them — see " +
      'the Manifest for the sign convention and for the stock-at-opening caveat.',
    columns: [
      { header: 'Name', kind: 'text' },
      { header: 'Debit', kind: 'amount' },
      { header: 'Credit', kind: 'amount' },
    ],
    rows: (data.trialBalance.rows as { name: string; debit: Money | null; credit: Money | null }[]).map(
      (row) => [row.name, amount(row.debit), amount(row.credit)]
    ),
  };
}

export function ledgerBalancesTable(data: CompanyData): Table {
  return {
    title: 'Ledger balances',
    description:
      'Every ledger with its group and its opening and closing balance, from the ledger ' +
      'MASTERS. A negative balance is a debit in Tally\'s own encoding, passed through.',
    columns: [
      { header: 'Ledger', kind: 'text' },
      { header: 'Parent group', kind: 'text' },
      { header: 'Opening balance', kind: 'amount' },
      { header: 'Closing balance', kind: 'amount' },
      { header: 'Currency', kind: 'text' },
      { header: 'GSTIN', kind: 'text' },
      { header: 'Marked related party in Tally', kind: 'flag' },
    ],
    rows: [...data.ledgers].sort((a, b) => byName(a.name, b.name)).map((ledger) => [
      ledger.name,
      ledger.parent,
      amount(ledger.openingBalance),
      amount(ledger.closingBalance),
      ledger.closingBalance?.currency ?? ledger.openingBalance?.currency ?? data.currency.label,
      ledger.gstin,
      flag(ledger.isRelatedParty),
    ]),
  };
}

export function vouchersTable(data: CompanyData): Table {
  const { keys } = varyingFieldKeys(data.vouchers);
  const vouchers = orderedVouchers(data.vouchers);

  return {
    title: 'Vouchers',
    description:
      'One row per voucher. The four exclusion flags decide which vouchers belong in which ' +
      'question — read the Manifest before totalling this tab.',
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher type', kind: 'text' },
      { header: 'Voucher number', kind: 'text' },
      { header: 'Party', kind: 'text' },
      { header: 'Narration', kind: 'text' },
      { header: 'Entry lines', kind: 'count' },
      // The four traps. Named in full because a reader has to be able to filter
      // on them without knowing Tally's vocabulary.
      { header: 'Cancelled', kind: 'flag' },
      { header: 'Optional', kind: 'flag' },
      { header: 'Order voucher', kind: 'flag' },
      { header: 'Inventory voucher', kind: 'flag' },
      { header: 'Last written', kind: 'stamp' },
      { header: 'GUID', kind: 'text' },
      ...keys.map((key): Column => ({ header: key, kind: 'text' })),
    ],
    rows: vouchers.map((voucher) => [
      isoDate(voucher.date),
      voucher.voucherType,
      voucher.voucherNumber,
      voucher.partyLedgerName,
      voucher.narration,
      voucher.entries.length,
      flag(voucher.isCancelled),
      flag(voucher.isOptional),
      flag(voucher.isOrderVoucher),
      flag(voucher.isInventoryVoucher),
      voucher.lastWrittenAt,
      voucher.guid,
      ...keys.map((key) => voucher.fields?.[key] ?? null),
    ]),
  };
}

export function voucherEntriesTable(data: CompanyData): Table {
  const rows: CellValue[][] = [];

  // Same voucher order as the Vouchers tab. Entries WITHIN a voucher keep the
  // order Tally recorded them in — that is the order they were posted, and
  // re-sorting them would separate a debit from the credit it pairs with.
  for (const voucher of orderedVouchers(data.vouchers)) {
    for (const entry of voucher.entries) {
      const value = amount(entry.amount);
      // Split into two columns from Tally's OWN debit flag, not from the sign
      // of the amount. The two agree in every response observed, but the flag
      // is what Tally treats as authoritative — and a column derived from a
      // sign would silently disagree the first time they part company.
      const debit = entry.side === 'debit' ? value : null;
      const credit = entry.side === 'credit' ? value : null;

      rows.push([
        isoDate(voucher.date),
        voucher.voucherType,
        voucher.voucherNumber,
        entry.ledgerName,
        debit,
        credit,
        value,
        voucher.lastWrittenAt,
        flag(voucher.isCancelled),
        flag(voucher.isOptional),
        voucher.guid,
      ]);
    }
  }

  return {
    title: 'Voucher entries',
    description:
      'One row per LEDGER LINE — this is the expense and income detail. Debit and credit are ' +
      "split from Tally's own debit flag; \"Amount\" is the signed figure Tally sent, unmodified.",
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher type', kind: 'text' },
      { header: 'Voucher number', kind: 'text' },
      { header: 'Ledger', kind: 'text' },
      { header: 'Debit', kind: 'amount' },
      { header: 'Credit', kind: 'amount' },
      { header: 'Amount as Tally sent it', kind: 'amount' },
      // Text, not a date: Tally writes `YYYY-MM-DDTHH:MM:SS` with no timezone,
      // and turning it into a Date would attach one that nobody recorded.
      { header: 'Last written', kind: 'stamp' },
      { header: 'Voucher cancelled', kind: 'flag' },
      { header: 'Voucher optional', kind: 'flag' },
      { header: 'Voucher GUID', kind: 'text' },
    ],
    rows,
  };
}

function outstandingTable(
  title: string,
  description: string,
  side: CompanyData['receivables']
): Table {
  // Bucket labels come from the first party that has any. They are the same
  // boundaries for every party — computed once in executeOutstanding — so
  // reading them off one row is not a guess.
  const bucketLabels =
    side.rows.find((row) => row.ageing !== undefined)?.ageing?.buckets.map((b) => b.label) ?? [];

  return {
    title,
    description,
    columns: [
      { header: 'Party', kind: 'text' },
      { header: 'Group', kind: 'text' },
      { header: 'Closing balance', kind: 'amount' },
      { header: 'Bills recorded', kind: 'count' },
      ...bucketLabels.map((label): Column => ({ header: label, kind: 'amount' })),
      // The admitted gaps, carried as columns rather than buried. A bucket row
      // that silently omitted undated bills would read as a complete schedule.
      { header: 'Could not be aged (no date)', kind: 'amount' },
      { header: 'On account (no bill reference)', kind: 'amount' },
    ],
    rows: [...side.rows].sort((a, b) => byName(a.party, b.party)).map((row) => {
      const byLabel = new Map(
        (row.ageing?.buckets ?? []).map((bucket) => [bucket.label, amount(bucket.amount)])
      );
      return [
        row.party,
        row.group,
        amount(row.closingBalance),
        row.bills.length,
        ...bucketLabels.map((label) => byLabel.get(label) ?? null),
        amount(row.ageing?.undated.amount),
        amount(row.ageing?.unreferenced.amount),
      ];
    }),
    emptyMeans:
      'No ledgers were filed under the groups this side uses. That means the company files ' +
      'its parties elsewhere, not that it has none — see the Manifest warnings.',
  };
}

export function receivablesTable(data: CompanyData): Table {
  return outstandingTable(
    'Receivables',
    'Money owed TO the company, per party, with a bucketed ageing schedule. The buckets are ' +
      'BILL AGE, not days overdue — the Manifest states the basis and its coverage limit.',
    data.receivables
  );
}

export function payablesTable(data: CompanyData): Table {
  return outstandingTable(
    'Payables',
    'Money the company OWES, per party, with a bucketed ageing schedule. The buckets are ' +
      'BILL AGE, not days overdue — the Manifest states the basis and its coverage limit.',
    data.payables
  );
}

function statementTable(
  title: string,
  description: string,
  statement: CompanyData['profitLoss']
): Table {
  return {
    title,
    description,
    columns: [
      { header: 'Name', kind: 'text' },
      { header: 'Amount', kind: 'amount' },
      { header: 'Sub-amount', kind: 'amount' },
    ],
    rows: (statement.rows as { name: string; amount: Money | null; subAmount: Money | null }[]).map(
      (row) => [row.name, amount(row.amount), amount(row.subAmount)]
    ),
  };
}

export function profitLossTable(data: CompanyData): Table {
  return statementTable(
    'Profit and loss',
    'As TallyPrime presents it. Income arrives positive and expenses negative — Tally\'s own ' +
      'encoding, preserved. Nothing here is recomputed.',
    data.profitLoss
  );
}

export function balanceSheetTable(data: CompanyData): Table {
  return statementTable(
    'Balance sheet',
    'As TallyPrime presents it. Liabilities arrive positive and assets negative — Tally\'s own ' +
      'encoding, preserved. Nothing here is recomputed.',
    data.balanceSheet
  );
}
