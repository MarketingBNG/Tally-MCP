/**
 * Derive a currency code from the country TallyPrime reports for a company.
 *
 * WHY THIS EXISTS. TallyPrime cannot transport a currency symbol that is
 * outside the single-byte codepage it exports with — `€` and `₹` both arrive
 * as a literal `?`. Verified live 2026-08-14; there is no request-side fix.
 * Until now that left every figure for such a company labelled "unknown",
 * which is honest but unhelpful: an accountant reading a euro balance sheet
 * knows perfectly well the figures are euros, and the label being missing on
 * every amount is a standing trust gap on money.
 *
 * WHY IT IS NOT SIMPLY TRUSTED. A company's country is where it is registered,
 * NOT necessarily the currency its books are kept in. A German subsidiary
 * reporting to a US parent may well keep its books in USD, and this mapping
 * would then label euros on dollar figures — the exact wrong-label failure the
 * "unknown" behaviour was introduced to prevent.
 *
 * So the derivation is offered with its provenance attached and NEVER silently
 * substituted for a fact: callers receive `source: 'derived-from-country'`,
 * responses say the label was inferred rather than read, and cross-company
 * arithmetic refuses to subtract across derived labels (see
 * `currencyIsComparable`). It removes the trust gap on the LABEL without
 * inventing a fact about the BOOKS.
 *
 * Precedence, highest first: a symbol TallyPrime transported successfully, then
 * TALLY_CURRENCY_LABEL (an operator stating what the books use), then this
 * derivation, then "unknown". Configuration outranks inference because an
 * operator naming a company's currency knows something this table cannot.
 */

/**
 * Country name as TallyPrime spells it, to ISO 4217.
 *
 * Deliberately small. Every entry is a country where the mapping is
 * unambiguous — one country, one legal-tender currency for company books.
 * Countries in a shared-currency zone are listed individually rather than
 * grouped, because Tally reports the country and not the zone.
 *
 * NOT LISTED, on purpose: countries that routinely keep books in a second
 * currency, and any country whose spelling in Tally has not been observed.
 * An absent country returns null and the caller falls back to "unknown",
 * which is the correct outcome — a missing label is recoverable, a confident
 * wrong one is not.
 */
const COUNTRY_TO_CURRENCY: Readonly<Record<string, string>> = {
  india: 'INR',
  germany: 'EUR',
  france: 'EUR',
  italy: 'EUR',
  spain: 'EUR',
  netherlands: 'EUR',
  belgium: 'EUR',
  austria: 'EUR',
  ireland: 'EUR',
  portugal: 'EUR',
  finland: 'EUR',
  greece: 'EUR',
  'united kingdom': 'GBP',
  'united states of america': 'USD',
  'united states': 'USD',
  usa: 'USD',
  japan: 'JPY',
  china: 'CNY',
  australia: 'AUD',
  canada: 'CAD',
  switzerland: 'CHF',
  singapore: 'SGD',
  'united arab emirates': 'AED',
  'saudi arabia': 'SAR',
  'south africa': 'ZAR',
  bangladesh: 'BDT',
  'sri lanka': 'LKR',
  nepal: 'NPR',
  kenya: 'KES',
  malaysia: 'MYR',
  indonesia: 'IDR',
  'new zealand': 'NZD',
  brazil: 'BRL',
  mexico: 'MXN',
};

/**
 * ISO 4217 for this country, or null when the mapping is not unambiguous.
 *
 * Null is a normal outcome, not an error: it means the caller should keep
 * saying "unknown" rather than guess.
 */
export function currencyForCountry(country: string | null | undefined): string | null {
  if (country === null || country === undefined) return null;
  const key = country.trim().toLowerCase();
  if (key === '') return null;
  return COUNTRY_TO_CURRENCY[key] ?? null;
}

/**
 * TallyPrime's spelled-out currency name, mapped to ISO 4217.
 *
 * VERIFIED LIVE 2026-08-15. Tally cannot transport `€` or `₹` as a SYMBOL, but
 * it transports the currency's MAILINGNAME as ordinary text in the same
 * response: the German company reports symbol `?` and mailing name
 * "European Euro", the Indian one `?` and "INR". That name is a fact from
 * Tally about the company's own currency master — not an inference — so it
 * outranks anything derived from the country.
 *
 * Some mailing names are already ISO codes ("INR", "USD"); those pass straight
 * through. This table covers the spelled-out forms seen or likely.
 */
const FORMAL_NAME_TO_ISO: Readonly<Record<string, string>> = {
  'european euro': 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  'indian rupee': 'INR',
  'indian rupees': 'INR',
  rupees: 'INR',
  'us dollar': 'USD',
  'us dollars': 'USD',
  dollars: 'USD',
  'pound sterling': 'GBP',
  'great britain pound': 'GBP',
  'japanese yen': 'JPY',
  'swiss franc': 'CHF',
  'australian dollar': 'AUD',
  'canadian dollar': 'CAD',
  'singapore dollar': 'SGD',
  'uae dirham': 'AED',
};

/**
 * Turn Tally's mailing name into a label worth stamping on a figure.
 *
 * Returns the ISO code where the name is recognised, the name itself where it
 * already looks like an ISO code, and otherwise the name verbatim — which is
 * still far better than "unknown", because it came from the books.
 *
 * Null only when there is no usable name at all.
 */
export function labelFromFormalName(formalName: string | null | undefined): string | null {
  if (formalName === null || formalName === undefined) return null;
  const trimmed = formalName.trim();
  if (trimmed === '') return null;

  const mapped = FORMAL_NAME_TO_ISO[trimmed.toLowerCase()];
  if (mapped !== undefined) return mapped;

  // Already an ISO-shaped code, e.g. "INR". Three letters, nothing else.
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();

  return trimmed;
}

/** Where a currency label came from. Carried so a response can say which. */
export type CurrencySource =
  /** TallyPrime transported the symbol itself. The only first-hand fact here. */
  | 'tally'
  /**
   * TallyPrime's spelled-out name for the same currency, read from the
   * company's own currency master when the symbol would not transport.
   * Still a fact from Tally, so it is comparable.
   */
  | 'tally-formal-name'
  /** TALLY_CURRENCY_LABEL — an operator stating what the books use. */
  | 'configuration'
  /** Inferred from the company's country by this module. Not a fact about the books. */
  | 'derived-from-country'
  /** Nothing established it. Figures are labelled "unknown". */
  | 'unresolved';

/**
 * May two labels be subtracted from one another?
 *
 * Only labels TallyPrime or the operator ESTABLISHED may be compared. Two
 * companies whose currency was merely inferred from their country can carry
 * the same label while keeping their books in different currencies, and
 * subtracting across them yields a wrong figure of plausible size — the
 * failure class this codebase exists to prevent. Same for two "unknown"s,
 * which are not one currency but two absent ones.
 */
export function currencyIsComparable(source: CurrencySource): boolean {
  return source === 'tally' || source === 'tally-formal-name' || source === 'configuration';
}
