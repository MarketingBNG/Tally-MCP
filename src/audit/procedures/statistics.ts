import { Decimal } from 'decimal.js';
import type { Voucher } from '../../tally/normalize.js';

/**
 * Voucher-population audit procedures, as pure functions.
 *
 * These are the arithmetic half of `tally_test_vouchers`. They are separated
 * from the tool so they can be tested against populations built by hand —
 * including populations with a KNOWN answer, which is the only way to establish
 * that a Benford result or a seeded sample is right rather than plausible.
 * That distinction is the whole point: every one of these procedures produces
 * CANDIDATES FOR REVIEW, and a candidate presented as a finding is a false
 * statement about the data.
 *
 * Nothing here reads from TallyPrime, and nothing here uses the current date or
 * a random source that is not explicitly seeded — a workpaper has to be
 * re-derivable, and a procedure whose answer changes between two runs over the
 * same data is not evidence.
 */
import {
  asCandidate,
  compareForSampling,
  voucherMagnitude,
  type Candidate,
} from './candidates.js';

/**
 * Benford's law and the sampling procedures.
 *
 * Split out of procedures.ts at 1,114 lines. These are the parts where the
 * method has to be reproducible: the PRNG is fully specified and seeded from the
 * population rather than the clock, so the same books and the same parameters
 * always yield the same sample. A sample nobody can re-draw is not evidence.
 */

export interface BenfordDigit {
  digit: string;
  observed: number;
  observedProportion: string;
  expectedProportion: string;
  /** Observed minus expected, so a positive number means over-represented. */
  difference: string;
}

export interface BenfordResult {
  /** 1 for the first digit, 2 for the first two digits. */
  digits: 1 | 2;
  population: number;
  /** Amounts that could not be tested, and why they could not be. */
  excluded: { zeroOrUnreadable: number };
  distribution: BenfordDigit[];
  /** Mean absolute deviation, the statistic Nigrini's thresholds apply to. */
  meanAbsoluteDeviation: string;
  /**
   * Nigrini's conformity band for the MAD, stated as his label. NOT a verdict
   * on the books: non-conformity is a reason to look, and conformity is not
   * assurance — a fraud small enough to matter can leave the digits untouched.
   */
  conformity: string;
  warnings: string[];
}

/** log10(1 + 1/d), the Benford expectation for leading-digit value d. */
function benfordExpectation(value: number): Decimal {
  return new Decimal(1).plus(new Decimal(1).dividedBy(value)).log(10);
}

/**
 * First-digit or first-two-digit Benford test over voucher magnitudes.
 *
 * First-two-digit is the more sensitive test and is the default the tool
 * offers, per the standard treatment; first-digit is kept because it is the one
 * most readers recognise.
 *
 * The 300-population floor is not a formality. Below it the expected count in
 * the smallest bucket falls under 5, at which point a deviation says more about
 * the sample size than about the data — so a small population is reported WITH
 * its result and a warning, never quietly.
 */
export function benford(vouchers: readonly Voucher[], digits: 1 | 2): BenfordResult {
  const leading: string[] = [];
  let zeroOrUnreadable = 0;

  for (const voucher of vouchers) {
    const magnitude = voucherMagnitude(voucher);
    if (magnitude === null || magnitude.isZero()) {
      zeroOrUnreadable += 1;
      continue;
    }
    // Leading zeros go, and so does the decimal point: Benford is about the
    // significant digits of the value, and 0.0123 leads with 1 exactly as 123
    // does. What survives is the significant digits in order.
    const digitsOnly = magnitude
      .toFixed()
      .replace(/[^0-9]/g, '')
      .replace(/^0+/, '');
    if (digitsOnly.length < digits) {
      // A 7 tested for its first TWO digits has no second digit. Padding it
      // with a zero would invent a "70" that the amount does not contain.
      zeroOrUnreadable += 1;
      continue;
    }
    leading.push(digitsOnly.slice(0, digits));
  }

  const population = leading.length;
  const counts = new Map<string, number>();
  for (const key of leading) counts.set(key, (counts.get(key) ?? 0) + 1);

  const buckets: string[] = [];
  if (digits === 1) {
    for (let d = 1; d <= 9; d += 1) buckets.push(String(d));
  } else {
    for (let d = 10; d <= 99; d += 1) buckets.push(String(d));
  }

  const distribution: BenfordDigit[] = [];
  let absoluteDeviation = new Decimal(0);
  for (const bucket of buckets) {
    const observed = counts.get(bucket) ?? 0;
    const expectedProportion = benfordExpectation(Number(bucket));
    const observedProportion =
      population === 0 ? new Decimal(0) : new Decimal(observed).dividedBy(population);
    const difference = observedProportion.minus(expectedProportion);
    absoluteDeviation = absoluteDeviation.plus(difference.abs());
    distribution.push({
      digit: bucket,
      observed,
      observedProportion: observedProportion.toFixed(6),
      expectedProportion: expectedProportion.toFixed(6),
      difference: difference.toFixed(6),
    });
  }

  const mad = absoluteDeviation.dividedBy(buckets.length);
  const warnings: string[] = [];
  if (population < 300) {
    warnings.push(
      `POPULATION TOO SMALL TO CONCLUDE FROM: ${String(population)} amounts were tested, below ` +
        'the 300 usually taken as the minimum for a Benford test. Below that the expected count ' +
        'in the smallest bucket drops under 5, so a deviation reflects the sample size at least ' +
        'as much as the data. The distribution is returned so it can be inspected, but the ' +
        'conformity label should not be quoted as a conclusion.'
    );
  }
  if (zeroOrUnreadable > 0) {
    warnings.push(
      `${String(zeroOrUnreadable)} voucher(s) were left out of the test: their amount was zero, ` +
        'unreadable, or had fewer digits than the test needs. They are excluded rather than ' +
        'padded, because padding would invent leading digits the amount does not contain.'
    );
  }

  return {
    digits,
    population,
    excluded: { zeroOrUnreadable },
    distribution,
    meanAbsoluteDeviation: mad.toFixed(6),
    conformity: conformityBand(mad, digits),
    warnings,
  };
}

/**
 * Nigrini's MAD conformity bands.
 *
 * The cut-offs differ by test — a first-two-digit test spreads the same
 * population across 90 buckets rather than 9, so its deviations are naturally
 * smaller and a first-digit threshold applied to it would call everything
 * conforming.
 */
export function conformityBand(mad: Decimal, digits: 1 | 2): string {
  const bands: [Decimal, string][] =
    digits === 1
      ? [
          [new Decimal('0.006'), 'close conformity'],
          [new Decimal('0.012'), 'acceptable conformity'],
          [new Decimal('0.015'), 'marginally acceptable conformity'],
        ]
      : [
          [new Decimal('0.0012'), 'close conformity'],
          [new Decimal('0.0018'), 'acceptable conformity'],
          [new Decimal('0.0022'), 'marginally acceptable conformity'],
        ];
  for (const [ceiling, label] of bands) {
    if (mad.lessThanOrEqualTo(ceiling)) return label;
  }
  return 'nonconformity';
}

export type SampleMethod = 'random' | 'systematic' | 'monetary_unit';

export interface SampleResult {
  method: SampleMethod;
  /** The seed used, echoed so the same sample can be drawn again. */
  seed: string;
  populationSize: number;
  requested: number;
  selected: Candidate[];
  warnings: string[];
  /**
   * Present for `monetary_unit` only, and absent — not zeroed — for the other
   * two, because an interval has no meaning for a method that does not use one.
   */
  monetaryUnit?: MonetaryUnitDetail;
}

/**
 * The figures a monetary-unit sample has to disclose for the workpaper to stand
 * up. Without the interval and the total tested, a reviewer cannot check the
 * selection or project an error, which is the entire reason for choosing PPS.
 */
export interface MonetaryUnitDetail {
  /** Sum of the magnitudes that were eligible for selection, as a decimal string. */
  totalValue: string;
  /** totalValue / requested — the sampling interval, as a decimal string. */
  interval: string;
  /**
   * Vouchers at or above the interval. These cannot be missed by the method, so
   * they are a complete examination of the top stratum and must not be
   * described as sampled or used to project an error over the rest.
   */
  certaintySelections: number;
  /**
   * Vouchers that carried no readable amount. They have no monetary units, so
   * PPS can never reach them — they are outside the tested population, not
   * inside it and untested.
   */
  unreadableAmount: number;
  /**
   * Vouchers whose magnitude is zero. Same consequence as above: zero monetary
   * units means zero selection probability.
   */
  zeroValue: number;
}

/**
 * A 32-bit hash of the seed string, so any seed a caller types is usable.
 *
 * FNV-1a. Chosen for being short and completely specified, which matters more
 * than its statistical quality here: the requirement is that the same seed
 * produces the same sample on every machine and every version, and a hash
 * anyone can re-implement from four lines is what makes that checkable.
 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a small, fully specified PRNG. Seeded only — never Math.random. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw a sample from the population, reproducibly.
 *
 * Two methods, and the difference matters for a workpaper:
 * - `random`: a seeded shuffle, then take the first n. Every voucher has an
 *   equal chance, which is what makes the sample defensible as unbiased.
 * - `systematic`: every kth voucher in the order Tally returned them. Cheaper
 *   to explain and gives even coverage across the period, but it is biased if
 *   the population has any periodicity matching the interval — which, on data
 *   ordered by date, is a real risk for anything weekly or monthly.
 *
 * - `monetary_unit`: probability-proportional-to-size. See
 *   `sampleMonetaryUnit` for what it does and when it is the right choice.
 *
 * The population is sorted before selection. Tally's own ordering is stable in
 * practice but is not a documented guarantee, and a sample that depends on
 * undocumented ordering would not reproduce.
 */
export function sampleVouchers(
  vouchers: readonly Voucher[],
  size: number,
  seed: string,
  method: SampleMethod
): SampleResult {
  const ordered = [...vouchers].sort(compareForSampling);
  if (method === 'monetary_unit') return sampleMonetaryUnit(ordered, size, seed);
  const warnings: string[] = [];

  if (size >= ordered.length && ordered.length > 0) {
    warnings.push(
      `The requested sample of ${String(size)} is not smaller than the population of ` +
        `${String(ordered.length)}, so every voucher is returned. This is a complete ` +
        'examination, not a sample, and should not be described as one.'
    );
  }
  if (method === 'systematic') {
    warnings.push(
      'SYSTEMATIC selection takes every kth voucher in date order. It gives even coverage but ' +
        'is biased against anything periodic in the data — a weekly or monthly pattern whose ' +
        'cycle matches the interval will be systematically over- or under-represented. Use the ' +
        'random method where the sample has to support a statistical conclusion.'
    );
  }

  let picked: Voucher[];
  if (ordered.length === 0 || size <= 0) {
    picked = [];
  } else if (method === 'systematic') {
    const interval = Math.max(1, Math.floor(ordered.length / size));
    // The start offset is seeded too: a fixed start of 0 would make the sample
    // depend only on the interval, so two "different" seeds would agree.
    const start = Math.floor(mulberry32(hashSeed(seed))() * interval);
    picked = [];
    for (let i = start; i < ordered.length && picked.length < size; i += interval) {
      const voucher = ordered[i];
      if (voucher !== undefined) picked.push(voucher);
    }
  } else {
    const random = mulberry32(hashSeed(seed));
    const shuffled = [...ordered];
    // Fisher-Yates, so every permutation is equally likely.
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const a = shuffled[i];
      const b = shuffled[j];
      if (a !== undefined && b !== undefined) {
        shuffled[i] = b;
        shuffled[j] = a;
      }
    }
    picked = shuffled.slice(0, size);
  }

  return {
    method,
    seed,
    populationSize: ordered.length,
    requested: size,
    selected: picked.map((voucher) => asCandidate(voucher, ['Selected by the sampling method.'])),
    warnings,
  };
}

/**
 * Monetary-unit sampling — probability proportional to size.
 *
 * The unit sampled is one rupee (or dollar, or euro) of the population, not one
 * voucher. Every monetary unit has an equal chance of selection, so a voucher's
 * chance is proportional to its magnitude: a 10,00,000 voucher is a hundred
 * times likelier to be picked than a 10,000 one.
 *
 * WHY IT IS USUALLY THE RIGHT CHOICE for substantive testing. Random selection
 * treats a 500 petty-cash voucher and a 50,00,000 acquisition as equally worth
 * testing. In a population where most of the value sits in a few entries — which
 * is nearly every set of books — that spends the sample on items that could not
 * contain a material misstatement even if wholly wrong. PPS puts the effort
 * where the money is, and every large item is tested with certainty.
 *
 * WHAT IT DOES NOT DO, and this decides whether it is appropriate:
 * - It is directed at OVERSTATEMENT. An understated voucher carries fewer
 *   monetary units and is therefore less likely to be selected; a balance
 *   wrongly recorded as nil carries none and can never be selected at all. For
 *   completeness testing — unrecorded liabilities, omitted income — this is the
 *   wrong method, and `random` is the honest one.
 * - It cannot reach a zero or unreadable magnitude. Those are counted and
 *   disclosed as outside the tested population rather than silently dropped,
 *   because "not selected" and "not selectable" support different conclusions.
 *
 * The selection is a single cumulative sweep: a seeded random start inside the
 * first interval, then every interval-th monetary unit thereafter. That is what
 * makes items at or above the interval certain selections — a run of monetary
 * units longer than the interval must contain a hit point.
 */
export function sampleMonetaryUnit(
  ordered: readonly Voucher[],
  size: number,
  seed: string
): SampleResult {
  const warnings: string[] = [];

  // Partition first, so the three populations are named rather than conflated.
  const eligible: { voucher: Voucher; magnitude: Decimal }[] = [];
  let unreadableAmount = 0;
  let zeroValue = 0;
  for (const voucher of ordered) {
    const magnitude = voucherMagnitude(voucher);
    if (magnitude === null) unreadableAmount += 1;
    else if (magnitude.isZero()) zeroValue += 1;
    else eligible.push({ voucher, magnitude });
  }

  const totalValue = eligible.reduce((sum, item) => sum.plus(item.magnitude), new Decimal(0));

  warnings.push(
    'MONETARY-UNIT selection is directed at overstatement. A voucher understated, or omitted ' +
      'entirely, carries fewer monetary units and is correspondingly less likely to be ' +
      'selected — one recorded at nil cannot be selected at all. Do not use this sample to ' +
      'support a conclusion about completeness; use the random method for that.'
  );
  if (unreadableAmount > 0) {
    warnings.push(
      `${String(unreadableAmount)} voucher(s) carried no readable amount and were outside the ` +
        'tested population. They are untested, not tested-and-clean, and need a separate ' +
        'procedure.'
    );
  }
  if (zeroValue > 0) {
    warnings.push(
      `${String(zeroValue)} voucher(s) had a magnitude of zero. Zero monetary units means zero ` +
        'chance of selection, so these are outside the tested population too.'
    );
  }

  if (size <= 0 || eligible.length === 0 || totalValue.isZero()) {
    return {
      method: 'monetary_unit',
      seed,
      populationSize: ordered.length,
      requested: size,
      selected: [],
      warnings,
      monetaryUnit: {
        totalValue: totalValue.toFixed(),
        interval: '0',
        certaintySelections: 0,
        unreadableAmount,
        zeroValue,
      },
    };
  }

  const interval = totalValue.dividedBy(size);
  const random = mulberry32(hashSeed(seed));
  // The start is a random point inside the FIRST interval, not zero. A fixed
  // start of zero would always select whichever voucher happens to sort first,
  // which is a bias with no statistical defence.
  let nextHit = interval.times(random());

  const selected: Candidate[] = [];
  let certaintySelections = 0;
  let cumulative = new Decimal(0);

  for (const { voucher, magnitude } of eligible) {
    const upper = cumulative.plus(magnitude);
    let hits = 0;
    while (nextHit.lessThan(upper)) {
      hits += 1;
      nextHit = nextHit.plus(interval);
    }
    if (hits > 0) {
      const certain = magnitude.greaterThanOrEqualTo(interval);
      if (certain) certaintySelections += 1;
      const reason = certain
        ? `Magnitude ${magnitude.toFixed()} is at or above the sampling interval ` +
          `${interval.toFixed(2)}, so it is a CERTAINTY selection — a complete examination of ` +
          'the top stratum, not a sample. Errors found here are known errors and must not be ' +
          'projected over the remaining population.'
        : `Selected by monetary-unit sampling: magnitude ${magnitude.toFixed()} against a ` +
          `sampling interval of ${interval.toFixed(2)}.`;
      selected.push(asCandidate(voucher, [reason]));
    }
    cumulative = upper;
  }

  if (selected.length < size) {
    warnings.push(
      `${String(size)} hit points were laid down but only ${String(selected.length)} distinct ` +
        'voucher(s) were selected, because an item larger than the interval absorbs more than ' +
        'one hit. This is expected in PPS and is not a shortfall in coverage — the value tested ' +
        'is unaffected — but the count of items examined is lower than the nominal sample size.'
    );
  }

  return {
    method: 'monetary_unit',
    seed,
    populationSize: ordered.length,
    requested: size,
    selected,
    warnings,
    monetaryUnit: {
      totalValue: totalValue.toFixed(),
      interval: interval.toFixed(),
      certaintySelections,
      unreadableAmount,
      zeroValue,
    },
  };
}
