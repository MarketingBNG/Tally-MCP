import { TallyError } from '../../tally/TallyError.js';
import { buildCompanyListRequest } from '../../tally/requests.js';
import { normalizeCompanies, type Company } from '../../tally/normalize.js';
import { memoizeWithinCall, withoutQueryLog } from '../../tally/queryLog.js';
import { bookYearFor, type DateRange } from '../../utils/dates.js';
import type { TallyResponse } from '../../tally/TallyClient.js';
import { findByName, type ToolDeps } from '../toolResult.js';

/**
 * Which company an answer belongs to, and how its name is resolved.
 *
 * Moved out of toolResult.ts unchanged. Every one of these exists because of the
 * same shipped failure: with three companies loaded, one company's figures were
 * returned under another's name. They are the guards against that, so they
 * belong together where a reader can see the whole of the answer to "whose books
 * are these?" at once.
 */

/**
 * The one company every "which company is this?" answer must agree on.
 *
 * ## The bug this exists to prevent
 *
 * Every site below used to take `companies[0]` — the first company in Tally's
 * list — on the premise, written into the comments, that "TallyPrime serves one
 * company at a time, so the loaded company IS the scope of the answer". That
 * premise is false. TallyPrime holds several companies open at once, and
 * `SVCURRENTCOMPANY` picks between them per request.
 *
 * With one company loaded, `companies[0]` was always right. With three loaded it
 * is whichever sorts first, regardless of which one was asked about — so a
 * request scoped to a US company came back with its figures correctly fetched and
 * the envelope naming a GERMAN company. Right numbers, wrong name on them, no
 * error raised. That is the single worst output this connector can produce, and
 * it survived a full test suite because every fixture had one company.
 *
 * ## How the company is determined now
 *
 * From the requests that were actually sent. Every request scoped to a company
 * carries `<SVCURRENTCOMPANY>`, so the sent bodies are ground truth about what
 * was asked — better evidence than anything re-derived afterwards.
 *
 * When nothing was scoped, there is a real fork:
 * - exactly one company loaded → that is unambiguously the answer;
 * - more than one loaded → TallyPrime answered from whichever company is ACTIVE
 *   on the desktop, and nothing in the response says which. So the answer is
 *   `null`, meaning "not resolved". Guessing here is what caused the bug.
 */
export function companyFromSentRequests(bodies: readonly string[]): string | null {
  const named = new Set<string>();
  for (const body of bodies) {
    const match = /<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/.exec(body);
    const name = match?.[1]?.trim();
    if (name !== undefined && name !== '') named.add(name);
  }
  // Several distinct companies means a genuinely multi-company answer, which no
  // single company_id describes. Null is the honest value, not the first one.
  return named.size === 1 ? ([...named][0] ?? null) : null;
}

/**
 * The company list, sent once per site but PARSED once per tool call.
 *
 * Six call sites needed this list — `soleLoadedCompany`, `companyNamed`,
 * `resolveCompanyId`, `resolveCompanyCurrency`, and both company tools — and
 * each ran `parseTallyXml` + `normalizeCompanies` over the identical cached
 * body. The response cache removed the round trip and left the parse, six times
 * over, for one answer.
 *
 * The send is NOT memoised here, deliberately, and that is the whole design.
 * Whether a request belongs in `source_query` differs per site: name resolution
 * contributes to no figure and is suppressed, while the currency lookup decides
 * the label on every amount and must be recorded. Memoising the send would let
 * whichever site happened to run first decide that for all of them — and the
 * failure mode is a figure whose provenance is silently dropped because some
 * unrelated helper asked first. So each site still sends, which is a cache hit
 * and a provenance note, and only the parse is shared.
 *
 * Scoped to one tool call by `memoizeWithinCall`, so it cannot serve an earlier
 * question's company list: within a single question, Tally's answer to the same
 * request cannot have legitimately changed.
 */
export async function companyList(
  deps: ToolDeps,
  options: { recordProvenance: boolean }
): Promise<{ companies: Company[]; warnings: string[] }> {
  const send = (): Promise<TallyResponse> =>
    deps.client.send(buildCompanyListRequest(), 'standard');

  // Name resolution contributes to no figure, so it is kept out of
  // `source_query`. See withoutQueryLog for what must NOT be suppressed.
  const response = options.recordProvenance ? await send() : await withoutQueryLog(send);

  const parsed = await memoizeWithinCall('parse:companyList', () =>
    Promise.resolve(normalizeCompanies(response.body))
  );

  return { companies: parsed.data, warnings: [...response.repairs, ...parsed.warnings] };
}

/**
 * The loaded company when — and only when — there is exactly one.
 *
 * Returns null with several loaded, because which one TallyPrime would answer
 * from is not knowable from the company list.
 */
async function soleLoadedCompany(deps: ToolDeps): Promise<Company | null> {
  const { companies } = await companyList(deps, { recordProvenance: false });
  return companies.length === 1 ? (companies[0] ?? null) : null;
}

/** The company record a name refers to, or null. Never guesses. */
export async function companyNamed(deps: ToolDeps, name: string | undefined): Promise<Company | null> {
  const { companies } = await companyList(deps, { recordProvenance: false });
  if (name === undefined || name === '') {
    return companies.length === 1 ? (companies[0] ?? null) : null;
  }
  // Exact spelling first, then case-insensitively — see findByName. Two
  // companies differing only in case stay resolvable, which a lowercase-only
  // match could not do.
  return findByName(companies, name, (entry) => entry.name) ?? null;
}

/**
 * The loaded company's own book year, or null when it cannot be determined.
 *
 * Twelve months anchored on the month and day the company's books begin, ending
 * with the year that contains the last date it holds data for. Derived from the
 * company's own `startingFrom` and `endingAt`, never from an assumed 1 April.
 *
 * Never throws. A tool that could answer must not fail because a metadata
 * lookup did, so an unreadable company yields null and the caller falls back.
 *
 * Cheap in practice: this is the same company-list request every other guard
 * already makes, so TallyClient's cache serves it (measured 0 ms on a hit).
 */
export async function companyBookYear(
  deps: ToolDeps,
  /**
   * Which company's year. Omitted is only safe with ONE company loaded — with
   * several, the book years differ (a German calendar year against an Indian
   * April year), so defaulting to the first would silently answer about the
   * wrong twelve months.
   */
  company?: string
): Promise<DateRange | null> {
  try {
    const record = await companyNamed(deps, company);
    if (record === null) return null;
    const startingFrom = record.startingFrom ?? null;
    if (startingFrom === null) return null;
    // endingAt anchors the year, not today's date: a company holding 2019 books
    // does not become a 2026 company because someone opened it today.
    return bookYearFor(startingFrom, record.endingAt ?? startingFrom);
  } catch {
    return null;
  }
}

/**
 * Name the company the figures belong to.
 *
 * **Corrected 14 Aug 2026.** This used to read "TallyPrime serves one company at a
 * time, so the loaded company IS the scope of every answer" and take the first
 * company in the list. With three companies loaded that produced AgEx Pharma's
 * figures under AGBV Nutrition's name — the wrong-attribution failure this whole
 * codebase is written to avoid, shipped and unnoticed because every fixture had a
 * single company. See `companyFromSentRequests`.
 *
 * Never throws. A tool that produced a correct answer must not be turned into a
 * failure by a metadata lookup, so an unresolvable company is reported as null —
 * which the envelope documents as "not resolved", not "none". Null is also the
 * right answer, not a degradation, when several companies are loaded and the
 * request named none of them: nothing in the response says which one answered.
 */
export async function resolveCompanyId(
  deps: ToolDeps,
  /** The request bodies this answer was actually built from. */
  sentBodies: readonly string[]
): Promise<string | null> {
  // Ground truth first: what the requests were scoped to.
  const scoped = companyFromSentRequests(sentBodies);
  if (scoped !== null) return scoped;

  try {
    // Nothing scoped. Safe only when there is exactly one company to mean.
    return (await soleLoadedCompany(deps))?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Check that a named company is the one TallyPrime currently has loaded.
 *
 * Only called when the caller actually names a company — with no name, Tally
 * uses whatever is loaded and there is nothing to verify, so the extra
 * round trip is skipped entirely.
 *
 * The validation is done **here rather than by asking Tally**, deliberately.
 * TallyPrime serves one company at a time, so a request scoped to a company
 * it does not have open cannot succeed; and sending unverified names into
 * Tally's request path is the behaviour that has already been observed to
 * take the application down. Comparing against the loaded list first means an
 * unknown name never reaches Tally at all, and the caller gets a precise
 * error naming what *is* loaded.
 *
 * ## Returns the CANONICAL name, and callers must use it
 *
 * This used to return void, so the caller's own spelling continued on to
 * `SVCURRENTCOMPANY`. That is a wrong-attribution bug, because the match here is
 * case-INSENSITIVE while **TallyPrime matches the company name exactly**, and on
 * a mismatch Tally does not raise an error — it silently answers from whichever
 * company is loaded. So `company: "mudals technologies private limited"` passed
 * this check, went to Tally in that casing, and produced real figures labelled
 * with the caller's spelling rather than the company's own.
 *
 * With one company loaded the figures happened to be right. With two loaded it is
 * a silent wrong-company answer, which is the one failure a group comparison
 * could never survive — and the reason the multi-company tool must not ship until
 * this is in place.
 *
 * Also trims the input before comparing. Company names created by copy-paste
 * frequently carry a trailing CR or LF, and a trailing-whitespace mismatch is
 * documented to make Tally reject `SVCURRENTCOMPANY` in a way that is impossible
 * to diagnose from outside.
 *
 * @returns the exact name as TallyPrime spells it, or undefined when no company
 * was named (in which case Tally uses whatever is loaded and there is nothing to
 * canonicalise).
 */
export async function assertCompanyIsLoaded(
  deps: ToolDeps,
  company: string | undefined
): Promise<string | undefined> {
  if (company === undefined || company === '') return undefined;

  // Trim first: the comparison, the error message and the returned name must all
  // agree about what was asked for.
  const requested = company.trim();
  if (requested === '') return undefined;

  const { companies } = await companyList(deps, { recordProvenance: false });
  const loaded = companies.map((entry) => entry.name);

  // Return Tally's spelling, never the caller's — see the note above.
  const match = loaded.find((name) => name.toLowerCase() === requested.toLowerCase());
  if (match !== undefined) return match;

  const available =
    loaded.length === 0
      ? 'no company is currently loaded'
      : `currently loaded: ${loaded.join(', ')}`;

  throw new TallyError(
    'TALLY_COMPANY_NOT_LOADED',
    `TallyPrime does not have "${company}" open — ${available}.`,
    {
      suggestion:
        'Open that company in TallyPrime and try again. Tally serves data only for the company it currently has loaded, so this server cannot switch companies on your behalf.',
      context: { requested: company, loaded },
    }
  );
}
