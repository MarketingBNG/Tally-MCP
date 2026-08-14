import { Decimal } from 'decimal.js';
import type { Money } from '../utils/numbers.js';

/**
 * Period-over-period comparison of two runs of the same statement.
 *
 * "Compare this year with last" is one of the most common questions asked of a
 * set of books, and until now it took two calls plus arithmetic done by hand on
 * figures whose null/zero distinction is easy to lose. This does the pairing
 * and the subtraction once, under rules strict enough that a wrong pairing
 * cannot happen silently.
 *
 * ## Two rules, both there to prevent an invented figure
 *
 * **Rows pair by name, and only when the name is unambiguous.** TallyPrime's
 * statements contain headings and subtotals as ordinary rows, so a name can
 * legitimately appear more than once, and the two periods need not contain the
 * same rows in the same order at all — a group with no activity in one period
 * is simply absent from it. Positional pairing would therefore report one
 * account's movement under another account's name, which is the same class of
 * bug the parser's positional pairing exists to avoid (see
 * docs/known-limitations.md, "Reports return parallel arrays"). So a name
 * appearing twice on either side is NOT paired; it is reported as ambiguous,
 * with both periods' rows still returned in full so nothing is hidden.
 *
 * **A change is computed only when both figures are present.** Tally reports
 * an empty column as null, which means "nothing here", not zero — the two
 * appear side by side in real data. Treating a null as 0 would turn "Tally
 * reported nothing" into a movement of the full amount of the other period,
 * which is a fabricated figure in the place it would be least likely to be
 * questioned. Where either side is null the change is null and `basis` says
 * which side was missing.
 */

/** Every figure on one statement row, by column name. */
export type RowFigures = Record<string, Money | null>;

/**
 * How to read a key and its figures off one row of a given statement.
 * Each statement uses different column names, and the flow reports key on a
 * month rather than an account, so the shape is supplied per statement.
 */
export interface ComparisonAdapter {
  /** What identifies the row — an account/group name, or a month label. */
  keyOf: (row: unknown) => string | null;
  /** The row's figures, by the same column names the statement already returns. */
  figuresOf: (row: unknown) => RowFigures;
  /** What `keyOf` returns, for messages: "group" or "month". */
  keyLabel: string;
}

export interface FigureChange {
  /** The figure in the requested period. */
  current: Money | null;
  /** The figure in the comparison period. */
  previous: Money | null;
  /**
   * current − previous, in Tally's own sign convention on both sides, so the
   * result is a movement in Tally's encoding and NOT a plain-English
   * "increase". A debit balance growing larger becomes more negative.
   *
   * Null whenever either side is null. See `basis`.
   */
  change: Money | null;
  /** Why `change` is null, when it is. Absent when the subtraction was done. */
  basis?: string;
}

export interface RowComparison {
  /** The row identity both periods matched on. */
  name: string;
  /** One entry per column the statement reports. */
  figures: Record<string, FigureChange>;
}

export interface UnpairedRows {
  /** Keys present in the requested period only — no comparison figure exists. */
  currentOnly: string[];
  /** Keys present in the comparison period only — absent from the requested one. */
  comparisonOnly: string[];
  /**
   * Keys appearing more than once on one or both sides, so which row pairs with
   * which is not decidable. Deliberately not guessed.
   */
  ambiguous: string[];
}

export interface StatementComparison {
  changes: RowComparison[];
  unpaired: UnpairedRows;
  warnings: string[];
}

/** Index rows by lowercased key, keeping every row that shares a key. */
function indexByKey(
  rows: readonly unknown[],
  adapter: ComparisonAdapter
): Map<string, { key: string; row: unknown }[]> {
  const index = new Map<string, { key: string; row: unknown }[]>();

  for (const row of rows) {
    const key = adapter.keyOf(row);
    // A row with no key at all is a spacer or a rendering artefact. It cannot
    // be paired and naming it would be meaningless, so it is skipped rather
    // than reported as unpaired.
    if (key === null || key.trim() === '') continue;

    const lowered = key.toLowerCase();
    const existing = index.get(lowered) ?? [];
    existing.push({ key, row });
    index.set(lowered, existing);
  }

  return index;
}

function subtract(current: Money | null, previous: Money | null): FigureChange {
  if (current === null && previous === null) {
    return {
      current,
      previous,
      change: null,
      basis: 'TallyPrime reported no figure in either period, which is not the same as zero.',
    };
  }
  if (current === null) {
    return {
      current,
      previous,
      change: null,
      basis:
        'TallyPrime reported no figure for the requested period. Not treated as zero, so no ' +
        'change is computed — read this as "nothing reported", not "fell to nil".',
    };
  }
  if (previous === null) {
    return {
      current,
      previous,
      change: null,
      basis:
        'TallyPrime reported no figure for the comparison period. Not treated as zero, so no ' +
        'change is computed — read this as "nothing reported", not "rose from nil".',
    };
  }
  if (current.currency !== previous.currency) {
    return {
      current,
      previous,
      change: null,
      basis: `Currencies differ (${current.currency} vs ${previous.currency}); the figures are not subtractable.`,
    };
  }

  return {
    current,
    previous,
    change: {
      amount: new Decimal(current.amount).minus(new Decimal(previous.amount)).toFixed(),
      currency: current.currency,
    },
  };
}

/**
 * Pair two runs of one statement and compute the movement per figure.
 *
 * Both row sets are returned to the caller unchanged elsewhere; this adds the
 * pairing, and says explicitly what it could not pair.
 */
export function compareStatements(
  currentRows: readonly unknown[],
  comparisonRows: readonly unknown[],
  adapter: ComparisonAdapter
): StatementComparison {
  const currentIndex = indexByKey(currentRows, adapter);
  const comparisonIndex = indexByKey(comparisonRows, adapter);

  const changes: RowComparison[] = [];
  const unpaired: UnpairedRows = { currentOnly: [], comparisonOnly: [], ambiguous: [] };

  for (const [lowered, currentEntries] of currentIndex) {
    const first = currentEntries[0];
    if (first === undefined) continue;
    const displayName = first.key;
    const comparisonEntries = comparisonIndex.get(lowered);

    if (comparisonEntries === undefined) {
      unpaired.currentOnly.push(displayName);
      continue;
    }
    if (currentEntries.length > 1 || comparisonEntries.length > 1) {
      unpaired.ambiguous.push(displayName);
      continue;
    }

    const currentFigures = adapter.figuresOf(first.row);
    const previousFigures = adapter.figuresOf(comparisonEntries[0]?.row);

    const figures: Record<string, FigureChange> = {};
    // Union of column names, so a column present on only one side still
    // appears rather than being dropped for the row.
    for (const column of new Set([
      ...Object.keys(currentFigures),
      ...Object.keys(previousFigures),
    ])) {
      figures[column] = subtract(currentFigures[column] ?? null, previousFigures[column] ?? null);
    }

    changes.push({ name: displayName, figures });
  }

  for (const [lowered, comparisonEntries] of comparisonIndex) {
    if (currentIndex.has(lowered)) continue;
    const first = comparisonEntries[0];
    if (first !== undefined) unpaired.comparisonOnly.push(first.key);
  }

  const warnings: string[] = [];
  if (unpaired.ambiguous.length > 0) {
    warnings.push(
      `${String(unpaired.ambiguous.length)} ${adapter.keyLabel} name(s) appear more than once in ` +
        'one or both periods, so no change was computed for them: ' +
        `${unpaired.ambiguous.join(', ')}. TallyPrime statements include headings and subtotals as ` +
        'ordinary rows, so a repeated name is normal. Read those rows from the two row sets ' +
        'directly rather than assuming which pairs with which.'
    );
  }
  if (unpaired.currentOnly.length > 0 || unpaired.comparisonOnly.length > 0) {
    warnings.push(
      `Some ${adapter.keyLabel}s appear in only one period, so they have no comparison figure: ` +
        `${String(unpaired.currentOnly.length)} in the requested period only, ` +
        `${String(unpaired.comparisonOnly.length)} in the comparison period only. This normally ` +
        'means the group had no activity in the other period. It is NOT a zero — the row is ' +
        'absent, and reporting it as a fall or rise to nil would overstate what Tally said.'
    );
  }

  return { changes, unpaired, warnings };
}

// ---------------------------------------------------------------------------
// Trend: the same statement across N periods
// ---------------------------------------------------------------------------

/**
 * A trend is the two-period comparison generalised, and it keeps both of that
 * comparison's rules for the same reasons.
 *
 * **Rows pair by name, and an ambiguous name is not paired.** A name appearing
 * twice in ANY period disqualifies that row across the whole series — not just
 * in the period where it repeated. Pairing it elsewhere and dropping it in one
 * place would produce a series with a hole that looks like an absence of data
 * rather than an absence of certainty.
 *
 * **A row missing from a period is null, never zero.** This matters more in a
 * trend than in a comparison, because a series is normally read as a shape:
 * five figures and a zero reads as "it fell to nothing", when what happened is
 * that Tally did not report the row at all. Which periods a row was actually
 * present in is returned alongside the series, so the shape can be read
 * correctly.
 */
export interface TrendRow {
  key: string;
  /**
   * One value per period, in the order the periods were given. `null` means the
   * row was absent from that period, or present with no figure in that column.
   */
  figures: Record<string, (Money | null)[]>;
  /**
   * Movement between consecutive periods: index `i` is period `i+1` minus
   * period `i`, so a series of N periods has N−1 movements. Computed only
   * where both sides are present, exactly as in the two-period comparison.
   */
  movements: Record<string, FigureChange[]>;
  /** Indices of the periods this row actually appeared in. */
  presentIn: number[];
}

export interface StatementTrend {
  rows: TrendRow[];
  /** Names that could not be tracked, with the reason. */
  unpaired: {
    /** Appeared more than once in at least one period, so pairing is unsafe. */
    ambiguous: string[];
  };
  warnings: string[];
}

/**
 * Track every row of one statement across N periods.
 *
 * The periods are NOT sorted here. They are returned in the order given,
 * because "compare Q4 against Q1" is a legitimate question and silently
 * reordering the caller's periods would relabel every movement.
 */
export function buildTrend(
  periodRows: readonly (readonly unknown[])[],
  adapter: ComparisonAdapter
): StatementTrend {
  const indexes = periodRows.map((rows) => indexByKey(rows, adapter));

  // A key is ambiguous if ANY period reported it more than once.
  const ambiguous = new Set<string>();
  const displayNames = new Map<string, string>();
  for (const index of indexes) {
    for (const [lowered, entries] of index) {
      const first = entries[0];
      if (first === undefined) continue;
      // First spelling wins, so the series is labelled consistently even where
      // capitalisation differs between periods.
      if (!displayNames.has(lowered)) displayNames.set(lowered, first.key);
      if (entries.length > 1) ambiguous.add(lowered);
    }
  }

  const rows: TrendRow[] = [];
  for (const [lowered, displayName] of displayNames) {
    if (ambiguous.has(lowered)) continue;

    const presentIn: number[] = [];
    const perPeriod: (RowFigures | null)[] = indexes.map((index, position) => {
      const entry = index.get(lowered)?.[0];
      if (entry === undefined) return null;
      presentIn.push(position);
      return adapter.figuresOf(entry.row);
    });

    // The union of column names, because a statement can report a column in one
    // period and omit it in another. Restricting to the first period's columns
    // would silently drop a figure that exists.
    const columns = new Set<string>();
    for (const figures of perPeriod) {
      if (figures !== null) for (const column of Object.keys(figures)) columns.add(column);
    }

    const figures: Record<string, (Money | null)[]> = {};
    const movements: Record<string, FigureChange[]> = {};
    for (const column of columns) {
      const series = perPeriod.map((row) => row?.[column] ?? null);
      figures[column] = series;
      movements[column] = series
        .slice(1)
        .map((value, position) => subtract(value, series[position] ?? null));
    }

    rows.push({ key: displayName, figures, movements, presentIn });
  }

  const warnings: string[] = [];
  if (ambiguous.size > 0) {
    warnings.push(
      `${String(ambiguous.size)} row name(s) appeared more than once in at least one period, so ` +
        'they are not tracked across the series: ' +
        [...ambiguous].map((key) => `"${displayNames.get(key) ?? key}"`).join(', ') +
        '. TallyPrime statements carry headings and subtotals as ordinary rows, so a repeated ' +
        'name is not unusual — but tracking one would risk reporting one account movement under ' +
        "another account's name. Read those rows from each period's own figures instead."
    );
  }

  const partial = rows.filter((row) => row.presentIn.length < periodRows.length);
  if (partial.length > 0) {
    warnings.push(
      `${String(partial.length)} row(s) are absent from at least one period. Their value for ` +
        'those periods is null, meaning TallyPrime did not report the row — NOT that the figure ' +
        'was zero. A series read as a shape will otherwise look like a fall to nothing. See ' +
        '`presentIn` on each row for which periods it actually appeared in.'
    );
  }

  return { rows, unpaired: { ambiguous: [...ambiguous] }, warnings };
}
