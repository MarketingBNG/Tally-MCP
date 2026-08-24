

import {
  bookYearFor,
  type DateRange,
} from '../../utils/dates.js';
import {
  adaptAccounts,
  adaptVouchers,
} from '../../model/fromTally.js';
import {
  companyNamed,
  resolveCompanyCurrencyDetailed,
  resolvePeriod,
  type ToolDeps,
} from '../toolResult.js';
import {
  highestSeverity,
  summariseFindings,
  type Finding,
} from '../findings.js';

import {
  fetchLedgers,
} from '../ledgers.js';
import {
  fetchGroups,
} from '../groups.js';
import {
  fetchVouchers,
} from '../vouchers.js';
import {
  fetchStockItems,
} from '../inventory.js';
import type { StockItem } from '../../tally/normalize.js';

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
import {
  sumOf,
} from './shared.js';
import {
  checkBalanceRollForward,
  checkDoubleEntry,
  checkStockTieOut,
} from './checks.js';

/**
 * Running the tie-out for one company, and trimming the result to the requested
 * verbosity.
 *
 * Split out of tieOut.ts at 1,149 lines. This is the orchestration: fetch what
 * the three checks need, run them, and assemble the finding list. Nothing here
 * decides whether a figure ties.
 */

/** One company's tie-out result, so a batch run and a single run share a shape. */
export interface CompanyTieOut {
  company: string | null;
  passed: boolean;
  period: DateRange;
  currency: string;
  payload: Record<string, unknown>;
  findings: Finding[];
  exceptionCount: number;
  /**
   * Notes that explain normal behaviour rather than report a problem. Held
   * separately from `findings` so `verbosity: "summary"` has something safe
   * to drop — nothing in here indicates a wrong figure.
   */
  informationalNotes: string[];
}

/**
 * Run the tie-out for exactly one company.
 *
 * Split out so the batch path and the single-company path cannot drift: both
 * call this, and a fix to the arithmetic lands in both at once.
 */
export async function tieOutOneCompany(
  deps: ToolDeps,
  companyArg: string | undefined,
  dates: { fromDate?: string | undefined; toDate?: string | undefined }
): Promise<CompanyTieOut> {
  // own financial year rather than the one containing today. The
  // roll-forward compares against Tally's period-end closing balance, so
  // a range that does not cover the company's period disagrees for
  // reasons that are not errors — and this tool's whole value is that a
  // disagreement means something.
  const explicitDates = dates.fromDate !== undefined || dates.toDate !== undefined;
  let period = resolvePeriod(dates.fromDate, dates.toDate);

  // Notes that merely explain normal behaviour. Separated from findings so
  // `verbosity: "summary"` can drop them without touching anything that
  // reports a problem.
  const periodNotes: string[] = [];
  const findings: Finding[] = [];

  if (!explicitDates) {
    // By name where one was given. With several companies loaded and none
    // named, this resolves to null and the note below fires — which is
    // right: their book years differ, so picking the first company's year
    // would check a period the company never closed against.
    const company = await companyNamed(deps, companyArg);
    const startingFrom = company === null ? null : company.startingFrom;

    if (company === null) {
      // Several companies loaded and none named. Their book years differ
      // — a German calendar year against two April years, live — so
      // there is no "the company's year" to default to, and picking one
      // would check a period that company never closed against.
      //
      // A finding, not a note: the period may be wrong, which makes every
      // roll-forward difference below unreliable. That must survive summary.
      findings.push({
        severity: 'not_checkable',
        code: 'period_not_anchored_to_book_year',
        subject: null,
        company: companyArg ?? null,
        message:
          'No dates were given and TallyPrime has more than one company loaded, so whose book ' +
          'year to use could not be determined. The period defaults to the financial year ' +
          'containing today, which may not be any of their years — name a company to check ' +
          'against its own. The roll-forward below will report differences that are not ' +
          'errors if the period is wrong.',
        figures: { fromDate: period.fromDate, toDate: period.toDate },
      });
    } else if (startingFrom === null) {
      findings.push({
        severity: 'not_checkable',
        code: 'period_not_anchored_to_book_year',
        subject: company.name,
        company: company.name,
        message:
          'TallyPrime did not report when this company books begin, so the period defaults to ' +
          'the financial year containing today. If that is not the company own year, the ' +
          'roll-forward check below will report differences that are not errors.',
        figures: { fromDate: period.fromDate, toDate: period.toDate },
      });
    } else {
      // Anchored on the company's own start month, not on 1 April. A
      // company whose books run January to December gets its January year;
      // assuming April would pick a window that need not even contain the
      // company's own data, and this tool's entire value rests on the
      // period being the one Tally closed against.
      period = bookYearFor(startingFrom, company.endingAt ?? startingFrom);
      periodNotes.push(
        `No dates were given, so this checked ${period.fromDate} to ${period.toDate} — the company's own book year, twelve months from the date its books begin.`
      );
    }
  } else {
    periodNotes.push(
      'Explicit dates were given. TallyPrime reported closing balances are as at its own period end, not the end of this range, so the balance roll-forward will show differences wherever the range does not cover the whole period. Those are not necessarily errors.'
    );
  }

  // Resolved so the figures below carry the company's own currency rather
  // than the INR default this file used to assume — the same wrong-label
  // bug fixed elsewhere on 2026-08-13, which this tool had kept.
  const currencyWarnings: string[] = [];
  const currency = await resolveCompanyCurrencyDetailed(deps, companyArg, currencyWarnings);

  const [{ ledgers, warnings: ledgerWarnings }, { groups, warnings: groupWarnings }] =
    await Promise.all([fetchLedgers(deps, companyArg), fetchGroups(deps, companyArg)]);

  const { vouchers, warnings: voucherWarnings } = await fetchVouchers(deps, companyArg, period);

  // Stock items are the second half of the inventory tie-out. Fetched
  // unconditionally rather than only where a stock ledger exists, because
  // "the general ledger carries no stock account but the stock records hold
  // 240,000" is itself the finding, and a conditional fetch could never see it.
  /**
   * Never allowed to fail the tie-out.
   *
   * The double-entry and roll-forward checks stand on their own and are the
   * blocking control (§4 L5). If the stock fetch errors — an older TallyPrime,
   * a company with inventory switched off, a transport fault — losing those
   * two results as well would turn a partial answer into no answer, which is
   * the opposite of what a gate should do. A failure here degrades to "not
   * checkable" and is reported as such, matching how this file already treats
   * a ledger it cannot roll forward.
   */
  const stock = await (async (): Promise<{ items: StockItem[]; warnings: string[]; note: string | null }> => {
    try {
      const { items, warnings } = await fetchStockItems(
        deps,
        companyArg,
        // Curated fields only: this needs opening and closing value, both of
        // which are named properties. All-fields is several times the payload.
        false
      );
      return { items, warnings, note: null };
    } catch (error) {
      return {
        items: [],
        warnings: [],
        note:
          'The stock records could not be read, so inventory was not tied out. The other checks ' +
          `below are unaffected. Reason: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  })();
  const stockItems = stock.items;
  const stockWarnings = stock.warnings;

  const entityId = companyArg ?? 'loaded-company';
  const accounts = adaptAccounts(groups, ledgers, { entityId });
  const adapted = adaptVouchers(vouchers, { entityId });

  const doubleEntry = checkDoubleEntry(adapted.data, currency.label);
  const rollForward = checkBalanceRollForward(accounts.data, adapted.data, currency.label);

  // Stock-in-hand accounts, by the group TallyPrime files them under. Matched
  // on the PATH rather than the immediate parent so a company that nests its
  // stock ledgers a level deeper is still caught.
  const stockAccounts = accounts.data.filter(
    (account) =>
      account.isPostable &&
      account.path.some((step) => step.trim().toLowerCase() === 'stock-in-hand')
  );
  const stockTieOut = checkStockTieOut(stockAccounts, stockItems, currency.label);
  if (stock.note !== null) stockTieOut.notCheckable.push(stock.note);

  const passed =
    doubleEntry.imbalances.length === 0 &&
    rollForward.exceptions.length === 0 &&
    stockTieOut.exceptions.length === 0;

  // Every exception becomes a typed finding as well as staying in its own
  // list. The lists keep the full record; the findings make severity
  // explicit so a caller can triage without parsing prose.
  for (const item of doubleEntry.imbalances) {
    findings.push({
      severity: 'exception',
      code: 'voucher_out_of_balance',
      subject: item.number ?? item.voucherId,
      company: companyArg ?? null,
      message:
        `Voucher ${item.number ?? item.voucherId} does not balance: its debits and credits ` +
        `differ by ${item.outBy.magnitude.amount} ${item.outBy.magnitude.currency} ` +
        `(${item.outBy.side}), across ${String(item.entryCount)} entries.`,
      figures: {
        outBy: item.outBy,
        entryCount: item.entryCount,
        date: item.date,
        voucherType: item.voucherType,
      },
    });
  }

  for (const item of rollForward.exceptions) {
    findings.push({
      severity: 'exception',
      code: 'balance_roll_forward_mismatch',
      subject: item.account,
      company: companyArg ?? null,
      message:
        `"${item.account}" does not roll forward: opening plus ${String(item.movementCount)} ` +
        `movement(s) computes to ${item.computedClosing.magnitude.amount} ` +
        `${item.computedClosing.magnitude.currency} (${item.computedClosing.side}), but ` +
        `TallyPrime reports ${item.reportedClosing?.magnitude.amount ?? 'no closing balance'}` +
        `${item.reportedClosing === null ? '' : ` ${item.reportedClosing.magnitude.currency} (${item.reportedClosing.side})`}` +
        ` — a difference of ${item.difference.magnitude.amount} ` +
        `${item.difference.magnitude.currency} (${item.difference.side}).`,
      figures: {
        opening: item.opening,
        computedClosing: item.computedClosing,
        reportedClosing: item.reportedClosing,
        difference: item.difference,
        movementCount: item.movementCount,
      },
    });
  }

  for (const item of stockTieOut.exceptions) {
    const movement =
      item.at === 'opening'
        ? 'This is an OPENING position, so it was already wrong before the period began — an ' +
          'opening-balance or conversion error, not something this period caused.'
        : 'This is the CLOSING position. Where the opening ties and the closing does not, stock ' +
          'moved in the stock records without a corresponding entry reaching the general ' +
          'ledger, and cost of sales is wrong by the difference.';
    findings.push({
      severity: 'exception',
      code: 'stock_does_not_tie',
      subject: item.ledgersIncluded.join(', '),
      company: companyArg ?? null,
      message:
        `Inventory does not tie at ${item.at}: the general ledger carries ` +
        `${item.perGeneralLedger.magnitude.amount} ${item.perGeneralLedger.magnitude.currency} ` +
        `across ${String(item.ledgersIncluded.length)} stock ledger(s), while the stock records ` +
        `for ${String(item.stockItemsIncluded)} item(s) total ` +
        `${item.perStockRecords.magnitude.amount} — a difference of ` +
        `${item.difference.magnitude.amount}. ${movement} Neither figure has been adjusted and ` +
        'neither is preferred: which is right needs the stock count.',
      figures: {
        at: item.at,
        perGeneralLedger: item.perGeneralLedger,
        perStockRecords: item.perStockRecords,
        difference: item.difference,
        ledgersIncluded: item.ledgersIncluded.join(', '),
        stockItemsIncluded: item.stockItemsIncluded,
      },
    });
  }

  /**
   * Inventory that was not tied is reported, not passed over in silence.
   *
   * Severity is not_checkable rather than info: "the stock records are
   * unconstrained by double entry" is a limitation on the assurance this gate
   * gives, and a limitation that only appears at full verbosity is a
   * limitation nobody reads. It does not fail the tie-out — nothing is known
   * to be wrong — but it must not read as a clean stock result either.
   */
  if (stockTieOut.notApplicableReason !== null) {
    findings.push({
      severity: 'not_checkable',
      code: 'stock_not_tied',
      subject: null,
      company: companyArg ?? null,
      message: stockTieOut.notApplicableReason,
      figures: {
        stockLedgers: stockAccounts.length,
        stockItems: stockItems.length,
      },
    });
  }

  for (const reason of [
    ...doubleEntry.notCheckable,
    ...rollForward.notCheckable,
    ...stockTieOut.notCheckable,
  ]) {
    findings.push({
      severity: 'not_checkable',
      code: 'not_checkable',
      subject: null,
      company: companyArg ?? null,
      message: reason,
    });
  }

  // A currency that was not established is a finding, not a note: every
  // figure in this response carries that label, so a reader needs it even
  // in summary form.
  if (!currency.comparable) {
    for (const message of currencyWarnings) {
      findings.push({
        severity: 'not_checkable',
        code: 'currency_not_established',
        subject: companyArg ?? null,
        company: companyArg ?? null,
        message,
        figures: { currency: currency.label, source: currency.source },
      });
    }
  }

  const payload: Record<string, unknown> = {
    /**
     * The gate. Spec §4 L5: a failure blocks output. This server
     * cannot enforce that, so it states it plainly instead and the
     * tool description tells Claude not to present figures over it.
     */
    passed,
    period,
    currency: currency.label,
    /** False when the label was inferred or absent rather than established. */
    currencyEstablished: currency.comparable,
    checks: {
      doubleEntry: {
        description: 'Every voucher debits equal its credits.',
        vouchersChecked: doubleEntry.checked,
        exceptions: doubleEntry.imbalances.length,
        ...(doubleEntry.imbalances.length === 0
          ? {}
          : {
              totalOutBy: sumOf(
                doubleEntry.imbalances.map((item) => item.outBy),
                currency.label
              ).total,
            }),
      },
      balanceRollForward: {
        description:
          'Opening balance plus period movements equals the closing balance TallyPrime reports.',
        accountsChecked: rollForward.checked,
        exceptions: rollForward.exceptions.length,
        ...(rollForward.exceptions.length === 0
          ? {}
          : {
              totalDifference: sumOf(
                rollForward.exceptions.map((item) => item.difference),
                currency.label
              ).total,
            }),
      },
      stockTieOut: {
        description:
          'Stock in the general ledger equals the stock records, at both ends of the period.',
        /**
         * Zero means NOT APPLICABLE, not "passed". A company with no stock
         * ledgers and no stock items has nothing to tie; counting that as a
         * pass would report assurance nobody obtained.
         */
        datesChecked: stockTieOut.checked,
        applicable: stockTieOut.checked > 0,
        exceptions: stockTieOut.exceptions.length,
        /**
         * Present only when nothing was tied. Says WHICH of the three
         * not-applicable states this is — no inventory at all, stock records
         * with no ledger to tie them to, or a ledger with no stock records —
         * because they carry very different amounts of assurance.
         */
        ...(stockTieOut.notApplicableReason === null
          ? {}
          : { notApplicableReason: stockTieOut.notApplicableReason }),
      },
    },
    unbalancedVouchers: doubleEntry.imbalances,
    balanceExceptions: rollForward.exceptions,
    stockExceptions: stockTieOut.exceptions,
    /**
     * Neither passed nor failed. Kept separate so the counts above are
     * not read as covering the whole population when they do not.
     */
    notCheckable: [
      ...doubleEntry.notCheckable,
      ...rollForward.notCheckable,
      ...stockTieOut.notCheckable,
    ],
  };

  return {
    company: companyArg ?? null,
    passed,
    period,
    currency: currency.label,
    payload,
    findings,
    exceptionCount: doubleEntry.imbalances.length + rollForward.exceptions.length,
    informationalNotes: [
      ...periodNotes,
      ...ledgerWarnings,
      ...groupWarnings,
      ...voucherWarnings,
      ...stockWarnings,
      ...accounts.warnings,
      ...adapted.warnings,
      // Only when the currency WAS established — otherwise these are
      // findings above and must not be duplicated here.
      ...(currency.comparable ? currencyWarnings : []),
    ],
  };
}

/**
 * Fold findings and notes into the response at the requested verbosity.
 *
 * Findings are NEVER dropped — only the informational notes are, and the
 * count of what went is returned so the omission is visible.
 */
export function applyVerbosity(
  verbosity: 'full' | 'summary',
  findings: readonly Finding[],
  informationalNotes: readonly string[]
): Record<string, unknown> {
  const counts = summariseFindings(findings);
  const shared = {
    findings,
    findingCounts: counts,
    highestSeverity: highestSeverity(findings),
  };

  if (verbosity === 'summary') {
    return {
      ...shared,
      verbosity,
      /**
       * Said as a count rather than silently: a reader must be able to tell
       * that explanation was withheld, and how much, without guessing.
       */
      informationalNotesOmitted: informationalNotes.length,
      ...(informationalNotes.length === 0
        ? {}
        : {
            note:
              `${String(informationalNotes.length)} informational note(s) about normal behaviour ` +
              '(period defaulting, closing-balance timing, field coverage) were omitted. Nothing ' +
              'indicating a problem was suppressed. Call again with verbosity "full" to read them.',
          }),
    };
  }

  return {
    ...shared,
    verbosity,
    ...(informationalNotes.length > 0 ? { warnings: informationalNotes } : {}),
  };
}
