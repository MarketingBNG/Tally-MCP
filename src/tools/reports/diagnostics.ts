
import {
  Decimal,
} from 'decimal.js';

import {
  type Ledger,
} from '../../tally/normalize.js';
import {
  fetchLedgers,
} from '../ledgers.js';
import {
  fetchGroups,
} from '../groups.js';
import {
  fetchClosingStockTotal,
} from '../closingStock.js';

import {
  type ToolDeps,
} from '../toolResult.js';

import {
  field,
} from './specs.js';

/**
 * The diagnostics a statement carries with it.
 *
 * Split out of reports.ts at 1,498 lines. Each of these answers a question the
 * figures alone cannot: is the closing stock in this balance sheet stale, are
 * cost recoveries inflating revenue, does the trial balance disagree with the
 * ledger masters. They are the largest functions in the original file and the
 * most self-contained — each takes figures and returns warnings.
 */

/**
 * Tally's top-level groups carry the parent name "Primary". It is a sentinel
 * for "no parent", not a real group, and walking through it files every ledger
 * under one key — which makes the comparison below compare nothing while
 * appearing to pass.
 */
const PRIMARY_GROUP = 'primary';

/** Rounding floor. Below this, two figures are the same figure. */
const TOLERANCE = '0.005';

/**
 * Where the trial balance and the ledger masters disagree — and why that has
 * to be said out loud rather than quietly picked between.
 *
 * Found live 2026-08-13 against real books: `trial_balance` reported Current
 * Assets as -385,764.46, while the closing balances `tally_get_masters type "ledger"` gives
 * for the same group summed to -482,384.46. The difference, 96,620.00, is
 * exactly the year's movement on `Stock In Hand` (opening -207,968, closing
 * -304,588). `balance_sheet` agreed with the masters to the cent on every
 * group, as did the trial balance on all seven other groups.
 *
 * So TallyPrime's Trial Balance carries stock at its OPENING value while its
 * Balance Sheet and the ledger masters carry the CLOSING value. Both are
 * Tally's own figures and both are passed through untouched — §6 rule 1
 * forbids adjusting either. What was missing was any statement that two tools
 * answer "what are current assets" on different bases. A 20% difference,
 * quoted from whichever tool happened to be called first, is a wrong answer of
 * entirely plausible size, which is the failure mode this codebase treats as
 * the serious one.
 *
 * The check OBSERVES rather than assumes: it compares every group row against
 * the masters and reports whatever differs, then names the account whose
 * movement accounts for the gap when one does. A company that integrates
 * accounts with inventory shows no difference and gets no warning — the right
 * outcome, and not one this code has to know about in advance. It also catches
 * any future divergence of this kind, not only the stock one.
 *
 * Never throws. A diagnostic that turns a correct answer into an error is
 * worse than the inconsistency it reports — the same rule as companyPeriodEnd.
 */
/**
 * The stock line on a `profit_loss`, when it carries one.
 *
 * Rows arrive as `{ name, amount, subAmount }` and Tally puts the stock figures
 * on `subAmount` under the Cost of Sales block, so both are read and the first
 * present one wins. Matched on the row name because that is all the report
 * gives — there is no group code on a P&L row.
 */
function stockFigure(rows: readonly unknown[], label: string): Decimal | null {
  for (const row of rows) {
    const record = row as {
      name?: unknown;
      amount?: { amount?: unknown } | null;
      subAmount?: { amount?: unknown } | null;
    };
    if (typeof record.name !== 'string') continue;
    if (record.name.trim().toLowerCase() !== label) continue;
    const raw = record.subAmount?.amount ?? record.amount?.amount;
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      return new Decimal(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Rounding floor for the stock comparison, in currency units. */
const STOCK_TOLERANCE = new Decimal('0.01');

/**
 * Where the profit and loss carries stock at a value the Stock Summary does
 * not agree with — and why that has to be said on THIS statement.
 *
 * The trial balance already discloses a version of this through
 * noteMastersDivergence: TallyPrime's TB carries stock at its OPENING value
 * while the balance sheet and masters carry the closing one. The profit and
 * loss had no equivalent, and it is the statement where the consequence is
 * largest, because stock sits inside the Cost of Sales block and a stale
 * closing figure does not merely misstate the balance sheet — it misstates
 * GROSS PROFIT, one for one.
 *
 * Found live 2026-08-18 on AgEx Pharma LLC: the P&L reported Opening Stock and
 * Less: Closing Stock as the SAME figure, -304,588, over a period in which five
 * sales invoices relieved 1,900 Kg of stock across three items with full batch
 * and godown allocations. Cost of sales came out nil and `ratio_analysis`
 * reported Gross Profit % and Nett Profit % at 100.00%. The Stock Summary for
 * the same company totalled -239,687.94 — a gap of 64,900.06 that no tool
 * mentioned. An accountant reading the P&L alone would have concluded the
 * inventory was never posted; it was posted, and the closing VALUATION was
 * stale.
 *
 * Two independent triggers, because they catch different failures:
 *
 * 1. Opening equals closing exactly. Free — read off rows already fetched. On
 *    a period with any trading at all this is near-impossible as a genuine
 *    outcome, and it is the signature of a period whose stock was never
 *    revalued.
 * 2. The P&L closing figure disagrees with the Stock Summary. Costs one
 *    request, and is the check that produces the actual number.
 *
 * NOTHING IS ADJUSTED. Both figures are TallyPrime's own and both are passed
 * through untouched — §6 rule 1. What is added is the statement that they
 * disagree, and by how much, so the figure is not quoted as a fact about the
 * period when it is a fact about the opening position.
 *
 * Never throws, for the same reason as noteMastersDivergence.
 */
export async function noteStaleClosingStock(
  deps: ToolDeps,
  company: string | undefined,
  rows: readonly unknown[]
): Promise<string[]> {
  try {
    const opening = stockFigure(rows, 'opening stock');
    const closing = stockFigure(rows, 'less: closing stock') ?? stockFigure(rows, 'closing stock');

    // No stock line at all: a company that does not maintain inventory, which
    // is a correct outcome and not something to warn about.
    if (closing === null && opening === null) return [];

    const warnings: string[] = [];

    if (
      opening !== null &&
      closing !== null &&
      opening.equals(closing) &&
      !opening.isZero()
    ) {
      warnings.push(
        `This profit and loss reports Opening Stock and Closing Stock as the SAME figure ` +
          `(${opening.abs().toFixed(2)}). Cost of sales is therefore struck with NO stock ` +
          'movement in it, and gross profit is overstated by whatever the movement was. ' +
          'Verified live: this occurs on a period whose closing stock was never revalued, ' +
          'including periods in which invoices did relieve stock with full batch and godown ' +
          'allocations. Check tally_get_inventory_movements for the period before concluding ' +
          'that no inventory was posted — the entries and the valuation fail separately.'
      );
    }

    // Only paid for when there is a stock line to check it against.
    if (closing !== null) {
      const summary = await fetchClosingStockTotal(deps, company);
      if (summary !== null) {
        const gap = closing.abs().minus(summary.abs());
        if (gap.abs().greaterThan(STOCK_TOLERANCE)) {
          warnings.push(
            `The closing stock on this profit and loss (${closing.abs().toFixed(2)}) does NOT ` +
              `agree with TallyPrime's own Stock Summary (${summary.abs().toFixed(2)}) — a ` +
              `difference of ${gap.abs().toFixed(2)}. Both are TallyPrime's own figures and ` +
              'neither has been adjusted here. TallyPrime is known to carry stock on different ' +
              'bases in different reports, so this is not a reading error. Because closing ' +
              'stock sits inside Cost of Sales, the difference passes straight through to ' +
              `gross profit: it is ${gap.greaterThan(0) ? 'OVERSTATED' : 'UNDERSTATED'} by ` +
              `${gap.abs().toFixed(2)} on this statement if the Stock Summary is the right ` +
              'basis. Establish which basis the accounts are drawn on before quoting either.'
          );
        }
      }
    }

    return warnings;
  } catch {
    return [];
  }
}

/**
 * Ledger-name fragments that mark a COST RECOVERY rather than a sale.
 *
 * Freight, packing and insurance recharged to a customer are recoveries of a
 * cost, not revenue from the entity's ordinary activities. Presented gross
 * inside sales they overstate both revenue and margin.
 *
 * Deliberately conservative. Only terms whose ordinary accounting meaning is a
 * delivery or handling cost, so a genuine revenue stream — "Freight Income" at
 * a haulier, say — is a false positive this ACCEPTS rather than one it hides.
 * The note says the classification is a judgement and never adjusts a figure.
 */
const COST_RECOVERY_HINTS = [
  'freight',
  'transport',
  'carriage',
  'packing',
  'courier',
  'delivery',
  'shipping',
  'insurance',
];

/** Group names whose contents are revenue for this purpose. */
const REVENUE_GROUP_HINTS = ['sales account', 'direct income', 'indirect income', 'revenue'];

/**
 * Cost recoveries sitting inside revenue — found on the masters, not the rows.
 *
 * WHY THE MASTERS. A profit and loss reports GROUPS: "Sales Accounts" is one
 * row and the ledgers inside it are invisible, so nothing on the statement
 * itself can show that part of the figure is recovered freight. The ledger
 * masters carry the parent group, which is where it is visible.
 *
 * Found live 2026-08-18 on AgEx Pharma LLC: `Transport Cost`, parent
 * `Sales Accounts`, closing 805.00, credited into the revenue side of
 * invoice AgEx/INV/02 alongside the goods.
 *
 * NOTHING IS RECLASSIFIED and no figure moves. Whether a recovery is revenue
 * (ASC 606-10-32 / Ind AS 115) depends on whether the entity controls the
 * shipping service before transfer, which no ledger name settles. This names
 * the ledgers and their size so the judgement can be made, and says plainly
 * that it is a judgement.
 *
 * Never throws.
 */
export async function noteCostRecoveriesInRevenue(
  deps: ToolDeps,
  company: string | undefined
): Promise<string[]> {
  try {
    const { ledgers } = await fetchLedgers(deps, company);

    const suspects = ledgers.filter((ledger) => {
      const parent = (ledger.parent ?? '').trim().toLowerCase();
      if (!REVENUE_GROUP_HINTS.some((hint) => parent.includes(hint))) return false;
      const name = ledger.name.toLowerCase();
      return COST_RECOVERY_HINTS.some((hint) => name.includes(hint));
    });

    if (suspects.length === 0) return [];

    const listed = suspects
      .map((ledger) => {
        const amount = ledger.closingBalance?.amount;
        return `"${ledger.name}" (under "${ledger.parent ?? 'unknown'}"${
          amount === undefined || amount === null ? '' : `, ${new Decimal(amount).abs().toFixed(2)}`
        })`;
      })
      .join(', ');

    return [
      `${String(suspects.length)} ledger(s) grouped under revenue are named as COST RECOVERIES ` +
        `rather than sales: ${listed}. Freight, packing and insurance recharged to a customer ` +
        'are recoveries of a cost; presented gross inside sales they overstate both revenue and ' +
        'gross margin by their amount. Nothing here has been reclassified and no figure has ' +
        'moved — whether a recovery is revenue depends on whether the entity controls the ' +
        'service before it transfers to the customer, which a ledger name cannot settle. Verified ' +
        'live: one such ledger was credited into the revenue side of a sales invoice alongside ' +
        'the goods. Check the grouping before quoting revenue or margin from this statement.',
    ];
  } catch {
    return [];
  }
}

export async function noteMastersDivergence(
  deps: ToolDeps,
  company: string | undefined,
  rows: readonly unknown[]
): Promise<string[]> {
  try {
    const [{ ledgers }, { groups }] = await Promise.all([
      fetchLedgers(deps, company),
      fetchGroups(deps, company),
    ]);

    // Trimmed throughout: TallyPrime pads its primary-group name with a leading
    // space, the same trap derivedBalanceReason() in tieOut.ts documents. An
    // untrimmed key misses in the map, the walk stops one level too early, and
    // the comparison below quietly compares nothing instead of failing.
    const key = (value: string | null): string => (value ?? '').trim().toLowerCase();
    const parentOf = new Map(groups.map((group) => [key(group.name), key(group.parent)]));
    const rootOf = (name: string | null): string => {
      let current = key(name);
      for (let hops = 0; hops < 20; hops++) {
        const parent = parentOf.get(current);
        if (parent === undefined || parent === '' || parent === PRIMARY_GROUP) break;
        current = parent;
      }
      return current;
    };

    const mastersByRoot = new Map<string, Decimal>();
    const ledgersByRoot = new Map<string, Ledger[]>();
    /**
     * How many ledgers under each root reported NO closing balance, and were
     * therefore not in the sum below.
     *
     * WHY THIS IS COUNTED. Skipping a null is right — rule 1, a null is Tally
     * reporting nothing and adding it as zero would invent a figure. But the
     * note this function emits then says the masters "add up to" a number,
     * and presents it as the counterpart of the trial balance total. When some
     * of the group was unreadable that number is a sum over a SUBSET, and the
     * difference it reports is part real basis difference and part simply
     * data that was never read. The reader cannot tell which, and the honest
     * reading of a large difference — "these two disagree, reconcile before
     * quoting" — is then partly wrong.
     *
     * Verified live 2026-08-17 on AGBV Nutrition GmbH: 5 of the 10 ledgers
     * under Sales Accounts and 68 of the 87 under Indirect Expenses report no
     * closing balance at all. On that company they turned out to be genuinely
     * unused ledgers — `Sales Income` has zero vouchers in the period, so the
     * sum was complete after all — but nothing in the output said so, and on a
     * company where they are NOT empty the same note would read identically.
     * So the count is disclosed rather than the sum being silently partial.
     */
    const unreadableByRoot = new Map<string, number>();
    for (const ledger of ledgers) {
      const root = rootOf(ledger.parent);
      ledgersByRoot.set(root, [...(ledgersByRoot.get(root) ?? []), ledger]);
      // A null closing balance is Tally reporting nothing, not a zero, so it
      // contributes nothing rather than being added as 0.
      if (ledger.closingBalance === null) {
        unreadableByRoot.set(root, (unreadableByRoot.get(root) ?? 0) + 1);
        continue;
      }
      mastersByRoot.set(
        root,
        (mastersByRoot.get(root) ?? new Decimal(0)).plus(ledger.closingBalance.amount)
      );
    }

    const notes: string[] = [];
    for (const row of rows) {
      const name = field(row, 'name');
      if (typeof name !== 'string') continue;
      const masters = mastersByRoot.get(key(name));
      // Rows Tally derives rather than posts — "Profit & Loss A/c" — have no
      // ledgers filed under them. Nothing to compare, so nothing to say.
      if (masters === undefined) continue;

      const money = (column: string): string => {
        const value = field(row, column);
        const amount = (value as { amount?: unknown } | null)?.amount;
        return typeof amount === 'string' ? amount : '0';
      };
      const stated = new Decimal(money('debit')).plus(money('credit'));
      const difference = stated.minus(masters);
      if (difference.abs().lessThan(TOLERANCE)) continue;

      // A row carried at its OPENING value differs from the masters by exactly
      // opening minus closing, which identifies the account responsible
      // without this code having to know which account it should be.
      const carriedAtOpening = (ledgersByRoot.get(key(name)) ?? []).filter(
        (ledger) =>
          ledger.openingBalance !== null &&
          ledger.closingBalance !== null &&
          new Decimal(ledger.openingBalance.amount)
            .minus(ledger.closingBalance.amount)
            .minus(difference)
            .abs()
            .lessThan(TOLERANCE)
      );
      const culprit = carriedAtOpening.length === 1 ? carriedAtOpening[0] : undefined;

      // How much of this group the masters figure actually covers. Stated
      // whenever anything was unreadable, so a partial sum is never presented
      // as a whole one — see `unreadableByRoot`.
      const unreadable = unreadableByRoot.get(key(name)) ?? 0;
      const total = (ledgersByRoot.get(key(name)) ?? []).length;
      const coverage =
        unreadable === 0
          ? ''
          : `That masters figure is the sum of ${String(total - unreadable)} of the ` +
            `${String(total)} ledger(s) in this group: the other ${String(unreadable)} report no ` +
            `closing balance at all, and a missing balance is not a zero, so they were left out ` +
            `rather than added as nought. Part of the difference above may therefore be ledgers ` +
            `that were never read rather than a real disagreement. Check them with ` +
            `tally_get_ledger_transactions before treating the gap as a reconciling item — an ` +
            `unused ledger genuinely holds nothing, and TallyPrime reports those the same way. `;

      notes.push(
        `"${name}" is ${stated.toString()} on this trial balance, but the closing balances ` +
          `tally_get_masters type "ledger" reports for the same group add up to ${masters.toString()} — a ` +
          `difference of ${difference.toString()}. ` +
          coverage +
          (culprit === undefined
            ? ''
            : `That is exactly the period movement on "${culprit.name}" (opening ` +
              `${culprit.openingBalance?.amount ?? 'unreported'}, closing ` +
              `${culprit.closingBalance?.amount ?? 'unreported'}), so TallyPrime's trial balance ` +
              `carries that account at its OPENING value while tally_get_masters type "ledger" and ` +
              `tally_get_statement (balance_sheet) carry its CLOSING value. `) +
          `Both figures are TallyPrime's own and neither has been adjusted here. State which ` +
          `basis you are quoting, and do not present the two as agreeing.`
      );
    }

    return notes;
  } catch {
    return [];
  }
}
