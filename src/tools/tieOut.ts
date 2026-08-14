import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  companySchema,
  dateRangeSchema,
  PERIOD_NOTE,
  READ_ONLY_NOTICE,
  UNTRUSTED_CONTENT_NOTICE,
} from '../schemas/common.js';
import { DEFAULT_CURRENCY, type Money } from '../utils/numbers.js';
import { bookYearFor } from '../utils/dates.js';
import { adaptAccounts, adaptVouchers } from '../model/fromTally.js';
import type { Account, SignedAmount, Voucher } from '../model/ledger.js';
import { buildCompanyListRequest } from '../tally/requests.js';
import { normalizeCompanies } from '../tally/normalize.js';
import { resolvePeriod, runTool, whole, type ToolDeps } from './toolResult.js';
import { fetchLedgers } from './ledgers.js';
import { fetchGroups } from './groups.js';
import { fetchVouchers } from './vouchers.js';

/**
 * Tie-out: does the arithmetic in these books actually hold?
 *
 * Build Specification v1.0 §1 makes this outcome 3 — "books tie" — and §4 L5
 * makes `tie_out_gate` a BLOCKING control: nothing goes to a client until it
 * passes. This tool is the first working piece of that gate, and it is the
 * cheapest one to build, because it needs no warehouse: both sides of the
 * comparison are already retrievable from TallyPrime.
 *
 * Two checks, deliberately independent of each other.
 *
 * 1. **Double entry.** Every voucher's debits must equal its credits. Needs no
 *    balances at all, so it works even where opening balances are missing, and
 *    an unbalanced voucher is a hard finding under any framework.
 *
 * 2. **Balance roll-forward.** For each ledger, opening balance plus the
 *    period's movements must equal the closing balance TallyPrime reports.
 *    This is the same arithmetic `tally_get_ledger_transactions` performs for
 *    a single ledger, applied across every ledger at once — which is what
 *    turns a spot check into a control.
 *
 * WRITTEN AGAINST THE MODEL, NOT AGAINST TALLY. Everything below operates on
 * `src/model/ledger.ts` types, reached through the adapter. That is not
 * ceremony: Annexure A §3.3 requires every audit test to be written once,
 * against the normalised model, and this is the first test to do it. When a
 * Zoho Books or QuickBooks adapter appears, this file should not need to
 * change at all. If it does, the model is wrong.
 *
 * NO LLM ARITHMETIC (§6 rule 1). Every figure here is computed in Decimal and
 * returned with the inputs that produced it, so the model reports a number it
 * was given rather than one it worked out.
 */

const DESCRIPTION = [
  'Check that the books tie: every voucher balances, and every ledger closing balance equals ' +
    'its opening balance plus the movements in the period.',
  '',
  'WHEN TO USE: before relying on ANY figure from these books for a report, a workpaper or a ' +
    'client deliverable. Run it first and quote the result. If it fails, the numbers from every ' +
    'other tool are suspect and should not be presented until the exceptions are explained.',
  '',
  'RETURNS: a pass/fail verdict, then counts of what was checked, then the exceptions ' +
    'themselves — unbalanced vouchers with the amount they are out by, and ledgers whose ' +
    'computed closing balance disagrees with the one TallyPrime reports, showing both figures ' +
    'and the difference.',
  '',
  'HOW THE COMPARISON WORKS, and its one real limitation: the closing balance TallyPrime ' +
    'reports for a ledger is as at TALLY OWN CURRENT PERIOD END, not the end of the range asked ' +
    'for here. So the roll-forward check is only meaningful when the range covers the company ' +
    'whole period. Given no dates, this tool defaults to the financial year the company books ' +
    'begin in — NOT the financial year containing today, which is what the other tools default ' +
    'to — because that is the range most likely to line up. Given explicit dates, it checks them ' +
    'and warns that a partial range will disagree for reasons that are not errors.',
  '',
  'NOT CHECKABLE is reported separately from FAILED, and the distinction matters: a ledger with ' +
    'no opening balance, or a voucher carrying an unreadable amount, cannot be verified either ' +
    'way. Counting those as passes would overstate the assurance this gives.',
  '',
  PERIOD_NOTE,
  '',
  'PAGINATION: not applicable — exceptions are returned in full, because a truncated exception ' +
    'register is not a control.',
  '',
  UNTRUSTED_CONTENT_NOTICE,
  '',
  READ_ONLY_NOTICE,
].join('\n');

/**
 * A signed amount as a single number, for arithmetic only.
 *
 * Debit positive, credit negative — the ordinary accounting convention, and
 * deliberately NOT Tally's (which encodes a debit as negative). Both sides of
 * every comparison below go through this same function, so the choice cancels
 * out; what matters is that it is applied once, consistently, and that nothing
 * signed ever leaves this module. Results are converted back to an explicit
 * side before they are returned.
 */
function asDecimal(amount: SignedAmount | null): Decimal | null {
  if (amount === null) return null;
  const magnitude = new Decimal(amount.magnitude.amount);
  return amount.side === 'debit' ? magnitude : magnitude.negated();
}

/** Back to the model's explicit-side form. */
function toSigned(value: Decimal, currency: string): SignedAmount {
  return {
    magnitude: { amount: value.abs().toFixed(), currency },
    side: value.isNegative() ? 'credit' : 'debit',
  };
}

export interface VoucherImbalance {
  voucherId: string;
  date: string | null;
  number: string | null;
  voucherType: string | null;
  /** How far off balance the voucher is. Never zero — a zero is not a finding. */
  outBy: SignedAmount;
  entryCount: number;
}

export interface BalanceException {
  account: string;
  path: string[];
  opening: SignedAmount | null;
  /** Opening plus this period's movements, computed here. */
  computedClosing: SignedAmount;
  /** What TallyPrime reports, as at its own period end. */
  reportedClosing: SignedAmount | null;
  difference: SignedAmount;
  movementCount: number;
}

/**
 * Check every voucher balances.
 *
 * A voucher whose entries cannot all be read is reported as not checkable
 * rather than as balanced: the entries that ARE readable might sum to zero by
 * coincidence, and calling that a pass would be a false assurance.
 */
export function checkDoubleEntry(vouchers: readonly Voucher[]): {
  imbalances: VoucherImbalance[];
  checked: number;
  notCheckable: string[];
} {
  const imbalances: VoucherImbalance[] = [];
  const notCheckable: string[] = [];
  let checked = 0;

  for (const voucher of vouchers) {
    // A cancelled voucher posts nothing, so it has no balancing obligation.
    // It is retained in the data and skipped here, not filtered upstream.
    if (voucher.isCancelled || voucher.lines.length === 0) continue;

    let total = new Decimal(0);
    let readable = true;
    let currency = DEFAULT_CURRENCY;

    for (const line of voucher.lines) {
      const value = asDecimal(line.amount);
      if (value === null) {
        readable = false;
        break;
      }
      currency = line.amount?.magnitude.currency ?? currency;
      total = total.plus(value);
    }

    if (!readable) {
      notCheckable.push(
        `Voucher ${voucher.number ?? voucher.id} carries an entry with an unreadable amount, so it cannot be confirmed to balance.`
      );
      continue;
    }

    checked += 1;
    if (!total.isZero()) {
      imbalances.push({
        voucherId: voucher.id,
        date: voucher.date,
        number: voucher.number,
        voucherType: voucher.sourceType,
        outBy: toSigned(total, currency),
        entryCount: voucher.lines.length,
      });
    }
  }

  return { imbalances, checked, notCheckable };
}

/**
 * Accounts whose closing balance TallyPrime DERIVES rather than posts, so
 * opening-plus-movements can never reconcile to it.
 *
 * Verified live 2026-08-13. `Stock In Hand` had a closing balance of 304,588
 * against an opening of 207,968 and **zero** ledger postings in the year — its
 * value comes from inventory valuation, not journal entries. `Profit & Loss A/c`
 * is reported by Tally as nil at both ends while its real figure is the
 * accumulation of the revenue and expense accounts.
 *
 * Reporting these as exceptions is a false positive on books that balance, and a
 * blocking control that cries wolf gets ignored. They belong in `notCheckable`:
 * the roll-forward test simply does not apply to them, which is a different
 * statement from "these books are out".
 */
function derivedBalanceReason(account: Account): string | null {
  // Tally pads its primary-group name with a leading space, so compare trimmed.
  const path = account.path.map((step) => step.trim().toLowerCase());

  if (path.includes('stock-in-hand')) {
    return 'its closing balance comes from inventory valuation rather than ledger postings, so opening plus movements cannot reconcile to it';
  }
  if (account.name.trim().toLowerCase() === 'profit & loss a/c') {
    return 'TallyPrime derives this account from the revenue and expense accounts rather than posting to it';
  }

  return null;
}

/**
 * Check opening + movements = closing, for every postable account.
 *
 * Only postable accounts are checked. A group heading carries no balance of
 * its own in this model, and rolling children up into it would be testing this
 * server's own summation rather than Tally's books.
 */
export function checkBalanceRollForward(
  accounts: readonly Account[],
  vouchers: readonly Voucher[]
): { exceptions: BalanceException[]; checked: number; notCheckable: string[] } {
  const exceptions: BalanceException[] = [];
  const notCheckable: string[] = [];
  let checked = 0;

  // Movements per account, accumulated once rather than re-scanned per
  // account: a mid-sized company has thousands of vouchers and hundreds of
  // ledgers, and the naive form is that product.
  const movements = new Map<string, { total: Decimal; count: number; readable: boolean }>();

  for (const voucher of vouchers) {
    if (voucher.isCancelled || voucher.isDraft) continue;

    for (const line of voucher.lines) {
      const key = line.accountId.toLowerCase();
      const entry = movements.get(key) ?? { total: new Decimal(0), count: 0, readable: true };
      const value = asDecimal(line.amount);

      if (value === null) entry.readable = false;
      else entry.total = entry.total.plus(value);

      entry.count += 1;
      movements.set(key, entry);
    }
  }

  for (const account of accounts) {
    if (!account.isPostable) continue;

    const derived = derivedBalanceReason(account);
    if (derived !== null) {
      notCheckable.push(`"${account.name}" cannot be rolled forward: ${derived}.`);
      continue;
    }

    const movement = movements.get(account.name.toLowerCase());
    const opening = asDecimal(account.openingBalance);
    const reported = asDecimal(account.closingBalance);
    const currency =
      account.openingBalance?.magnitude.currency ??
      account.closingBalance?.magnitude.currency ??
      DEFAULT_CURRENCY;

    if (opening === null || reported === null) {
      // Only worth reporting where there was activity — a dormant ledger with
      // no balances and no movements is not an audit finding, it is an empty
      // account, and listing every one of them would bury the real ones.
      if (movement !== undefined && movement.count > 0) {
        notCheckable.push(
          `"${account.name}" has ${String(movement.count)} movement(s) in the period but TallyPrime reported no ${opening === null ? 'opening' : 'closing'} balance, so it cannot be rolled forward.`
        );
      }
      continue;
    }

    if (movement?.readable === false) {
      notCheckable.push(
        `"${account.name}" has an entry with an unreadable amount, so its closing balance cannot be verified.`
      );
      continue;
    }

    checked += 1;

    const computed = opening.plus(movement?.total ?? new Decimal(0));
    const difference = computed.minus(reported);

    // To the paisa, per §1 outcome 3. No tolerance: a rounding allowance here
    // would be this server deciding what counts as immaterial, which is a
    // judgement reserved to the engagement team.
    if (!difference.isZero()) {
      exceptions.push({
        account: account.name,
        path: account.path,
        opening: account.openingBalance,
        computedClosing: toSigned(computed, currency),
        reportedClosing: account.closingBalance,
        difference: toSigned(difference, currency),
        movementCount: movement?.count ?? 0,
      });
    }
  }

  return { exceptions, checked, notCheckable };
}

/** Total of every imbalance, so the scale of the problem is visible at a glance. */
function sumOf(amounts: readonly SignedAmount[]): Money {
  const total = amounts.reduce(
    (running, amount) => running.plus(asDecimal(amount) ?? new Decimal(0)),
    new Decimal(0)
  );
  return {
    amount: total.abs().toFixed(),
    currency: amounts[0]?.magnitude.currency ?? DEFAULT_CURRENCY,
  };
}

export function registerTieOutTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'tally_check_tie_out',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        company: companySchema,
        ...dateRangeSchema,
      }),
    },
    async (args) =>
      runTool('tally_check_tie_out', deps, async () => {
        // Unlike every other tool, the default period here is the company's
        // own financial year rather than the one containing today. The
        // roll-forward compares against Tally's period-end closing balance, so
        // a range that does not cover the company's period disagrees for
        // reasons that are not errors — and this tool's whole value is that a
        // disagreement means something.
        const explicitDates = args.fromDate !== undefined || args.toDate !== undefined;
        let period = resolvePeriod(args.fromDate, args.toDate);
        const periodNotes: string[] = [];

        if (!explicitDates) {
          const response = await deps.client.send(buildCompanyListRequest(), 'standard');
          const company = normalizeCompanies(response.body).data[0];
          const startingFrom = company?.startingFrom ?? null;

          if (startingFrom === null) {
            periodNotes.push(
              'TallyPrime did not report when this company books begin, so the period defaults to the financial year containing today. If that is not the company own year, the roll-forward check below will report differences that are not errors.'
            );
          } else {
            // Anchored on the company's own start month, not on 1 April. A
            // company whose books run January to December gets its January year;
            // assuming April would pick a window that need not even contain the
            // company's own data, and this tool's entire value rests on the
            // period being the one Tally closed against.
            period = bookYearFor(startingFrom, company?.endingAt ?? startingFrom);
            periodNotes.push(
              `No dates were given, so this checked ${period.fromDate} to ${period.toDate} — the company's own book year, twelve months from the date its books begin.`
            );
          }
        } else {
          periodNotes.push(
            'Explicit dates were given. TallyPrime reported closing balances are as at its own period end, not the end of this range, so the balance roll-forward will show differences wherever the range does not cover the whole period. Those are not necessarily errors.'
          );
        }

        const [{ ledgers, warnings: ledgerWarnings }, { groups, warnings: groupWarnings }] =
          await Promise.all([fetchLedgers(deps, args.company), fetchGroups(deps, args.company)]);

        const { vouchers, warnings: voucherWarnings } = await fetchVouchers(
          deps,
          args.company,
          period
        );

        const entityId = args.company ?? 'loaded-company';
        const accounts = adaptAccounts(groups, ledgers, { entityId });
        const adapted = adaptVouchers(vouchers, { entityId });

        const doubleEntry = checkDoubleEntry(adapted.data);
        const rollForward = checkBalanceRollForward(accounts.data, adapted.data);

        const passed = doubleEntry.imbalances.length === 0 && rollForward.exceptions.length === 0;

        const warnings = [
          ...periodNotes,
          ...ledgerWarnings,
          ...groupWarnings,
          ...voucherWarnings,
          ...accounts.warnings,
          ...adapted.warnings,
        ];

        return whole(
          {
            /**
             * The gate. Spec §4 L5: a failure blocks output. This server
             * cannot enforce that, so it states it plainly instead and the
             * tool description tells Claude not to present figures over it.
             */
            passed,
            period,
            checks: {
              doubleEntry: {
                description: 'Every voucher debits equal its credits.',
                vouchersChecked: doubleEntry.checked,
                exceptions: doubleEntry.imbalances.length,
                ...(doubleEntry.imbalances.length === 0
                  ? {}
                  : { totalOutBy: sumOf(doubleEntry.imbalances.map((item) => item.outBy)) }),
              },
              balanceRollForward: {
                description:
                  'Opening balance plus period movements equals the closing balance TallyPrime reports.',
                accountsChecked: rollForward.checked,
                exceptions: rollForward.exceptions.length,
                ...(rollForward.exceptions.length === 0
                  ? {}
                  : {
                      totalDifference: sumOf(rollForward.exceptions.map((item) => item.difference)),
                    }),
              },
            },
            unbalancedVouchers: doubleEntry.imbalances,
            balanceExceptions: rollForward.exceptions,
            /**
             * Neither passed nor failed. Kept separate so the counts above are
             * not read as covering the whole population when they do not.
             */
            notCheckable: [...doubleEntry.notCheckable, ...rollForward.notCheckable],
            ...(warnings.length > 0 ? { warnings } : {}),
          },
          doubleEntry.imbalances.length + rollForward.exceptions.length
        );
      })
  );
}
