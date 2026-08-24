import type { Group } from '../tally/normalize.js';

/**
 * Membership questions about Tally's group hierarchy.
 *
 * "Is this ledger under Sundry Debtors?" is not the same question as "what is
 * this ledger's parent?", and five tools used to ask the second while meaning
 * the first:
 *
 *     const set = new Set(groups.map((g) => g.toLowerCase()));
 *     ledgers.filter((l) => set.has((l.parent ?? '').toLowerCase()));
 *
 * That matches the DIRECT parent only. A company that files its debtors under
 * `Sundry Debtors > Domestic` — an ordinary and encouraged Tally setup — has
 * every one of those ledgers silently dropped from the receivables list, the
 * confirmation list, the GST and TDS summaries and the fixed-asset register.
 * Not flagged, not counted as excluded: absent, from a result that reports
 * itself as the complete set. That is a wrong answer wearing a right answer's
 * clothes, which is the one failure this codebase is least willing to ship.
 *
 * So membership walks UP the tree from the ledger's parent until it reaches a
 * requested group or runs out of ancestors.
 *
 * WHY THIS IS NOT `adaptAccounts`. fromTally.ts already walks this hierarchy,
 * but it answers different questions — the full root-to-leaf path, and the
 * nearest classified ancestor — and it builds the whole account tree to do so.
 * Asking it "is X under Y" would mean adapting every account to test one
 * predicate. The walk is shared here in the form the predicate needs.
 */

/**
 * Normalise a group or parent name for comparison.
 *
 * Trimmed, not just lowercased. TallyPrime pads its primary-group name with a
 * leading space, and an untrimmed key misses in the map and stops the walk one
 * level early — the trap `derivedBalanceReason()` in tieOut.ts and
 * `noteMastersDivergence()` in reports.ts both document. Caller-supplied group
 * names get the same treatment, so a user's stray whitespace cannot silently
 * empty their result either.
 */
export function groupKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * What Tally puts in `PARENT` on a top-level group.
 *
 * "Primary" is a sentinel meaning "no parent", NOT a group that exists. Treated
 * as a real name it becomes a single ancestor shared by the entire chart of
 * accounts — so a caller who asked for "Primary", or a chart with a group
 * genuinely named that, would match every ledger in the company. Normalised to
 * null at the point the index is built, so no walk can ever reach it.
 * tests/fixtures/groups.xml keeps a live example of the trap.
 */
const PRIMARY_SENTINEL = 'primary';

/** Group name (normalised) to its parent's name (normalised, or null at a root). */
export type GroupIndex = ReadonlyMap<string, string | null>;

/**
 * Index the group collection for upward walks.
 *
 * Later duplicates lose to earlier ones. Tally group names are unique, so a
 * collision here means the payload was malformed; keeping the first is
 * arbitrary but stable, and the alternative — throwing — would fail a whole
 * tool over a defect the caller cannot act on.
 */
export function buildGroupIndex(groups: readonly Group[]): GroupIndex {
  const index = new Map<string, string | null>();

  for (const group of groups) {
    const key = groupKey(group.name);
    if (key === '' || index.has(key)) continue;
    const parent = groupKey(group.parent);
    index.set(key, parent === '' || parent === PRIMARY_SENTINEL ? null : parent);
  }

  return index;
}

/**
 * Upper bound on the walk, so a hierarchy this code did not build cannot hang it.
 *
 * The `seen` set below already terminates on any cycle, which is the real
 * hazard. This is the second line of defence: 50 is far beyond any real chart
 * of accounts, so hitting it means the data is pathological, and stopping is
 * then the same answer as continuing.
 */
const MAX_DEPTH = 50;

/**
 * Is `parent` — a ledger's group, or a group itself — at or under any of `targets`?
 *
 * `targets` must already be normalised through `groupKey`. Returns false for a
 * ledger with no parent: an unfiled ledger is under nothing, and reporting it
 * as a member of whatever was asked for would be an invention.
 */
export function isUnderAnyGroup(
  parent: string | null | undefined,
  targets: ReadonlySet<string>,
  index: GroupIndex
): boolean {
  let current = groupKey(parent);
  if (current === '') return false;

  const seen = new Set<string>();

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (targets.has(current)) return true;
    if (seen.has(current)) return false;
    seen.add(current);

    const next = index.get(current);
    // `undefined` means this ancestor is not in the group collection at all —
    // the chain is broken and there is nothing further up to test. `null` means
    // a primary group was reached, which is the top.
    if (next === undefined || next === null) return false;
    current = next;
  }

  return false;
}

/** Records filterable by group: a ledger, or anything else carrying a parent group. */
interface HasParent {
  parent: string | null;
}

/**
 * Select the records filed at or under any of `groupNames`.
 *
 * Returns warnings rather than throwing on unknown group names, and only when
 * they mattered: if the selection came back empty AND some requested group is
 * absent from the chart of accounts, the caller is told which. That is the case
 * where a reader would otherwise read "no receivables" as a fact about the
 * books instead of a typo or a company that files things elsewhere. A non-empty
 * selection stays silent — the absent group changed nothing, and a warning on
 * every default group list would be noise on the majority of calls.
 */
export function ledgersUnderGroups<T extends HasParent>(
  records: readonly T[],
  groups: readonly Group[],
  groupNames: readonly string[]
): { matched: T[]; warnings: string[] } {
  const index = buildGroupIndex(groups);
  const targets = new Set(groupNames.map(groupKey).filter((name) => name !== ''));

  const matched = records.filter((record) => isUnderAnyGroup(record.parent, targets, index));

  const warnings: string[] = [];
  // An empty chart means the group fetch degraded (see fetchGroupsForScoping).
  // The match above has already fallen back to direct-parent behaviour and that
  // caller has already warned about it; naming every requested group as
  // "not in the chart of accounts" here would be a second, misleading warning
  // about a chart that was never read.
  if (matched.length === 0 && groups.length > 0) {
    const unknown = groupNames.filter((name) => {
      const key = groupKey(name);
      return key !== '' && !index.has(key);
    });

    if (unknown.length > 0) {
      warnings.push(
        `No ledgers matched, and ${unknown.length === 1 ? 'this group is' : 'these groups are'} ` +
          `not in this company's chart of accounts: ${unknown.join(', ')}. ` +
          'The empty result reflects the group names asked for, not necessarily the books.'
      );
    }
  }

  return { matched, warnings };
}
