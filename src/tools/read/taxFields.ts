/**
 * What the GST and TDS tools genuinely share.
 *
 * The two files were described as near-duplicates, and in their small parts they
 * were: an identical `UNINFORMATIVE_VALUES` set, an identical group default, and
 * two `is*Key` functions with the same body over different hint lists. Those are
 * here.
 *
 * What is NOT here, deliberately: the summary and transaction views themselves.
 * They look alike in outline and differ in every particular that matters — TDS
 * gates on Indian jurisdiction, classifies deductee and exempt ledgers, and
 * carries three different unconfigured findings; GST separates company-level
 * registration from transaction content, matches nested structures, and reports
 * entry-level detail. Parameterising a shared skeleton over those differences
 * would mean one function with a flag for every one of them, which is harder to
 * read than the two it replaced and risks changing what an accountant is told.
 * Shared plumbing, separate judgement.
 */

/**
 * Tally group names for tax ledgers. Overridable, since companies rename groups.
 */
export const DEFAULT_TAX_GROUPS = ['Duties & Taxes'];

/**
 * Values that carry no information even on a field that matched a tax hint.
 *
 * Tally populates tax fields with explicit negatives on records that have no tax
 * involvement at all, so presence of a field is not evidence of anything. This
 * matters most for TDS: `ISTDSAPPLICABLE: "No"` and `TDSDEDUCTEESPECIALRATE:
 * "0"` are stamped onto every ledger in the company, so treating presence as
 * evidence reported all 330 ledgers of a real book as TDS-configured.
 */
const UNINFORMATIVE_VALUES = new Set(['', 'not applicable', 'no', '0', '0.00', 'unknown']);

/** True when a field value says something, rather than saying "not this one". */
export function isInformativeValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !UNINFORMATIVE_VALUES.has(value.trim().toLowerCase());
}

/**
 * A field-name matcher over Tally's concatenated upper-case names.
 *
 * Substring matching on names with no separators is inherently approximate in
 * both directions, and both callers had learned it the same way: `GST` matches
 * numberin·**GST**·yle on every voucher Tally emits, and `SECTION` matches
 * `CROSSSECTION`. So a hint list alone is not enough — the denylist is part of
 * the contract, not an afterthought, and lives next to the hints it corrects.
 *
 * Kept as an explicit denylist rather than a cleverer pattern because the
 * collisions are discovered against real data, one company at a time, and a
 * named exception is reviewable where a regex is not.
 */
export function taxKeyMatcher(
  hints: readonly string[],
  falsePositives: ReadonlySet<string>
): (key: string) => boolean {
  return (key: string): boolean => {
    const upper = key.toUpperCase();
    if (falsePositives.has(upper)) return false;
    return hints.some((hint) => upper.includes(hint));
  };
}

/** The `taxGroups` parameter description, identical for both tools. */
export function taxGroupsDescription(defaults: readonly string[]): string {
  return (
    `summary only. Groups holding tax ledgers. Defaults to ${defaults.map((g) => `"${g}"`).join(', ')}. ` +
    'Override if this company uses different group names.'
  );
}
