import type { DateRange } from '../../utils/dates.js';

/**
 * Somewhere to keep the answers for years before the current one, between runs.
 *
 * Only the unattended export passes one; see src/export/priorYears.ts. Keyed on
 * the exact request text, and what it holds is Tally's own response, so a saved
 * year goes through the same parser as a fresh one and cannot come out
 * differently.
 */
export interface PriorYearStore {
  /** The saved response to exactly this request, or null to ask Tally. */
  read(request: string): { body: string; repairs: string[] } | null;
  write(request: string, response: { body: string; repairs: string[] }): void;
}

/** Said on the Manifest whenever earlier years were not re-read. */
export function carriedOverWarning(carriedOver: readonly DateRange[]): string {
  const first = carriedOver[0]?.fromDate ?? '';
  const last = carriedOver.at(-1)?.toDate ?? '';
  return (
    `EARLIER YEARS CARRIED OVER: vouchers dated ${first} to ${last} were not re-read from ` +
    'TallyPrime for this export; they are the copy read at the last full export, which ' +
    'runs at least once a day. The current year was read fresh. An edit made today to an ' +
    'earlier year appears at the next full export.'
  );
}
