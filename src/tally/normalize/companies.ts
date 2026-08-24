import {
  tallyDateToIso,
} from '../../utils/dates.js';

import {
  attributesOf,
  childText,
  findAll,
} from '../TallyResponseParser.js';
import {
  dataScope,
  openDocument,
  sourceRef,
  unreadablePayloadWarning,
  type Normalized,
  type SourceRef,
} from './shared.js';

/**
 * Companies and currencies: the two collections that describe the books
 * themselves rather than anything in them.
 *
 * Split out of the single normalize.ts, which had grown to 1,461 lines across
 * thirteen banner-delimited sections. Every function here follows the same two
 * rules as the rest of the normalisers.
 *
 * **Sign is preserved, never corrected.** Tally's trial balance reports debit
 * balances as negative and P&L expenses as negative. That is Tally's own
 * encoding, and silently flipping it would mean the number Claude reasons about
 * is not the number the accountant would see in Tally.
 *
 * **An unreadable value becomes null plus a warning, never a zero.** A
 * fabricated 0.00 in an audit context is worse than an admitted gap, because it
 * is indistinguishable from a real balance of zero.
 */

/**
 * Every TallyPrime element name this module depends on, in one place.
 *
 * These are the wire contract, and TallyPrime does not document it. Scattered as
 * bare literals through the normalisers they were unreviewable: a tag renamed or
 * dropped in a future Tally build yields ZERO ROWS, not a type error, and the
 * only way to find what a normaliser actually requires was to read every line of
 * it. Collected here, "what does this module need from Tally?" is one block to
 * read and one place to change.
 *
 * The keys are the tag names themselves rather than friendlier aliases: an alias
 * would put a second vocabulary between the reader and the payload they are
 * comparing against, and the payload only ever says the tag.
 */
const TAG = {
  COUNTRYNAME: 'COUNTRYNAME',
  CURRENCYNAME: 'CURRENCYNAME',
  DECIMALPLACES: 'DECIMALPLACES',
  ENDINGAT: 'ENDINGAT',
  MAILINGNAME: 'MAILINGNAME',
  NAME: 'NAME',
  STARTINGFROM: 'STARTINGFROM',
} as const;

export interface Company {
  name: string;
  /** ISO date the books start, or null if Tally did not report one. */
  startingFrom: string | null;
  /**
   * ISO date the books END AT, or null if Tally did not report one.
   *
   * This is the last date the company holds data for, NOT the end of its book
   * year: verified live 2026-08-14 on a company reporting `20260731` whose year
   * runs to 31 December. Use it as the anchor for `bookYearFor` rather than
   * today's date — a company holding 2019 books does not become a current-year
   * company because someone opened it today.
   */
  endingAt: string | null;
  /**
   * The company's base currency exactly as Tally labels it — a SYMBOL, not an
   * ISO code: `"$"` on a US company, `"₹"` or `"Rs."` on an Indian one. Null
   * when Tally did not report it.
   *
   * This is the label every monetary figure from this company carries. It is not
   * a conversion rate and nothing here converts between currencies.
   */
  currency: string | null;
  /** Country as Tally reports it, e.g. "United States of America". */
  country: string | null;
  source: SourceRef;
}

export function normalizeCompanies(xml: string): Normalized<Company[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'COMPANY')
    // Belt and braces alongside dataScope: a real record carries a NAME
    // attribute, a counter does not.
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => {
      const attrs = attributesOf(node);
      const name = childText(node, TAG.NAME) ?? attrs.NAME ?? '';
      const rawStart = childText(node, TAG.STARTINGFROM);

      const startingFrom = rawStart === null ? null : tallyDateToIso(rawStart);
      if (rawStart !== null && startingFrom === null) {
        warnings.push(`Company "${name}" reported an unreadable start date "${rawStart}".`);
      }

      const rawEnd = childText(node, TAG.ENDINGAT);
      const endingAt = rawEnd === null ? null : tallyDateToIso(rawEnd);
      if (rawEnd !== null && endingAt === null) {
        warnings.push(`Company "${name}" reported an unreadable end date "${rawEnd}".`);
      }

      return {
        name,
        startingFrom,
        endingAt,
        currency: childText(node, TAG.CURRENCYNAME),
        country: childText(node, TAG.COUNTRYNAME),
        source: sourceRef('company', name),
      };
    });

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the company list');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}

export interface Currency {
  /** The symbol Tally uses as the currency's identity, e.g. "$". */
  name: string;
  /** Tally's spelled-out name, e.g. "Dollar". Null when not reported. */
  formalName: string | null;
  /** Decimal places Tally records for it, as a string. Null when not reported. */
  decimalPlaces: string | null;
}

export function normalizeCurrencies(xml: string): Normalized<Currency[]> {
  const warnings: string[] = [];
  const nodes = openDocument(xml);

  const data = findAll(dataScope(nodes), 'CURRENCY')
    // A real record carries a NAME attribute; the CMPINFO counter does not.
    .filter((node) => attributesOf(node).NAME !== undefined)
    .map((node) => ({
      name: childText(node, TAG.NAME) ?? attributesOf(node).NAME ?? '',
      formalName: childText(node, TAG.MAILINGNAME),
      decimalPlaces: childText(node, TAG.DECIMALPLACES),
    }));

  // A payload that carried content must never read as an empty result.
  const unread = unreadablePayloadWarning(xml, data.length, 'the currency list');
  if (unread !== undefined) warnings.push(unread);

  return { data, warnings };
}
