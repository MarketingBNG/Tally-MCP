import { Decimal } from 'decimal.js';

/**
 * Money handling.
 *
 * No floating-point accounting math anywhere. Amounts are carried as decimal
 * strings end to end; Decimal.js is used only where arithmetic is genuinely
 * required (summing entries for a balance check), never for storage.
 *
 * `Money` is deliberately **side-free**: debit/credit belongs to a ledger
 * entry, not to an amount. Plenty of legitimate values — a stock item rate,
 * an invoice total, a closing balance — have no side at all, and forcing one
 * onto them produces meaningless data.
 *
 * Sign convention: Tally's native sign is preserved exactly as received.
 * We never invert or coerce it. What that sign means in Tally's own encoding
 * is documented in the README and confirmed against ground-truth samples.
 */

export interface Money {
  /** Decimal-safe, signed where relevant, e.g. "1234.50" or "-1234.50". */
  amount: string;
  /** ISO-ish currency label as Tally reports it, e.g. "INR". */
  currency: string;
}

export const DEFAULT_CURRENCY = 'INR';

/**
 * Parse a raw Tally amount into a decimal string, preserving sign.
 *
 * Tally amounts arrive with assorted noise: thousands separators, currency
 * symbols, whitespace, and occasionally a trailing Dr/Cr marker. We strip
 * presentation and keep the number. Returns null when there is no parseable
 * numeric value, so callers can record a warning rather than invent a zero —
 * a fabricated 0.00 in an audit context is worse than an admitted gap.
 */
export function parseTallyAmount(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? new Decimal(raw).toFixed() : null;
  }

  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Tally may append Dr/Cr as a presentation suffix. Note it, then drop it:
  // the side belongs on the entry, not on the amount.
  const withoutMarker = trimmed.replace(/\s*(dr|cr)\.?$/i, '');

  // Sign is decided before stripping symbols, because it can sit either side
  // of them ("-Rs. 500" and "Rs. -500" both occur). Parenthesised negatives
  // are an accounting convention Tally can emit on formatted output.
  const firstDigit = withoutMarker.search(/\d/);
  if (firstDigit === -1) return null;
  const isNegativeValue =
    withoutMarker.slice(0, firstDigit).includes('-') || /^\(.*\)$/.test(withoutMarker.trim());

  // Drop everything before the first digit outright. This removes a currency
  // prefix whole ("Rs.", "₹", "-Rs. ") rather than leaving its trailing dot
  // behind to be misread as a decimal point.
  const digitsAndDots = withoutMarker.slice(firstDigit).replace(/[^\d.]/g, '');

  // A prefix such as "Rs." leaves a stray dot, and thousands separators may
  // be dots in some locales — so the decimal point is the LAST dot, and any
  // earlier ones are punctuation to discard.
  const lastDot = digitsAndDots.lastIndexOf('.');
  let normalised: string;
  if (lastDot === -1) {
    normalised = digitsAndDots;
  } else {
    const integerPart = digitsAndDots.slice(0, lastDot).replace(/\./g, '');
    const fractionPart = digitsAndDots.slice(lastDot + 1);
    normalised = fractionPart === '' ? integerPart : `${integerPart}.${fractionPart}`;
  }

  if (normalised === '' || !/\d/.test(normalised)) return null;

  try {
    const decimal = new Decimal(isNegativeValue ? `-${normalised}` : normalised);
    return decimal.isFinite() ? decimal.toFixed() : null;
  } catch {
    return null;
  }
}

/** Build a Money value from a raw Tally amount. Returns null if unparseable. */
export function toMoney(
  raw: string | number | null | undefined,
  currency: string = DEFAULT_CURRENCY
): Money | null {
  const amount = parseTallyAmount(raw);
  return amount === null ? null : { amount, currency };
}

/** True when the amount is negative. Does not imply debit or credit. */
export function isNegative(money: Money): boolean {
  return new Decimal(money.amount).isNegative();
}

/** Absolute value, preserving currency. Use only for display-oriented output. */
export function absolute(money: Money): Money {
  return { amount: new Decimal(money.amount).abs().toFixed(), currency: money.currency };
}

