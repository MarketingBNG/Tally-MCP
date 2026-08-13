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
