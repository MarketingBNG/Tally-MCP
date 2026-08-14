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
 * Label used when TallyPrime's own currency symbol could not be transported.
 *
 * A WORD, deliberately, not a symbol or a code. It has to be impossible to
 * mistake for the real thing when it lands in `{"amount": "-46084.41",
 * "currency": ...}`, and it must not be a plausible currency — anything
 * three-lettered would read as an ISO code that nobody chose.
 */
export const UNKNOWN_CURRENCY = 'unknown';

/**
 * True when a currency symbol from Tally cannot be used as a label.
 *
 * Verified live 2026-08-14 on a German company: TallyPrime reported its base
 * currency as a literal `?` — byte `0x3F` in the raw response, not a decoding
 * artefact on our side. The euro sign is not in the single-byte codepage Tally
 * exports with, so Tally substituted it before the bytes ever left. Ten candidate
 * encoding settings were probed (`scripts/probe-encoding.ts`) and every response
 * came back byte-identical, so there is no request-side fix.
 *
 * The point of detecting it: `"?"` passed through as a currency looks like data.
 * Every figure from that company was labelled `"currency": "?"`, which is not a
 * currency, and falling back to `DEFAULT_CURRENCY` instead would be worse still —
 * it would label euro balances INR, the exact bug fixed on 2026-08-13.
 *
 * U+FFFD is included because it is what a mis-decoded byte becomes, so this stays
 * correct even if a payload arrives through a path that mangles rather than
 * substitutes.
 */
export function currencyIsUnavailable(symbol: string | null | undefined): boolean {
  if (symbol === null || symbol === undefined) return false;
  const trimmed = symbol.trim();
  if (trimmed === '') return false;
  return /^[?�]+$/.test(trimmed);
}

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
  const body = withoutMarker.slice(firstDigit).replace(/\)$/, '').trim();

  /**
   * From here the remainder must be a clean number, and anything else is
   * REFUSED rather than salvaged.
   *
   * The previous version deleted every non-digit, then treated the last dot as
   * the decimal point. That silently fabricated numbers rather than admitting it
   * could not read them:
   *
   *   "1000.00 Kgs."  ->  "100000"   (100x too large)
   *   "20.00/Kgs."    ->  "2000"     (100x too large)
   *   "1.2.3"         ->  "12.3"
   *   "1.234,50"      ->  "1.2345"   (European format, silently mangled)
   *
   * Those are exactly the strings Tally puts in stock quantity and rate fields
   * ("1000.00 Kgs.", "20.00/Kgs." — both observed live), so a caller one field
   * away from an amount got a plausible figure that was wrong by two orders of
   * magnitude, with no warning. §6 rule 1: this server does not invent figures,
   * and a salvaged number is invented. Returning null makes the caller warn.
   *
   * Accepted: digits, optional comma grouping in any width (Indian lakh grouping
   * included), and at most ONE decimal point, whose fraction may be empty
   * because Tally emits "5000." for a whole number.
   */
  if (!/^\d+(,\d+)*(\.\d*)?$/.test(body)) return null;

  const normalised = body.replace(/,/g, '').replace(/\.$/, '');
  if (normalised === '') return null;

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
