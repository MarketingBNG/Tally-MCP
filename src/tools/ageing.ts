import { Decimal } from 'decimal.js';
import { TallyError } from '../tally/TallyError.js';
import { daysBetween } from '../utils/dates.js';
import { DEFAULT_CURRENCY, toMoney, type Money } from '../utils/numbers.js';

/**
 * Bill ageing — opt-in, and deliberately NOT overdue analysis.
 *
 * ## What this computes, and the distinction that makes it safe
 *
 * Ageing here means **how long ago each bill arose**, counted from the date of
 * the voucher that raised it to a date the caller names. That is arithmetic on
 * two dates TallyPrime actually recorded.
 *
 * It is NOT days overdue. Overdue needs a due date, and a due date needs credit
 * terms, which a company may record per party, per bill, or not at all —
 * docs/known-limitations.md, "Receivables and payables compute no ageing".
 * Deriving one from an invoice date plus an assumed credit period would produce
 * an authoritative-looking bucket that is invented, so nothing here does it. A
 * credit period Tally does record is passed through untouched, never turned into
 * a date.
 *
 * The distinction has to survive into the output, or it is worthless: a "60-90
 * days" bucket reads as overdue to anyone who did not write it. So the basis is
 * stated in the payload on every call, and the tool description tells the caller
 * to repeat it.
 *
 * ## Netting, and why it is required rather than optional
 *
 * A bill reference appears more than once: TallyPrime records the invoice as a
 * `New Ref` allocation and every settlement against it as an `Agst Ref`
 * allocation with the opposite sign. Bucketing the allocations as they arrive
 * would count a fully-settled invoice at its full value and then again as a
 * payment, so references are netted by name first and only a non-zero net is
 * treated as outstanding.
 *
 * ## Direction is taken from the raising allocation, never from the sign
 *
 * Which sign means "still outstanding" is not fixed. TallyPrime encodes a debit
 * negative, so a receivable bill arrives negative and a payable bill arrives
 * positive — judging outstanding-ness by the sign alone would classify every
 * open payable as an over-settlement. So each reference takes its direction from
 * its own raising allocation (`New Ref`, or `Advance`), and a net with that same
 * sign is what remains outstanding.
 *
 * ## The limitation that matters most
 *
 * Bills are read from the vouchers in the requested period. A bill raised
 * BEFORE the period is not in that fetch, so it cannot be aged — and an invoice
 * from two years ago is exactly what an ageing question is usually about. A
 * reference that appears with settlements but no raising allocation is precisely
 * that case, and it is counted separately as
 * `settlementsAgainstEarlierBills` rather than aged from a settlement date,
 * which would age a payment.
 *
 * The coverage bound is reported on every call. Ageing a partial set of bills
 * and presenting it as the ageing of the ledger would be the most damaging thing
 * this module could do, because the output looks complete either way.
 */

/** Default bucket boundaries in days. The conventional 30/60/90 split. */
export const DEFAULT_AGEING_BUCKETS: readonly number[] = [30, 60, 90];

/**
 * Schedule III bucket boundaries, counted back from the date being aged as at.
 *
 * Schedule III to the Companies Act requires trade receivables and payables to
 * be disclosed as **less than 6 months / 6 months to 1 year / 1 to 2 years /
 * 2 to 3 years / more than 3 years**. Those are calendar periods, not day
 * counts, and 6 months is 181 days from 1 October and 184 days from 1 April.
 * Hard-coding 182 would put a bill within a few days of the boundary in the
 * wrong disclosure bucket — small, but wrong in a statutory disclosure — so the
 * boundaries are computed from the actual as-at date instead.
 *
 * ## What Schedule III asks for that is NOT here
 *
 * Each bucket has to be split **undisputed / disputed** and, within undisputed,
 * **considered good / considered doubtful**. TallyPrime holds none of those:
 * whether a debt is disputed is a legal fact and whether it is doubtful is a
 * judgement, and neither is a field on a bill. So this produces the AGEING half
 * of the disclosure and says plainly that the splits have to come from
 * elsewhere. Filling them in with "all undisputed, all considered good" would
 * be inventing the part of the disclosure that carries the actual opinion.
 */
export function scheduleIiiBoundaries(asOn: string): number[] {
  const anchor = Date.parse(`${asOn}T00:00:00Z`);
  if (Number.isNaN(anchor)) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `Cannot work out Schedule III buckets from the date "${asOn}".`
    );
  }

  const asAt = new Date(anchor);
  const monthsBack = [6, 12, 24, 36];

  return monthsBack.map((months) => {
    const boundary = new Date(
      Date.UTC(asAt.getUTCFullYear(), asAt.getUTCMonth() - months, asAt.getUTCDate())
    );
    // Days from that calendar boundary to the as-at date. A bill raised exactly
    // 6 months ago falls in the "6 months to 1 year" bucket, matching how the
    // disclosure reads: the first bucket is "LESS than 6 months".
    return Math.round((anchor - boundary.getTime()) / 86_400_000) - 1;
  });
}

/** The Schedule III labels, so a caller can map buckets to the disclosure. */
export const SCHEDULE_III_LABELS: readonly string[] = [
  'Less than 6 months',
  '6 months to 1 year',
  '1 to 2 years',
  '2 to 3 years',
  'More than 3 years',
];

/**
 * The disclosure splits Schedule III requires that TallyPrime cannot supply.
 *
 * Returned as a warning rather than as empty fields on the result. An
 * `undisputed: null` alongside a real amount reads as "nil disputed", which is
 * a positive assertion nobody made.
 */
export const SCHEDULE_III_INCOMPLETE_NOTE =
  'SCHEDULE III IS ONLY HALF DONE BY THIS OUTPUT. The ageing buckets match the Schedule III ' +
  'periods, but the disclosure also requires each bucket to be split undisputed/disputed and, ' +
  'within undisputed, considered good/considered doubtful. TallyPrime holds none of that — ' +
  'whether a debt is disputed is a legal fact and whether it is doubtful is a judgement, and ' +
  'neither is a field on a bill. Those splits have to come from the client. Do not present these ' +
  'buckets as a completed Schedule III note.';

export interface AgeingBucket {
  /** Human-readable range, e.g. "0-30 days", "90+ days". */
  label: string;
  /** Inclusive lower bound in days. Null on the `future` bucket. */
  fromDay: number | null;
  /** Inclusive upper bound in days. Null on the open-ended final bucket. */
  toDay: number | null;
  /** Distinct bill references falling in this bucket. */
  count: number;
  /** Sum of their net amounts, TallyPrime's signs preserved. */
  amount: Money;
}

/** A count and total for outcomes that are deliberately not bucketed. */
export interface AgeingAside {
  count: number;
  amount: Money;
}

export interface PartyAgeing {
  buckets: AgeingBucket[];
  /**
   * Bill references with no usable date, so they could not be aged. Never
   * folded into a bucket — a guessed bucket is worse than an admitted gap.
   */
  undated: AgeingAside;
  /**
   * Allocations TallyPrime recorded with no bill reference at all — its "On
   * Account" case. They belong to no bill, so there is nothing to age.
   */
  unreferenced: AgeingAside;
  /**
   * References that appear only as settlements, with no raising allocation in
   * the period: the invoice itself predates the requested range and is not in
   * this data. Not aged, because the only date available is a payment date.
   */
  settlementsAgainstEarlierBills: AgeingAside;
  /**
   * References whose net reversed direction relative to how they were raised —
   * more was applied against the bill than it was raised for.
   */
  overSettled: AgeingAside;
  /**
   * References netting to exactly zero — raised and settled within the period.
   * Counted, not bucketed, since nothing is outstanding.
   */
  settledInPeriod: number;
  /**
   * Genuinely overdue bills, present ONLY when the caller supplied credit terms.
   *
   * Absent rather than zero when no terms were given: a zero here would read as
   * "nothing is overdue", which is a positive claim that cannot be made without
   * knowing when each bill was due. `basis` is carried so the figure cannot be
   * quoted without saying where the due dates came from.
   */
  overdue?: AgeingAside & { creditDays: number; basis: string };
}

/** One bill allocation, with the voucher context needed to age it. */
export interface DatedBillAllocation {
  /** The bill reference name Tally recorded. Empty when it recorded none. */
  reference: string;
  /** ISO date of the voucher carrying this allocation. Null when unreadable. */
  voucherDate: string | null;
  /** Tally's own bill type label, e.g. "New Ref", "Agst Ref". */
  billType: string | null;
  /** The allocation's amount, Tally's sign preserved. */
  amount: Money | null;
  /** Every field Tally holds on the allocation, verbatim. */
  fields: Record<string, string>;
}

/**
 * Validate caller-supplied bucket boundaries.
 *
 * Strict on purpose: an unsorted or duplicated boundary list produces buckets
 * that silently overlap, and a bill counted twice in an ageing schedule is a
 * wrong figure that looks like a right one.
 */
export function validateBuckets(buckets: readonly number[]): number[] {
  if (buckets.length === 0) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      'ageingBuckets must contain at least one day boundary, e.g. [30, 60, 90].'
    );
  }

  let previous = 0;
  for (const boundary of buckets) {
    if (!Number.isInteger(boundary) || boundary < 1) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `ageingBuckets must be whole numbers of days, 1 or more. Got ${String(boundary)}.`
      );
    }
    if (boundary <= previous) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `ageingBuckets must ascend strictly, so the buckets cannot overlap. ${String(boundary)} does not come after ${String(previous)}.`
      );
    }
    previous = boundary;
  }

  return [...buckets];
}

interface NettedBill {
  reference: string;
  /** Date the bill was raised: the raising allocation's voucher date. */
  billDate: string | null;
  net: Decimal;
  currency: string;
  /**
   * Sign of the allocation that raised the bill, +1 or -1. Null when no raising
   * allocation appears in the period — which is itself the finding that the
   * invoice predates the requested range.
   */
  raisedSign: number | null;
}

/**
 * Tally's bill type labels that RAISE a reference rather than settle one.
 *
 * `Agst Ref` settles an existing reference and `On Account` carries none at all,
 * so neither appears here. These are Tally's own English labels, matched exactly
 * after trimming and lowercasing.
 */
const RAISING_BILL_TYPES = new Set(['new ref', 'advance']);

/**
 * Net a party's allocations down to one row per bill reference.
 *
 * The date kept is the raising allocation's, since that is when the bill arose —
 * not the earliest date seen, which on a reference settled inside the period
 * would be a payment date and would age the payment instead of the bill.
 */
function netByReference(
  allocations: readonly DatedBillAllocation[],
  warnings: string[]
): NettedBill[] {
  const byReference = new Map<string, NettedBill>();

  for (const allocation of allocations) {
    // Allocations with no reference are grouped under the empty key and
    // reported as `unreferenced`, never merged into a real bill.
    const key = allocation.reference.trim().toLowerCase();
    const raises = RAISING_BILL_TYPES.has((allocation.billType ?? '').trim().toLowerCase());
    const amount = allocation.amount;

    if (amount === null) {
      warnings.push(
        `Bill reference "${allocation.reference}" carries an allocation with no readable amount; ` +
          'it is excluded from the netted total rather than counted as zero.'
      );
    }

    const existing = byReference.get(key);
    if (existing === undefined) {
      byReference.set(key, {
        reference: allocation.reference,
        billDate: raises ? allocation.voucherDate : null,
        net: amount === null ? new Decimal(0) : new Decimal(amount.amount),
        currency: amount?.currency ?? DEFAULT_CURRENCY,
        raisedSign: raises && amount !== null ? signOf(new Decimal(amount.amount)) : null,
      });
      continue;
    }

    if (amount !== null) {
      if (amount.currency !== existing.currency) {
        warnings.push(
          `Bill reference "${allocation.reference}" mixes currencies (${existing.currency} and ${amount.currency}); the net is reported in ${existing.currency} and should not be relied on.`
        );
      }
      existing.net = existing.net.plus(new Decimal(amount.amount));
    }

    if (raises) {
      // Two raising allocations for one reference is unusual; the earliest wins,
      // since that is when the obligation started.
      if (
        allocation.voucherDate !== null &&
        (existing.billDate === null || allocation.voucherDate < existing.billDate)
      ) {
        existing.billDate = allocation.voucherDate;
      }
      existing.raisedSign ??= amount === null ? null : signOf(new Decimal(amount.amount));
    }
  }

  return [...byReference.values()];
}

/** −1, 0 or 1. Direction only; magnitude is never compared this way. */
function signOf(value: Decimal): number {
  if (value.isZero()) return 0;
  return value.isNegative() ? -1 : 1;
}

/** An empty aside total, so every outcome reports a figure rather than nothing. */
function zeroAside(currency: string): { count: number; total: Decimal; currency: string } {
  return { count: 0, total: new Decimal(0), currency };
}

function asideOf(aside: { count: number; total: Decimal; currency: string }): AgeingAside {
  return {
    count: aside.count,
    amount: { amount: aside.total.toFixed(), currency: aside.currency },
  };
}

function addTo(aside: { count: number; total: Decimal; currency: string }, net: Decimal): void {
  aside.count += 1;
  aside.total = aside.total.plus(net);
}

/** Build the empty bucket set for a boundary list. */
function emptyBuckets(boundaries: readonly number[], currency: string): AgeingBucket[] {
  const buckets: AgeingBucket[] = [
    {
      label: 'future-dated',
      fromDay: null,
      toDay: -1,
      count: 0,
      amount: { amount: '0', currency },
    },
  ];

  let lower = 0;
  for (const boundary of boundaries) {
    buckets.push({
      label: `${String(lower)}-${String(boundary)} days`,
      fromDay: lower,
      toDay: boundary,
      count: 0,
      amount: { amount: '0', currency },
    });
    lower = boundary + 1;
  }

  const last = boundaries[boundaries.length - 1] ?? 0;
  buckets.push({
    label: `${String(last)}+ days`,
    fromDay: last + 1,
    toDay: null,
    count: 0,
    amount: { amount: '0', currency },
  });

  return buckets;
}

/**
 * Age one party's bill allocations as at a date.
 *
 * Returns null when the party has no allocations at all, so the caller can omit
 * the field rather than attach an all-zero schedule that implies the party was
 * examined and found clear.
 */
export function ageBills(
  allocations: readonly DatedBillAllocation[],
  asOn: string,
  boundaries: readonly number[],
  warnings: string[],
  /**
   * Credit days for this party, supplied by the caller.
   *
   * This is what turns bill AGE into genuinely OVERDUE, and it has to come from
   * outside: a company may record credit terms per party, per bill, or not at
   * all, so deriving a due date from an invoice date plus an assumed credit
   * period would produce an authoritative-looking figure that nobody chose.
   * Omitted means overdue is simply not computed — never estimated.
   */
  creditDays: number | null = null
): PartyAgeing | null {
  if (allocations.length === 0) return null;

  const netted = netByReference(allocations, warnings);
  const currency = netted[0]?.currency ?? DEFAULT_CURRENCY;

  const buckets = emptyBuckets(boundaries, currency);
  const undated = zeroAside(currency);
  const unreferenced = zeroAside(currency);
  const earlier = zeroAside(currency);
  const overSettled = zeroAside(currency);
  const overdue = zeroAside(currency);
  let settled = 0;

  for (const bill of netted) {
    // Tally's "On Account": an allocation belonging to no bill. There is no
    // bill to age, and inventing one would put a real amount in a wrong bucket.
    if (bill.reference.trim() === '') {
      addTo(unreferenced, bill.net);
      continue;
    }

    if (bill.net.isZero()) {
      settled += 1;
      continue;
    }

    // No raising allocation in the period means the invoice predates it. The
    // only date available is a settlement date, and ageing from that would age
    // the payment rather than the bill.
    if (bill.raisedSign === null) {
      addTo(earlier, bill.net);
      continue;
    }

    // Net reversed relative to how the bill was raised: more has been applied
    // against it than it was raised for. Not an age question.
    if (signOf(bill.net) !== bill.raisedSign) {
      addTo(overSettled, bill.net);
      continue;
    }

    if (bill.billDate === null) {
      addTo(undated, bill.net);
      continue;
    }

    const age = daysBetween(bill.billDate, asOn);
    const bucket = buckets.find(
      (candidate) =>
        (candidate.fromDay === null || age >= candidate.fromDay) &&
        (candidate.toDay === null || age <= candidate.toDay)
    );
    // Every age falls in exactly one bucket by construction — the first is
    // open at the bottom and the last open at the top — so a miss would be a
    // bug in the boundary list, not a data condition to absorb silently.
    if (bucket === undefined) {
      warnings.push(
        `Bill reference "${bill.reference}" aged ${String(age)} days matched no bucket and was omitted. This is a defect in the bucket boundaries, not a property of the data.`
      );
      continue;
    }

    bucket.count += 1;
    bucket.amount = {
      amount: new Decimal(bucket.amount.amount).plus(bill.net).toFixed(),
      currency: bucket.amount.currency,
    };

    // Strictly greater than: a bill on its due date is due, not yet overdue.
    if (creditDays !== null && age > creditDays) addTo(overdue, bill.net);
  }

  return {
    buckets,
    undated: asideOf(undated),
    unreferenced: asideOf(unreferenced),
    settlementsAgainstEarlierBills: asideOf(earlier),
    overSettled: asideOf(overSettled),
    settledInPeriod: settled,
    ...(creditDays === null
      ? {}
      : { overdue: { ...asideOf(overdue), creditDays, basis: 'caller-supplied credit terms' } }),
  };
}

/**
 * Read an allocation's amount from Tally's own AMOUNT field.
 *
 * `currency` comes from the ledger entry the allocation hangs off, which is the
 * only correct source: a bill allocation is denominated in the same currency as
 * the entry that raised it, and this server does not convert. Defaulting it would
 * relabel a dollar bill as rupees — see `resolveCompanyCurrency`.
 */
export function allocationAmount(
  fields: Record<string, string>,
  currency: string = DEFAULT_CURRENCY
): Money | null {
  return toMoney(fields.AMOUNT ?? null, currency);
}
