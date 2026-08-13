/**
 * Folding fields that never vary.
 *
 * ## The problem this solves
 *
 * TallyPrime emits the full superset of fields it supports on every record and
 * leaves the inapplicable ones empty. Dropping the empties yields exactly the
 * fields a company uses — that is what makes the open `fields` map work across
 * companies without a hardcoded list, and it is documented in
 * docs/known-limitations.md.
 *
 * But "populated" is not "informative". Measured on a real company's full
 * financial year, 453 vouchers carried **204 populated voucher-level fields of
 * which only 33 varied**. The other 171 held one identical value on every single
 * voucher — `ISDELETED: "No"`, `AUDITED: "No"`, `USEFORSERVICETAX: "No"` — and
 * re-sending them cost **50% of the entire payload**. A page of 25 full-detail
 * vouchers came to about 54,000 tokens, half of it the same constants repeated
 * 25 times.
 *
 * `tally_get_company` already made this distinction for ledgers, splitting
 * `distinguishingFields` from `uniformFields` on the grounds that reporting raw
 * presence "makes product defaults look like the company's most-used data". This
 * applies the same idea where the volume actually is.
 *
 * ## The rules, and why each one matters
 *
 * - **A field is folded only when every record carries it with the same value.**
 *   If a field is missing from even one record, that absence is information —
 *   Tally left it empty there — and folding would assert a value the record
 *   never had.
 * - **Nothing is folded below two records.** With one record every field is
 *   trivially "uniform", and folding would empty the record entirely.
 * - **The constants are still returned**, once, at the response level. This is a
 *   relocation, not a filter: every value Tally sent is still in the response,
 *   and a reader looking for a field checks two places rather than one. Silently
 *   dropping them would be a different and much worse change.
 */

/** What a fold produced: the constants, and how much they were costing. */
export interface UniformFold<T> {
  /** Records with the folded keys removed from their field maps. */
  records: T[];
  /**
   * Fields identical on every record, reported once. Empty when nothing
   * qualified, in which case the caller should omit it rather than emit `{}`.
   */
  uniformFields: Record<string, string>;
  /** How many field occurrences were relocated. For the explanatory note. */
  foldedOccurrences: number;
}

/**
 * Fold constants out of a collection's field maps.
 *
 * `read` gets a record's field map; `write` returns a copy of the record
 * carrying a replacement map. Both are supplied by the caller because the map
 * lives at a different path on each record type — `fields` on a voucher,
 * `instrument` on a bank row — and this must not guess.
 */
export function foldUniformFields<T>(
  records: readonly T[],
  read: (record: T) => Record<string, string> | undefined,
  write: (record: T, fields: Record<string, string>) => T
): UniformFold<T> {
  // Below two records there is nothing to compare, so nothing is uniform in any
  // meaningful sense. Returning the input untouched also keeps the single-record
  // "get one voucher" path allocation-free.
  if (records.length < 2) {
    return { records: [...records], uniformFields: {}, foldedOccurrences: 0 };
  }

  const seen = new Map<string, { value: string; count: number; varies: boolean }>();

  for (const record of records) {
    const fields = read(record);
    if (fields === undefined) continue;

    for (const [key, value] of Object.entries(fields)) {
      const existing = seen.get(key);
      if (existing === undefined) {
        seen.set(key, { value, count: 1, varies: false });
        continue;
      }
      existing.count += 1;
      if (existing.value !== value) existing.varies = true;
    }
  }

  // Present on EVERY record, and always the same. The count test is what stops
  // a field that is merely absent elsewhere from being asserted globally.
  const foldable = new Set<string>();
  const uniformFields: Record<string, string> = {};
  for (const [key, stat] of seen) {
    if (!stat.varies && stat.count === records.length) {
      foldable.add(key);
      uniformFields[key] = stat.value;
    }
  }

  if (foldable.size === 0) {
    return { records: [...records], uniformFields: {}, foldedOccurrences: 0 };
  }

  let foldedOccurrences = 0;
  const folded = records.map((record) => {
    const fields = read(record);
    if (fields === undefined) return record;

    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (foldable.has(key)) {
        foldedOccurrences += 1;
        continue;
      }
      kept[key] = value;
    }
    return write(record, kept);
  });

  return { records: folded, uniformFields, foldedOccurrences };
}

/**
 * The sentence that has to travel with a folded response.
 *
 * Without it a reader searching a record for `ISDELETED` finds nothing and could
 * conclude Tally did not report it. The saving is not worth that ambiguity, so
 * the note is not optional.
 */
export function uniformFieldsNote(count: number, occurrences: number, what: string): string {
  return (
    `${String(count)} field(s) held the same value on every ${what} in this response and are ` +
    `reported once under "uniformFields" instead of on each record — ${String(occurrences)} ` +
    'repetitions removed. Those fields ARE present on every record in TallyPrime; they were ' +
    'relocated, not dropped. Look in uniformFields before concluding a field is absent, and ' +
    'note that a constant value across every record is usually a TallyPrime default rather ' +
    "than something this company recorded, so it rarely answers a question about the company's data."
  );
}
