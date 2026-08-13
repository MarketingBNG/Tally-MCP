/**
 * Text matching.
 *
 * Every search this server performs is a case-insensitive substring test, and
 * deliberately nothing cleverer. Fuzzy matching is the wrong default in an
 * audit context: a near-match quietly folded into an answer is worse than no
 * match, because the user cannot see that it was a guess. Tool descriptions
 * state this so Claude reports "nothing matched" rather than retrying with a
 * looser interpretation.
 */

/**
 * True when any of `values` contains `needle`, ignoring case.
 *
 * Null and undefined values are skipped rather than coerced to `''`: an absent
 * parent group must not match, and coercion would make every record match an
 * empty needle.
 */
export function matchesText(
  needle: string,
  ...values: readonly (string | null | undefined)[]
): boolean {
  const lowered = needle.toLowerCase();
  return values.some(
    (value) => value !== null && value !== undefined && value.toLowerCase().includes(lowered)
  );
}
