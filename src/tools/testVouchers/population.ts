import type { Voucher } from '../../tally/normalize.js';
import { fetchVouchers } from '../vouchers.js';
import { matchesVoucherFilters } from '../voucherFilters.js';
import {
  type ToolDeps,
} from '../toolResult.js';

/**
 * `tally_test_vouchers`: define a voucher population, then run a procedure over it.
 *
 * Eight tests behind one tool, because that sentence is what all eight are. They
 * share the population filter, they share the exclusion rules, and they share
 * the single Tally fetch — so eight tools would have meant eight copies of the
 * population logic and eight chances for them to drift apart, which is the worst
 * possible failure here: two tests disagreeing about what "the journals in
 * March" means, with no error raised.
 *
 * ## What this tool does NOT produce
 *
 * Findings. Every test returns CANDIDATES FOR REVIEW. A round-numbered journal
 * is not an error, a weekend date is not misconduct, and a Benford deviation is
 * not evidence of anything on its own. The output says so, and it says so per
 * candidate rather than once in a preamble that a summary can drop.
 *
 * That is not diplomatic hedging — it is the accuracy rule. Describing a flagged
 * voucher as a problem states something about the data that the data does not
 * support, and a workpaper carrying that description is wrong in a way that is
 * very hard to catch later.
 */

/**
 * The population every voucher test starts from, and what was excluded from it.
 *
 * Split out of testVouchers.ts at 908 lines. The exclusion accounting is the
 * point: a test run against a population that quietly dropped records is a test
 * whose result nobody can rely on, so what was left out is counted and said.
 */

/** The population every test starts from, before any test-specific filter. */
export interface Population {
  vouchers: Voucher[];
  warnings: string[];
  excluded: {
    cancelled: number;
    optional: number;
    orders: number;
    inventoryOnly: number;
    filteredOut: number;
  };
}

/**
 * Build the population once, with every exclusion counted.
 *
 * `amountBased` is the one axis on which the tests genuinely differ: a
 * stock-only delivery note belongs in a completeness or cut-off question and
 * does not belong in a Benford distribution, because it has no amount to
 * contribute. Rather than let each test decide silently, the flag is explicit
 * and the exclusion is reported.
 */
export async function buildPopulation(
  deps: ToolDeps,
  args: {
    company?: string;
    voucherType?: string;
    ledger?: string;
    party?: string;
    query?: string;
    minAmount?: number;
    maxAmount?: number;
  },
  period: { fromDate: string; toDate: string },
  amountBased: boolean
): Promise<Population> {
  const { vouchers, warnings } = await fetchVouchers(deps, args.company, period);

  const excluded = { cancelled: 0, optional: 0, orders: 0, inventoryOnly: 0, filteredOut: 0 };
  const kept: Voucher[] = [];

  for (const voucher of vouchers) {
    if (voucher.isCancelled) {
      excluded.cancelled += 1;
      continue;
    }
    if (voucher.isOptional) {
      excluded.optional += 1;
      continue;
    }
    if (voucher.isOrderVoucher) {
      excluded.orders += 1;
      continue;
    }
    if (amountBased && voucher.isInventoryVoucher) {
      excluded.inventoryOnly += 1;
      continue;
    }
    if (
      !matchesVoucherFilters(voucher, {
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.voucherType === undefined ? {} : { voucherType: args.voucherType }),
        ...(args.ledger === undefined ? {} : { ledger: args.ledger }),
        ...(args.party === undefined ? {} : { party: args.party }),
        ...(args.minAmount === undefined ? {} : { minAmount: args.minAmount }),
        ...(args.maxAmount === undefined ? {} : { maxAmount: args.maxAmount }),
      })
    ) {
      excluded.filteredOut += 1;
      continue;
    }
    kept.push(voucher);
  }

  return { vouchers: kept, warnings, excluded };
}

/** Turn the exclusion counts into sentences, so nothing is dropped silently. */
export function describeExclusions(population: Population, amountBased: boolean): string[] {
  const { excluded } = population;
  const notes: string[] = [];
  if (excluded.cancelled > 0) {
    notes.push(`${String(excluded.cancelled)} cancelled voucher(s) excluded.`);
  }
  if (excluded.optional > 0) {
    notes.push(
      `${String(excluded.optional)} optional voucher(s) excluded — TallyPrime does not post ` +
        'them to the books.'
    );
  }
  if (excluded.orders > 0) {
    notes.push(
      `${String(excluded.orders)} sales/purchase order(s) excluded: an order is a commitment ` +
        'with no ledger entries, so it would inflate the count without contributing an amount.'
    );
  }
  if (amountBased && excluded.inventoryOnly > 0) {
    notes.push(
      `${String(excluded.inventoryOnly)} stock-only voucher(s) (delivery/receipt notes) excluded ` +
        'from this amount-based test: they move inventory without touching accounts, so they ' +
        'have no amount to contribute.'
    );
  }
  if (excluded.filteredOut > 0) {
    notes.push(`${String(excluded.filteredOut)} voucher(s) did not match the filters given.`);
  }
  return notes;
}

/**
 * The population note every test carries.
 *
 * Deliberately per-result rather than only in the tool description: a
 * description is read once when choosing the tool, and this has to survive
 * being quoted out of context into a workpaper.
 */
export const CANDIDATE_NOTE =
  'These are CANDIDATES FOR REVIEW, not findings. Each carries the reason it was flagged. ' +
  'Nothing here establishes that a voucher is wrong — describe them as flagged, with the ' +
  'reason, and do not present the count as a number of problems.';

export const TEST_VALUES = [
  'journal_screen',
  'benford',
  'sample',
  'duplicates',
  'round_numbers',
  'cutoff',
  'weekend',
  'late_entry',
  'related_party',
] as const;

export type TestName = (typeof TEST_VALUES)[number];
