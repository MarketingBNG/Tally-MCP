import type { Money } from '../utils/numbers.js';
import type { SignedAmount } from '../model/ledger.js';

/**
 * Machine-readable findings, alongside the prose warnings.
 *
 * WHY THIS EXISTS. Everything a tool wanted to say used to go into one
 * `warnings: string[]`: "this ledger is out by 4,318.20" sat in the same array,
 * in the same shape, as "a nil balance is not meaningful". Severity was implicit
 * in the wording, so telling a real exception from an informational note meant
 * reading each string carefully — impossible to triage automatically, and easy
 * to skim past when it matters most.
 *
 * A finding is the machine-readable half of the same message: a severity, a
 * stable `code`, the subject it concerns, and the figures that produced it.
 * `message` carries the prose so nothing is lost to a consumer that only reads
 * findings.
 *
 * WARNINGS ARE NOT REPLACED. Every finding's message is still pushed to
 * `warnings` too, because an operator reading a raw response — and a model
 * summarising one — should not have to know this array exists to see that
 * something is wrong. Findings are an addition, not a migration.
 */

/**
 * How much attention a finding demands.
 *
 * Three levels, not five: the distinction that matters to an accountant is
 * "the books are out" / "I could not check" / "context you should know", and
 * finer gradations would be this server making materiality judgements that
 * belong to the engagement team.
 */
export type FindingSeverity =
  /** The books are out, or a figure is wrong. Blocks reliance on the numbers. */
  | 'exception'
  /** Could be neither confirmed nor refuted. Not a pass — coverage is incomplete. */
  | 'not_checkable'
  /** True and worth knowing, but nothing is wrong. */
  | 'info';

export interface Finding {
  severity: FindingSeverity;
  /**
   * Stable identifier for this kind of finding, e.g. `voucher_out_of_balance`.
   * Stable across releases so a dashboard can filter on it without matching prose.
   */
  code: string;
  /** What the finding is about — a ledger name, a voucher number, a company. */
  subject: string | null;
  /** The company these figures belong to. Set on every finding in a batch run. */
  company?: string | null;
  /** Human-readable form. The same text that appears in `warnings`. */
  message: string;
  /** Figures behind the finding, when it has any. Never re-derived by the reader. */
  figures?: Record<string, Money | SignedAmount | string | number | null>;
}

/** Count findings by severity, so a caller can triage without walking the list. */
export function summariseFindings(findings: readonly Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = {
    exception: 0,
    not_checkable: 0,
    info: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * The most severe level present, or null when there are no findings.
 *
 * Lets a caller branch on one value rather than reasoning over the counts.
 */
export function highestSeverity(findings: readonly Finding[]): FindingSeverity | null {
  if (findings.some((finding) => finding.severity === 'exception')) return 'exception';
  if (findings.some((finding) => finding.severity === 'not_checkable')) return 'not_checkable';
  if (findings.some((finding) => finding.severity === 'info')) return 'info';
  return null;
}
