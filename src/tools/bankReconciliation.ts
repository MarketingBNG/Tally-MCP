import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Voucher } from '../tally/normalize.js';
import { TallyError } from '../tally/TallyError.js';
import { toMoney, type Money } from '../utils/numbers.js';
import { tallyDateToIso } from '../utils/dates.js';
import { matchesText } from '../utils/text.js';
import {
  companySchema,
  dateRangeSchema,
  paginationSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { paginate, resolvePagination } from '../utils/pagination.js';
import { foldUniformFields, uniformFieldsNote } from '../utils/uniformFields.js';
import {
  assertResultSetFits,
  fromPage,
  noteEmptyDefaultedPeriod,
  periodWasDefaulted,
  resolvePeriodForCompany,
  runTool,
  type ToolDeps,
} from './toolResult.js';
import { fetchVouchers } from './vouchers.js';

/**
 * Bank reconciliation: the bank instrument detail TallyPrime records on
 * payment and receipt entries, and whether each one has been reconciled.
 *
 * ## Why this is derived from vouchers rather than a report
 *
 * TallyPrime has its own Bank Reconciliation screen, but its export ID is not
 * confirmed against a live install, and a wrong report or collection ID here is
 * not a failed query — it raises a modal on the user's desktop and can take
 * TallyPrime down with their unsaved books (docs/known-limitations.md, "A
 * malformed request can terminate TallyPrime"). The same reasoning that makes
 * `tally_get_inventory_movements` derive from voucher inventory lines applies
 * here: the data is already inside the voucher register, which is verified, so
 * there is nothing to gain by guessing an ID.
 *
 * Every bank entry Tally records carries a `BANKALLOCATIONS.LIST` structure
 * holding the instrument detail — transaction type, instrument date, favouring
 * name, IFSC, transaction id — and that is what this reads.
 *
 * ## How reconciled status is determined, and when it refuses to guess
 *
 * TallyPrime marks an entry reconciled by stamping the date it appeared on the
 * bank statement into `BANKERSDATE`. Unreconciled entries leave it empty, and
 * the parser drops empty elements — so on a reconciled entry the field is
 * present, and on an unreconciled one it is absent.
 *
 * Absence alone is therefore ambiguous: it means "not reconciled" only if this
 * Tally reports the field at all. So the whole result set is inspected first. If
 * at least one row carries a bank date, the field is confirmed live and absence
 * on the others genuinely means unreconciled. If NO row carries one, the status
 * is reported as `null` rather than `false` on every row, with a warning — and a
 * request that filtered on status fails outright rather than returning a
 * confidently wrong list of "unreconciled" items that is really just every bank
 * entry in the period.
 */

/**
 * The field TallyPrime stamps with the bank statement date on reconciliation.
 *
 * An exact name, observed in real voucher data, NOT a name fragment. Fragment
 * matching is what produced the GST false positives recorded in
 * docs/known-limitations.md, and here a false positive would report an
 * unreconciled payment as cleared — the one error that makes this tool worse
 * than nothing.
 */
const BANK_DATE_FIELD = 'BANKERSDATE';

/** Tally's own tag for the instrument structure on a bank ledger entry. */
const BANK_ALLOCATIONS = 'BANKALLOCATIONS.LIST';

/**
 * Cash-denomination counters, dropped from the instrument map when they are zero.
 *
 * TallyPrime stamps eleven of these on every bank instrument — including one for
 * the demonetised ₹2,000 note — whether or not any cash is involved. Measured on
 * a live company: 2,200 such keys across 200 cheque and wire instruments,
 * **every one of them zero**, accounting for 24% of the response. That is a
 * quarter of a payload with a hard size ceiling spent on counters for notes
 * nobody counted, and a quarter more text for a model to read past.
 *
 * A NON-ZERO counter is kept. That is the whole point of matching on the value
 * rather than the name: a genuine denomination breakdown on a cash transaction is
 * real data and is never dropped. Only the scaffolding goes, and the tool
 * description says so, because silently trimming a field a caller can see in
 * TallyPrime would be worse than the bloat.
 */
const DENOMINATION_PREFIX = 'DENOMINATIONCOUNT';

/**
 * Drop zero-valued denomination counters, keeping every other field verbatim.
 *
 * Returns the original object when nothing was dropped, so the common path
 * allocates nothing.
 */
function withoutEmptyDenominations(fields: Record<string, string>): Record<string, string> {
  const dropped = Object.keys(fields).filter(
    (key) => key.startsWith(DENOMINATION_PREFIX) && Number(fields[key]) === 0
  );
  if (dropped.length === 0) return fields;

  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!dropped.includes(key)) kept[key] = value;
  }
  return kept;
}

const statusSchema = z
  .enum(['all', 'reconciled', 'unreconciled'])
  .optional()
  .describe(
    'Filter by reconciliation status. Defaults to "all". "unreconciled" is the usual ' +
      'month-end question: what has been entered in the books but not yet appeared on the bank ' +
      'statement. Fails with TALLY_UNSUPPORTED_OPERATION if this company records no bank dates ' +
      'at all, rather than returning every bank entry as though none were reconciled.'
  );

const DESCRIPTION = [
  'Bank instrument detail and reconciliation status for a period — cheques, NEFT/RTGS transfers ' +
    'and other bank transactions, with whether each has been reconciled against the statement.',
  '',
  'WHEN TO USE: month-end bank reconciliation — what has not cleared, which cheques are ' +
    'outstanding. To trace one payment by cheque or UTR number, tally_get_vouchers with fieldMatch ' +
    'is better.',
  '',
  'RETURNS: one row per instrument — bank ledger, voucher date/type/number, party, narration, the ' +
    'ledger entry amount, the instrument amount where Tally records one separately, the ' +
    'reconciliation date, `reconciled`, and `instrument` holding every field Tally keeps under its ' +
    'own names (TRANSACTIONTYPE, INSTRUMENTDATE, IFSCODE, ...). Which fields exist depends on the ' +
    'company, so read `instrument` rather than expecting a fixed set.',
  '',
  'INSTRUMENT FIELDS ARE IN TWO PLACES: a field identical on every instrument in the page is ' +
    'reported once as `uniformFields` instead of on each row. Check there before concluding a ' +
    'field is absent, and read a constant value as a TallyPrime default rather than something the ' +
    'company recorded.',
  '',
  'Zero-valued cash denomination counters are dropped; a NON-ZERO one is always kept, since on a ' +
    'cash transaction it is real data. Nothing else is filtered.',
  '',
  'RECONCILED STATUS — read before reporting anything as uncleared. Tally marks an entry ' +
    'reconciled by recording the bank statement date on it. `true` means it holds that date, in ' +
    '`bankDate`. `false` means no date, in a company that does record them elsewhere. `null` means ' +
    'this company records no bank dates at all in the period, so the status is UNKNOWN and must ' +
    'NOT be reported as unreconciled. Never present a null as a false.',
  '',
  'BALANCES ARE NOT RECONCILED HERE: this lists instruments and their status. It does not compute ' +
    'book balance against bank balance — that needs a rule about which side each uncleared item ' +
    'falls on, which is an accounting judgement. Use tally_get_masters type "ledger" for the book balance and ' +
    'state your own basis.',
  '',
  'AMOUNTS: TallyPrime signs, unchanged — a payment out and a receipt in carry opposite signs. ' +
    '`entryAmount` is the ledger entry; `instrumentAmount` appears only where Tally records a ' +
    'separate figure, which happens when one entry is split across instruments. They are kept ' +
    'separate because on a split entry they legitimately differ.',
  '',
  'SOURCE: the instrument detail nested on vouchers in the period, not TallyPrime own Bank ' +
    'Reconciliation report. Consequence: an instrument on a voucher OUTSIDE the period does not ' +
    'appear even if still uncleared. To find old uncleared cheques, widen the range.',
  '',
  PERIOD_NOTE,
  '',
  'PAGINATION: client-side over a full fetch of the period.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

export interface BankInstrumentRow {
  /** The bank ledger the entry was posted to. */
  bankLedger: string;
  /** Voucher date, ISO. Null when Tally reported an unreadable one. */
  voucherDate: string | null;
  voucherType: string | null;
  voucherNumber: string | null;
  /** The counterparty on the voucher, where one is recorded. */
  party: string | null;
  narration: string | null;
  /** The amount on the bank ledger entry, Tally's sign preserved. */
  entryAmount: Money | null;
  /**
   * The instrument's own amount, where Tally records one separately — it does
   * when a single entry is split across instruments. Absent otherwise.
   */
  instrumentAmount?: Money | null;
  /**
   * The bank statement date Tally recorded on reconciliation, ISO where it
   * parses. Null when the entry carries none.
   */
  bankDate: string | null;
  /**
   * True when Tally holds a bank date for this entry. False when it does not,
   * in a company that records them elsewhere. NULL when no bank date appears
   * anywhere in the period, so the status is genuinely unknown.
   */
  reconciled: boolean | null;
  /** Instrument date as recorded, ISO where it parses. */
  instrumentDate: string | null;
  /** Every field Tally holds on the instrument, verbatim under its own names. */
  instrument: Record<string, string>;
}

/** ISO where the value is a Tally date, otherwise the raw string, otherwise null. */
function isoOrRaw(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  return tallyDateToIso(raw) ?? raw;
}

/**
 * Flatten every bank instrument on a period's vouchers into rows.
 *
 * `reconciled` is left undecided here and filled in by the caller, because it
 * depends on whether the bank date field appears anywhere in the whole result —
 * a judgement no single row can make about itself.
 */
export function extractBankInstruments(
  vouchers: readonly Voucher[]
): Omit<BankInstrumentRow, 'reconciled'>[] {
  const rows: Omit<BankInstrumentRow, 'reconciled'>[] = [];

  for (const voucher of vouchers) {
    for (const entry of voucher.entries) {
      for (const allocation of entry.nested?.[BANK_ALLOCATIONS] ?? []) {
        const fields = allocation.fields;
        // Same currency as the entry the instrument hangs off, never a default.
        const instrumentAmount = toMoney(fields.AMOUNT ?? null, entry.amount?.currency);

        rows.push({
          // The bank ledger is the entry's own ledger, not the voucher party:
          // on a payment the party is the supplier and the bank is the entry
          // the instrument hangs off.
          bankLedger: entry.ledgerName,
          voucherDate: voucher.date,
          voucherType: voucher.voucherType,
          voucherNumber: voucher.voucherNumber,
          party: voucher.partyLedgerName,
          narration: voucher.narration,
          entryAmount: entry.amount,
          ...(instrumentAmount === null ? {} : { instrumentAmount }),
          bankDate: isoOrRaw(fields[BANK_DATE_FIELD]),
          instrumentDate: isoOrRaw(fields.INSTRUMENTDATE),
          instrument: withoutEmptyDenominations(fields),
        });
      }
    }
  }

  return rows;
}

export function registerBankReconciliationTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_get_bank_reconciliation',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        bankLedger: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Restrict to bank ledgers whose name contains this text, case-insensitive — e.g. ' +
              '"HDFC". Omit to cover every bank ledger with instrument detail in the period. Use ' +
              'tally_get_masters type "ledger" with the "Bank Accounts" group to see the names available.'
          ),
        status: statusSchema,
        instrumentMatch: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Match this text against the value of any field on the instrument — cheque number, ' +
              'UTR, transaction id, favouring name. Case-insensitive substring. Which field holds ' +
              'a reference varies by company, so matching values is more reliable than naming a ' +
              'field.'
          ),
        company: companySchema,
        ...dateRangeSchema,
        ...paginationSchema,
      }),
    },
    async (args) =>
      runTool('tally_get_bank_reconciliation', deps, async () => {
        const period = await resolvePeriodForCompany(deps, args.fromDate, args.toDate, args.company);
        const pagination = resolvePagination(args.page, args.pageSize);

        // Full detail: the instrument structure is nested on the entry, so
        // there is no cheaper fetch that carries it.
        const { vouchers, warnings: voucherWarnings } = await fetchVouchers(
          deps,
          args.company,
          period,
          // Nested only. This tool reads bank allocations and no scalar voucher field, so
          // asking for every field would cost 18.3MB to use none of it.
          false,
          true
        );

        const extracted = extractBankInstruments(vouchers);

        // Whether this company records bank dates at all — decided over every
        // instrument in the period, before any filter narrows the set, so a
        // filter cannot change what "unreconciled" means.
        const bankDatesReported = extracted.some((row) => row.bankDate !== null);

        const requestedStatus = args.status ?? 'all';
        if (!bankDatesReported && requestedStatus !== 'all' && extracted.length > 0) {
          throw new TallyError(
            'TALLY_UNSUPPORTED_OPERATION',
            `No bank entry in ${period.fromDate} to ${period.toDate} carries a bank statement date, so reconciliation status cannot be determined and a "${requestedStatus}" filter cannot be honoured.`,
            {
              suggestion:
                'Call again with status "all" to see every bank instrument in the period, and treat ' +
                'their status as unknown. Either nothing in this period has been reconciled in ' +
                'TallyPrime yet, or this company does not use the reconciliation feature. Returning ' +
                'them all as "unreconciled" would state the first as fact.',
              context: { period, instrumentsFound: extracted.length },
            }
          );
        }

        const rows: BankInstrumentRow[] = extracted.map((row) => ({
          ...row,
          reconciled: bankDatesReported ? row.bankDate !== null : null,
        }));

        let matches = rows;
        if (args.bankLedger !== undefined) {
          matches = matches.filter((row) => matchesText(args.bankLedger as string, row.bankLedger));
        }
        if (args.instrumentMatch !== undefined) {
          matches = matches.filter((row) =>
            matchesText(args.instrumentMatch as string, ...Object.values(row.instrument))
          );
        }
        if (requestedStatus === 'reconciled') {
          matches = matches.filter((row) => row.reconciled === true);
        } else if (requestedStatus === 'unreconciled') {
          matches = matches.filter((row) => row.reconciled === false);
        }

        assertResultSetFits(
          matches.length,
          deps.config,
          'Narrow the date range, or filter to one bank ledger.'
        );

        // The instrument map is the same "populated but constant" problem as
        // voucher fields: STATUS, PAYMENTMODE, ISSPLIT, ISCONNECTEDPAYMENT and
        // friends were identical on all 200 instruments of a real year. Folded
        // after pagination so the claim is about the page returned.
        const page = paginate(matches, pagination, []);
        const folded = foldUniformFields(
          page.items,
          (row) => row.instrument,
          (row, instrument) => ({ ...row, instrument })
        );

        const warnings = [
          ...(await noteEmptyDefaultedPeriod(deps, period, periodWasDefaulted(args.fromDate, args.toDate), vouchers.length, args.company)),
          ...voucherWarnings,
        ];

        if (!bankDatesReported && extracted.length > 0) {
          warnings.push(
            `No bank entry in this period carries a ${BANK_DATE_FIELD} value, so "reconciled" is ` +
              'null on every row and the reconciliation status is UNKNOWN, not "unreconciled". ' +
              'Either nothing here has been reconciled in TallyPrime, or this company does not use ' +
              'the reconciliation feature. Do not report these as uncleared items without saying ' +
              'the status could not be read.'
          );
        }

        if (extracted.length === 0 && vouchers.length > 0) {
          warnings.push(
            'The period has vouchers but none carry bank instrument detail. TallyPrime records ' +
              'that structure when a bank ledger entry has a transaction type set (cheque, NEFT, ' +
              'RTGS and so on); a company entering bank payments without one records no ' +
              'instrument at all. This is a real answer about how the books are kept, not a ' +
              'retrieval failure.'
          );
        }

        if (Object.keys(folded.uniformFields).length > 0) {
          warnings.push(
            uniformFieldsNote(
              Object.keys(folded.uniformFields).length,
              folded.foldedOccurrences,
              'instrument'
            )
          );
        }

        return fromPage(
          { ...page, items: folded.records, warnings },
          {
            period,
            status: requestedStatus,
            ...(Object.keys(folded.uniformFields).length > 0
              ? { uniformFields: folded.uniformFields }
              : {}),
            ...(args.bankLedger === undefined ? {} : { bankLedger: args.bankLedger }),
            ...(args.instrumentMatch === undefined
              ? {}
              : { instrumentMatch: args.instrumentMatch }),
            /**
             * Stated in the payload, not only in a warning: whether the status
             * column can be trusted is a property of the answer, and a caller
             * reading `reconciled` should not have to parse prose to learn it.
             */
            reconciliationStatusAvailable: bankDatesReported,
          }
        );
      })
  );
}
