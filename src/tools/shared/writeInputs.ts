import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { Group, Ledger } from '../../tally/normalize.js';
import { TallyError } from '../../tally/TallyError.js';
import { fetchGroups } from '../read/groups.js';
import { fetchLedgers } from '../read/ledgers.js';
import { assertCompanyIsLoaded, companyList, findByName, type ToolDeps } from './toolResult.js';

/**
 * Inputs and lookups shared by the write tools.
 *
 * Kept apart from the read tools' schemas because the rules differ: a read can
 * tolerate a near-match and report it, a write must name exactly one existing
 * record or refuse.
 */

/** A positive amount as a decimal string or number; the side is given separately. */
export const amountSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const text = String(value).replace(/,/g, '').trim();
    if (!/^\d+(\.\d{1,4})?$/.test(text)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Amounts must be positive numbers with at most 4 decimals; give the side as Dr or Cr.',
      });
      return z.NEVER;
    }
    return new Decimal(text).toFixed();
  })
  .describe('Positive amount, e.g. "12500.00". Use the side field for debit or credit, never a minus sign.');

export const sideSchema = z.enum(['Dr', 'Cr']).describe('Dr for a debit, Cr for a credit.');

/**
 * Turn an amount and side into TallyPrime's own signed form.
 *
 * Tally's convention, as every read tool reports it: a DEBIT is NEGATIVE, a
 * credit positive. Stated here once so no write tool decides it for itself.
 */
export function toTallySigned(amount: string, side: 'Dr' | 'Cr'): string {
  const value = new Decimal(amount);
  return (side === 'Dr' ? value.negated() : value).toFixed();
}

/** The reverse, for previews: Tally's signed amount as "1,250.00 Dr". */
export function describeSigned(signed: string | null | undefined): string {
  if (signed === null || signed === undefined || signed === '') return 'nil';
  const value = new Decimal(signed);
  if (value.isZero()) return 'nil';
  return `${value.abs().toFixed(2)} ${value.isNegative() ? 'Dr' : 'Cr'}`;
}

/** The current ledger list, read fresh enough for a write decision. */
export async function currentLedgers(deps: ToolDeps, company: string): Promise<Ledger[]> {
  return (await fetchLedgers(deps, company)).ledgers;
}

export async function currentGroups(deps: ToolDeps, company: string): Promise<Group[]> {
  return (await fetchGroups(deps, company)).groups;
}

/**
 * Find a record a write will act on, by TallyPrime's case-insensitive name.
 *
 * TallyPrime treats names case-insensitively for uniqueness, so a write must
 * too: "cash" and "Cash" are the same ledger to Tally.
 */
export function findExisting<T>(records: readonly T[], name: string, nameOf: (r: T) => string): T | undefined {
  return findByName(records, name.trim(), nameOf);
}

/** Require an existing record, refusing with the nearest names when it is missing. */
export function requireExisting<T>(
  records: readonly T[],
  name: string,
  nameOf: (r: T) => string,
  kind: string
): T {
  const found = findExisting(records, name, nameOf);
  if (found !== undefined) return found;

  const wanted = name.trim().toLowerCase();
  const near = records
    .map(nameOf)
    .filter((candidate) => {
      const lower = candidate.toLowerCase();
      return lower.includes(wanted) || wanted.includes(lower);
    })
    .slice(0, 8);

  throw new TallyError(
    'INVALID_PARAMETERS',
    `There is no ${kind} named "${name}" in TallyPrime.` +
      (near.length > 0 ? ` Similar names: ${near.join('; ')}.` : ''),
    { suggestion: `Use the exact ${kind} name as it appears in TallyPrime (tally_get_masters lists them).` }
  );
}

/** Refuse a name that is already taken. Needed because Tally's Create silently alters an existing master. */
export function requireAbsent<T>(
  records: readonly T[],
  name: string,
  nameOf: (r: T) => string,
  kind: string
): void {
  const found = findExisting(records, name, nameOf);
  if (found !== undefined) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `A ${kind} named "${nameOf(found)}" already exists in TallyPrime.`,
      { suggestion: `To change it, use the alter tool. To make a new one, choose a different name.` }
    );
  }
}

/** The recheck form of requireAbsent: the books changed after the preview. */
export function conflict(message: string): TallyError {
  return new TallyError('WRITE_CONFLICT', message);
}

/** A master name as a write tool accepts it. */
export const masterNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n\t]/.test(value), 'Names cannot contain line breaks or tabs.');

/**
 * The company a write is for, as TallyPrime spells it.
 *
 * A write never falls back to "whatever Tally has current" the way a read can:
 * with no company named it proceeds only when exactly one is open.
 */
export async function writeTargetCompany(deps: ToolDeps, requested: string | undefined): Promise<string> {
  const named = await assertCompanyIsLoaded(deps, requested);
  if (named !== undefined) return named;

  const { companies } = await companyList(deps, { recordProvenance: false });
  const only = companies.length === 1 ? companies[0] : undefined;
  if (only === undefined) {
    throw new TallyError(
      'TALLY_COMPANY_NOT_LOADED',
      companies.length === 0
        ? 'No company is open in TallyPrime.'
        : `TallyPrime has ${String(companies.length)} companies open; say which one this change is for.`,
      { suggestion: 'Pass company with the exact name from tally_list_companies.' }
    );
  }
  return only.name;
}
