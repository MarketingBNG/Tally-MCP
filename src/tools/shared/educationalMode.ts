/**
 * Companies seen running in TallyPrime Educational mode.
 *
 * Educational mode accepts voucher dates only on the 1st, 2nd and 31st, and
 * there is no way to ask Tally which mode it runs in. A rejected voucher is not
 * harmless — verified live 2026-10-14, it leaves a hidden trace that makes the
 * ledgers it named undeletable — so once a company has rejected a date for this
 * reason, further vouchers on other days are refused before they are sent.
 * Held in memory: a restart forgets, and the first rejection teaches it again.
 */
const seen = new Set<string>();

export const EDUCATIONAL_DAYS = ['01', '02', '31'];

export function markEducationalMode(company: string): void {
  seen.add(company);
}

export function isKnownEducationalMode(company: string): boolean {
  return seen.has(company);
}

/** For tests. */
export function forgetEducationalMode(): void {
  seen.clear();
}
