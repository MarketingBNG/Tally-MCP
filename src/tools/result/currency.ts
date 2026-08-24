import { currencyLabelFor } from '../../config/config.js';
import { buildCurrencyListRequest, UNSCOPED } from '../../tally/requests.js';
import { normalizeCurrencies, type Currency } from '../../tally/normalize.js';
import {
  currencyIsUnavailable,
  DEFAULT_CURRENCY,
  UNKNOWN_CURRENCY,
} from '../../utils/numbers.js';
import {
  currencyForCountry,
  currencyIsComparable,
  labelFromFormalName,
  type CurrencySource,
} from '../../utils/currencyFromCountry.js';
import { companyList, type ToolDeps } from '../toolResult.js';

/**
 * Resolving the currency every figure is labelled with.
 *
 * Moved out of toolResult.ts unchanged. This is the single most consequential
 * piece of that module — the label on a figure is a claim about what the figure
 * means, and this project has shipped dollar balances labelled INR once — so it
 * is worth having on its own rather than buried among period and pagination
 * plumbing.
 */

/**
 * The base currency of the loaded company, for labelling every figure returned.
 *
 * Exists because the label used to be a hard-coded `INR`. Verified live
 * 2026-08-13: a US company keeping books in dollars had every balance returned as
 * `"currency": "INR"`. Nothing was converted — the arithmetic was right and only
 * the label lied — which is the worse kind of wrong, because a plausible label is
 * believed. §6 rule 1 forbids this server inventing figures, and inventing the
 * unit a figure is denominated in is the same offence.
 *
 * Cheap to call repeatedly: it is the company-list request every other guard
 * already makes, so TallyClient's cache serves it (measured 0 ms on a hit).
 *
 * Falls back to `DEFAULT_CURRENCY` when Tally does not report one, which is the
 * old behaviour and is right for the Indian installs this was built against.
 * There is no warning on the fallback: on an Indian company INR is correct, and a
 * warning on every figure would be noise that trains the reader to ignore it.
 */
/**
 * Warn when this company defines more than one currency.
 *
 * Tally does not report a per-voucher currency on these books — probed live
 * 2026-08-13, no CURRENCYNAME or FOREX element appears on any voucher or entry — so
 * this server CANNOT tell a foreign-currency transaction from a base-currency one and
 * labels every figure with the company's base currency.
 *
 * On a single-currency company that is exactly right, and silent is correct. On a
 * multi-currency company it is a real mislabelling risk on every figure, so it is
 * disclosed. Detecting it is the honest half of a problem that cannot be solved
 * without a per-transaction field Tally does not send: the reader is told the label
 * may be wrong instead of being left to assume it is right.
 *
 * Guessing at a field name to "handle" forex is exactly what this project does not
 * do — see docs/known-limitations.md.
 */
async function noteMultiCurrency(
  deps: ToolDeps,
  base: string,
  warnings: string[],
  /**
   * Scoped to the company. Unscoped, this answered for whichever company
   * TallyPrime considered current — so with three open it could report
   * another company's currency masters against these figures.
   */
  company?: string
): Promise<void> {
  try {
    const response = await deps.client.send(
      buildCurrencyListRequest({ company: company === undefined || company === '' ? UNSCOPED : company }),
      'standard'
    );
    const currencies = normalizeCurrencies(response.body).data;
    if (currencies.length <= 1) return;

    // A "?" in this list is a symbol TallyPrime substituted, not a currency named
    // "?" — worth saying, because a bare list of symbols invites the reader to
    // treat it as one. Where Tally DID transport a spelled-out name, it is
    // shown, because "European Euro" identifies the currency that "?" does not.
    const names = currencies
      .map((entry) =>
        currencyIsUnavailable(entry.name)
          ? `${entry.name} (symbol not transportable${entry.formalName === null ? '' : `, named "${entry.formalName}"`})`
          : entry.name
      )
      .join(', ');
    warnings.push(
      `This company defines ${String(currencies.length)} currencies (${names}) and every figure here is labelled with the base currency "${base}". TallyPrime does not report a per-transaction currency over this interface, so a transaction recorded in a different currency cannot be distinguished and may be labelled "${base}" incorrectly. Amounts are never converted. Check the currency on any figure that matters before relying on it.`
    );
  } catch (error) {
    // The currency list is a nicety; failing to read it must not fail the answer.
    deps.logger.debug('could not read the currency list', { error: String(error) });
  }
}

/**
 * How many currencies this company defines, or null when it could not be read.
 *
 * Used to decide whether a country may be turned into a currency label at all.
 * Verified live 2026-08-14: the German test company defines `$` alongside its
 * own base currency, so "registered in Germany" does NOT imply its books are
 * in euros. Where a company defines more than one currency the country tells
 * you nothing, and the derivation must not fire.
 *
 * Null (unreadable) is treated as "do not derive" by the caller: the whole
 * point of the check is to refuse when the ground is not solid.
 */
async function listDefinedCurrencies(
  deps: ToolDeps,
  /**
   * Scoped to the company on purpose. With three companies open, an unscoped
   * probe answers for whichever one TallyPrime considers current, so a
   * currency master could be read off the wrong company entirely.
   */
  company: string | undefined
): Promise<Currency[] | null> {
  try {
    const response = await deps.client.send(
      buildCurrencyListRequest({ company: company === undefined || company === '' ? UNSCOPED : company }),
      'standard'
    );
    return normalizeCurrencies(response.body).data;
  } catch (error) {
    deps.logger.debug('could not read the defined currencies', { error: String(error) });
    return null;
  }
}

/**
 * A currency label together with where it came from.
 *
 * The provenance is not decoration. A label TallyPrime transported, a label an
 * operator configured and a label inferred from the company's country are
 * three different strengths of fact, and cross-company arithmetic is only safe
 * over the first two — see `currencyIsComparable`.
 */
export interface ResolvedCurrency {
  label: string;
  source: CurrencySource;
  /** False when this label must not be subtracted from another company's. */
  comparable: boolean;
}

/**
 * Label-only form, for the many callers that just stamp a currency on figures
 * and have no cross-company arithmetic to protect.
 */
export async function resolveCompanyCurrency(
  deps: ToolDeps,
  company: string | undefined,
  warnings?: string[]
): Promise<string> {
  return (await resolveCompanyCurrencyDetailed(deps, company, warnings)).label;
}

export async function resolveCompanyCurrencyDetailed(
  deps: ToolDeps,
  company: string | undefined,
  /**
   * Collects the multi-currency caveat when there is one. Optional so a caller that
   * only needs the label — and has nowhere to put a warning — stays unaffected.
   */
  warnings?: string[]
): Promise<ResolvedCurrency> {
  const resolved = (label: string, source: CurrencySource): ResolvedCurrency => ({
    label,
    source,
    comparable: currencyIsComparable(source),
  });

  try {
    // Provenance RECORDED here: this decides the currency every amount is
    // labelled with. See withoutQueryLog on what must not be suppressed.
    const { companies } = await companyList(deps, { recordProvenance: true });

    // Never `companies[0]` on the unnamed path. Currencies differ per company —
    // dollars, euros, rupees across the three seen live — so picking the first
    // would label one company's figures in another's currency.
    const match =
      company === undefined || company === ''
        ? companies.length === 1
          ? companies[0]
          : undefined
        : companies.find((entry) => entry.name.toLowerCase() === company.toLowerCase());

    if (match === undefined && companies.length > 1) {
      warnings?.push(
        'CURRENCY NOT ESTABLISHED: several companies are loaded in TallyPrime and this request ' +
          'did not name one, so which company answered — and therefore which currency these ' +
          `figures are in — cannot be determined. They are labelled "${UNKNOWN_CURRENCY}" rather ` +
          'than assuming. Name the company to get a currency on them.'
      );
      return resolved(UNKNOWN_CURRENCY, 'unresolved');
    }

    const currency = match?.currency?.trim();

    /*
     * A symbol TallyPrime could not transport is reported as unknown, not passed
     * through and not defaulted.
     *
     * Passing it through labels every figure `"currency": "?"`, which reads as
     * data. Defaulting it is worse: it would label a euro company's balances INR,
     * the precise bug fixed on 2026-08-13. Saying "unknown" and naming the country
     * lets the reader supply the currency from the books, which is the only place
     * the answer actually exists.
     */
    if (currencyIsUnavailable(currency)) {
      // The operator may have supplied the label the books actually use. It is
      // consulted ONLY here — never where Tally sent a symbol successfully — so
      // a setting left over from another company cannot relabel figures whose
      // currency Tally reported perfectly well.
      const rule = currencyLabelFor(
        deps.config.tallyCurrencyLabel,
        match?.name,
        companies.length
      );

      /*
       * Precedence, and why.
       *
       * 1. TALLY_CURRENCY_LABEL. An operator stating what the books use
       *    outranks everything, because they can see the books.
       * 2. Tally's own spelled-out name for the SAME currency. Verified live
       *    2026-08-15: the symbol will not transport but MAILINGNAME does, so
       *    a company reporting symbol "?" also reports "European Euro". That
       *    is a fact from the company's own currency master, not a guess, and
       *    it is what closes this gap for real.
       * 3. The country. An inference, used only when nothing above answered
       *    and only where it cannot be ambiguous.
       */
      const defined = rule === null ? await listDefinedCurrencies(deps, match?.name) : null;

      // Matched on the substituted symbol. Where two currencies both failed to
      // transport they would BOTH read "?", and there would be no way to tell
      // which is the base — so an ambiguous match resolves to nothing rather
      // than picking one.
      const symbolMatches = (defined ?? []).filter((entry) => entry.name === currency);
      const formalLabel =
        symbolMatches.length === 1 ? labelFromFormalName(symbolMatches[0]?.formalName) : null;

      // The country is consulted ONLY when the company defines a single
      // currency. Where a second is defined, the country cannot establish
      // which one the books are kept in — the German company that also
      // defines "U$" is the live case.
      const derived =
        rule === null && formalLabel === null && defined?.length === 1
          ? currencyForCountry(match?.country)
          : null;

      const label = rule?.label ?? formalLabel ?? derived ?? UNKNOWN_CURRENCY;
      const source: CurrencySource =
        rule !== null
          ? 'configuration'
          : formalLabel !== null
            ? 'tally-formal-name'
            : derived !== null
              ? 'derived-from-country'
              : 'unresolved';

      if (warnings !== undefined) {
        const where =
          match?.country === null || match?.country === undefined || match.country === ''
            ? 'TallyPrime did not report a country either'
            : `TallyPrime reports the country as ${match.country}`;

        const unlabelled =
          `The base currency of "${match?.name ?? 'this company'}" could not be read: ` +
          `TallyPrime reported the symbol as "${currency ?? ''}", which is a substitution ` +
          'rather than a symbol — the character is not in the codepage TallyPrime exports ' +
          'with, and it is replaced before the data leaves TallyPrime, so no setting here ' +
          `can recover it. Every figure in this response is therefore labelled ` +
          `"${UNKNOWN_CURRENCY}". ${where}. Amounts are exact and are never converted — ` +
          "only the label is missing. State the currency from the company's own records " +
          'when quoting any figure, and do NOT assume a currency from the country: this ' +
          'company also defines other currencies.';

        if (formalLabel !== null) {
          // Resolved, and from Tally. Still worth one line, because the label
          // did not come from the field a reader would expect it to.
          warnings.push(
            `The currency symbol for "${match?.name ?? 'this company'}" could not be ` +
              `transported — TallyPrime reported it as "${currency ?? ''}", a substitution made ` +
              'before the data left TallyPrime. The label used here comes instead from the ' +
              `currency's spelled-out name in the company's own currency master, which ` +
              `TallyPrime DID transport: "${symbolMatches[0]?.formalName ?? ''}", shown as ` +
              `"${formalLabel}". This is read from the books, not inferred. Amounts are exact ` +
              'and are never converted.'
          );
        } else if (derived !== null) {
          // Labelled, but from an inference rather than from the books. Said
          // in full, because a reader who cannot tell an inferred label from a
          // reported one has no way to know which figures to double-check.
          warnings.push(
            `CURRENCY LABEL INFERRED FROM THE COUNTRY, NOT REPORTED BY TALLYPRIME. TallyPrime ` +
              `could not transport the symbol for "${match?.name ?? 'this company'}" — it ` +
              `reported "${currency ?? ''}", a substitution made before the data left ` +
              `TallyPrime. ${where}, so every figure here is labelled "${derived}" on that ` +
              'basis. THIS IS AN INFERENCE ABOUT THE COMPANY, NOT A FACT ABOUT ITS BOOKS: a ' +
              'company registered in one country may keep its books in another currency, so ' +
              'confirm the label against the books before quoting any figure externally. ' +
              'Amounts are exact and nothing is converted — only the label is inferred. ' +
              'No difference is computed between this company and any other, because an ' +
              'inferred label cannot establish that two companies share a currency. Set ' +
              'TALLY_CURRENCY_LABEL to state the currency instead of inferring it.'
          );
        } else if (rule === null) {
          warnings.push(
            deps.config.tallyCurrencyLabel === undefined
              ? `${unlabelled} To have the label filled in for you, set TALLY_CURRENCY_LABEL in ` +
                  'the server configuration.'
              : // Set, but not applicable here. Saying WHY matters: an operator
                // who has configured a label and still sees "unknown" will
                // otherwise assume the setting is broken.
                `${unlabelled} TALLY_CURRENCY_LABEL IS SET BUT DOES NOT APPLY TO THIS COMPANY. ` +
                  `TallyPrime has ${String(companies.length)} companies loaded, so a bare label ` +
                  'cannot be attributed to one of them — and it must not be guessed, because a ' +
                  'German and an Indian company both report their symbol as "?" and a bare "EUR" ' +
                  'would label rupees EUR. Name the companies instead, as ' +
                  '"Company Name=EUR;Other Company=INR".'
          );
        } else {
          warnings.push(
            'CURRENCY LABEL SUPPLIED BY CONFIGURATION, NOT BY TALLYPRIME. TallyPrime could ' +
              `not transport the symbol for "${match?.name ?? 'this company'}" — it reported ` +
              `"${currency ?? ''}", a substitution made before the data left TallyPrime — so ` +
              `every figure here is labelled "${rule.label}" from TALLY_CURRENCY_LABEL in this ` +
              `server's configuration. ${where}. Amounts are exact and nothing is converted; ` +
              'the label is the only part that did not come from Tally. ' +
              (rule.scope === 'named-company'
                ? 'The setting names this company specifically, so it cannot be confused with ' +
                  'another company loaded alongside it.'
                : 'The setting is a bare label and was applied because this is the only company ' +
                  'TallyPrime has loaded. If a second company is opened, it stops applying and ' +
                  'figures go back to being labelled "unknown" — name the companies in the ' +
                  'setting to avoid that.')
          );
        }
      }
      // Still worth reporting a multi-currency company, and the base label it
      // would be compared against is whatever was resolved above.
      if (warnings !== undefined) await noteMultiCurrency(deps, label, warnings, match?.name);
      return resolved(label, source);
    }

    const base = currency === undefined || currency === '' ? DEFAULT_CURRENCY : currency;

    if (warnings !== undefined) await noteMultiCurrency(deps, base, warnings, match?.name);

    return resolved(base, 'tally');
  } catch (error) {
    // A figure with a slightly wrong LABEL is recoverable; refusing the whole
    // answer because the currency probe failed is not. Every caller has already
    // proved Tally is reachable, so this only fires on an odd response shape.
    //
    // Marked 'unresolved' rather than 'tally': the default label was not read
    // from anywhere, so it must not license cross-company arithmetic.
    deps.logger.debug('could not resolve the company currency; using the default', {
      error: String(error),
    });
    return resolved(DEFAULT_CURRENCY, 'unresolved');
  }
}
