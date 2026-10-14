import { EDUCATIONAL_DAYS, isKnownEducationalMode } from './educationalMode.js';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { buildGroupIndex, groupKey, isUnderAnyGroup } from '../../model/groupTree.js';
import type { Group, Ledger, Voucher, VoucherType } from '../../tally/normalize.js';
import type {
  BillAllocation,
  InventoryLine,
  VoucherContent,
  VoucherLine,
} from '../../tally/requests/import.js';
import { TallyError } from '../../tally/TallyError.js';
import { fetchVouchers } from '../read/vouchers/fetch.js';
import { fetchVoucherTypes } from '../read/voucherTypes.js';
import { isoDateSchema } from '../../schemas/common.js';
import {
  costCentresSchema,
  describeItems,
  hasStockLines,
  itemLineSchema,
  itemVoucherMatches,
  readLineMasters,
  resolveCostCentres,
  resolveItemLines,
  type ItemLineInput,
} from './voucherLines.js';
import { companyBookYear, companyNamed, type ToolDeps } from './toolResult.js';
import {
  amountSchema,
  currentGroups,
  currentLedgers,
  describeSigned,
  requireExisting,
  sideSchema,
  toTallySigned,
} from './writeInputs.js';

/**
 * What the voucher write tools share: entry validation, the balance check, and
 * finding the one voucher an alter, cancel or delete is aimed at.
 */

export const billSchema = z.object({
  type: z
    .enum(['New Ref', 'Agst Ref', 'Advance', 'On Account'])
    .describe('New Ref raises a bill (an invoice); Agst Ref settles an existing one.'),
  reference: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('The bill / invoice reference. Not for On Account.'),
  amount: amountSchema.optional().describe('Defaults to the whole line amount.'),
});

export const entrySchema = z.object({
  ledger: z.string().trim().min(1).describe('Ledger name exactly as in TallyPrime.'),
  side: sideSchema,
  amount: amountSchema,
  bills: z
    .array(billSchema)
    .max(50)
    .optional()
    .describe('Bill-wise allocations, for party ledgers that keep balances bill by bill.'),
  costCentres: costCentresSchema,
});

export type EntryInput = z.infer<typeof entrySchema>;

export const voucherContentShape = {
  voucherType: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Voucher type as in TallyPrime: Journal, Payment, Receipt, Contra, Sales, Purchase, Credit Note, Debit Note, or a custom type.'
    ),
  date: isoDateSchema.describe('Voucher date, ISO YYYY-MM-DD.'),
  entries: z
    .array(entrySchema)
    .min(1)
    .max(200)
    .describe(
      'Ledger lines. Debits must equal credits exactly, counting any item lines. On an item ' +
        'invoice these are the party and any tax, freight or discount ledgers.'
    ),
  items: z
    .array(itemLineSchema)
    .max(200)
    .optional()
    .describe(
      'Stock item lines, for an ITEM invoice (Sales, Purchase, Credit/Debit Note) or a Delivery / ' +
        'Receipt Note. Each is item, quantity, rate and the sales or purchase ledger it posts to; ' +
        'the side follows the voucher type (a sale credits, a purchase debits).'
    ),
  narration: z.string().max(2000).optional(),
  voucherNumber: z
    .string()
    .max(50)
    .optional()
    .describe('Only for types numbered manually. Omit to let TallyPrime number it.'),
  reference: z.string().max(100).optional().describe('Supplier invoice number or other reference.'),
  partyLedger: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('The party (customer/supplier) of the voucher, if any.'),
};

export interface ValidatedVoucher {
  content: VoucherContent;
  voucherType: VoucherType;
  /** The accountant-readable lines: ledger, Dr, Cr, group. */
  table: {
    ledger: string;
    group: string | null;
    debit: string;
    credit: string;
    bills?: unknown;
    costCentres?: unknown;
  }[];
  /** Item lines as an accountant reads them; empty for an accounting voucher. */
  itemTable: Record<string, string>[];
  total: string;
  warnings: string[];
}

/** Families whose vouchers move cash or bank, and so should touch a cash or bank ledger. */
const CASH_FAMILIES = new Set(['payment', 'receipt', 'contra']);
const CASH_GROUPS = new Set(['bank accounts', 'cash-in-hand', 'bank od a/c', 'bank occ a/c']);

/**
 * Validate a voucher against the live masters and turn it into import content.
 *
 * Refuses (never repairs): an unknown voucher type or ledger, debits that do not
 * equal credits, a bill allocation that does not add up to its line. Warns,
 * without refusing, where an accountant would look twice.
 */
export async function validateVoucher(
  deps: ToolDeps,
  company: string,
  input: {
    voucherType: string;
    date: string;
    entries: EntryInput[];
    items?: ItemLineInput[] | undefined;
    narration?: string | undefined;
    voucherNumber?: string | undefined;
    reference?: string | undefined;
    partyLedger?: string | undefined;
  }
): Promise<ValidatedVoucher> {
  const warnings: string[] = [];
  const [types, ledgers, groups] = [
    (await fetchVoucherTypes(deps, company)).voucherTypes,
    await currentLedgers(deps, company),
    await currentGroups(deps, company),
  ];

  const voucherType = requireExisting(types, input.voucherType, (t) => t.name, 'voucher type');
  await assertDateInBooks(deps, company, input.date);
  const hasItems = (input.items?.length ?? 0) > 0;
  const masters = await readLineMasters(deps, company, {
    items: hasItems,
    costCentres:
      input.entries.some((e) => e.costCentres !== undefined) ||
      (input.items ?? []).some((i) => i.costCentres !== undefined),
  });

  let debit = new Decimal(0);
  let credit = new Decimal(0);
  const lines: VoucherLine[] = [];
  const table: ValidatedVoucher['table'] = [];

  for (const entry of input.entries) {
    const ledger = requireExisting(ledgers, entry.ledger, (l) => l.name, 'ledger');
    const signed = toTallySigned(entry.amount, entry.side);
    if (new Decimal(entry.amount).isZero()) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `The line for "${ledger.name}" has a zero amount.`
      );
    }
    if (entry.side === 'Dr') debit = debit.plus(entry.amount);
    else credit = credit.plus(entry.amount);

    const bills = entry.bills?.map((bill): BillAllocation => {
      if (bill.type !== 'On Account' && bill.reference === undefined) {
        throw new TallyError(
          'INVALID_PARAMETERS',
          `A ${bill.type} bill on "${ledger.name}" needs a reference.`
        );
      }
      return {
        type: bill.type,
        ...(bill.reference === undefined ? {} : { name: bill.reference }),
        amount: toTallySigned(bill.amount ?? entry.amount, entry.side),
      };
    });
    if (bills !== undefined && bills.length > 0) {
      const billed = bills.reduce(
        (sum, bill) => sum.plus(new Decimal(bill.amount).abs()),
        new Decimal(0)
      );
      if (!billed.equals(new Decimal(entry.amount))) {
        throw new TallyError(
          'INVALID_PARAMETERS',
          `The bills on "${ledger.name}" add up to ${billed.toFixed(2)}, not the line amount ${new Decimal(entry.amount).toFixed(2)}.`
        );
      }
    }

    const costCentres = resolveCostCentres(
      masters,
      entry.costCentres,
      new Decimal(entry.amount),
      entry.side,
      `"${ledger.name}"`
    );

    lines.push({
      ledger: ledger.name,
      amount: signed,
      ...(bills === undefined ? {} : { bills }),
      ...(costCentres === undefined ? {} : { costCentres }),
    });
    table.push({
      ledger: ledger.name,
      group: ledger.parent,
      debit: entry.side === 'Dr' ? new Decimal(entry.amount).toFixed(2) : '',
      credit: entry.side === 'Cr' ? new Decimal(entry.amount).toFixed(2) : '',
      ...(bills === undefined ? {} : { bills: entry.bills }),
      ...(entry.costCentres === undefined ? {} : { costCentres: entry.costCentres }),
    });
  }

  let items: InventoryLine[] = [];
  let itemTable: Record<string, string>[] = [];
  if (hasItems) {
    const resolved = resolveItemLines(masters, ledgers, voucherType, input.items ?? []);
    items = resolved.items;
    itemTable = resolved.table;
    if (resolved.side === 'Dr') debit = debit.plus(resolved.total);
    else credit = credit.plus(resolved.total);
  }

  if (!debit.equals(credit)) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `Debits (${debit.toFixed(2)}) do not equal credits (${credit.toFixed(2)}); the difference is ` +
        `${debit.minus(credit).abs().toFixed(2)}. Nothing was prepared.`
    );
  }
  const signs = [...lines.map((l) => l.amount), ...items.map((i) => i.amount)];
  if (signs.every((a) => !a.startsWith('-')) || signs.every((a) => a.startsWith('-'))) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      'A voucher needs at least one debit and one credit line.'
    );
  }

  const duplicates = new Set<string>();
  for (const line of lines) {
    if (duplicates.has(line.ledger))
      warnings.push(`"${line.ledger}" appears on more than one line.`);
    duplicates.add(line.ledger);
  }

  const family = groupKey(voucherType.parent ?? voucherType.name);
  if (CASH_FAMILIES.has(family) && !touchesCash(lines, ledgers, groups)) {
    warnings.push(
      `A ${voucherType.name} voucher normally debits or credits a cash or bank ledger, and this one ` +
        'touches none. Check that the voucher type is right.'
    );
  }

  let partyLedger: string | undefined;
  if (input.partyLedger !== undefined) {
    partyLedger = requireExisting(ledgers, input.partyLedger, (l) => l.name, 'ledger').name;
    if (!lines.some((l) => l.ledger === partyLedger)) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `The party "${partyLedger}" is not on any line of the voucher.`
      );
    }
  }

  // The party line goes first. Verified live 2026-10-14: TallyPrime ignores
  // PARTYLEDGERNAME on import and takes the voucher's party from its FIRST line
  // — a Receipt sent as "Dr Bank, Cr Customer" came back with the bank as its
  // party. Line order changes nothing else about the voucher.
  if (partyLedger !== undefined) {
    const first = lines.findIndex((l) => l.ledger === partyLedger);
    lines.unshift(...lines.splice(first, 1));
    table.unshift(...table.splice(first, 1));
  }

  return {
    content: {
      voucherType: voucherType.name,
      date: input.date,
      lines,
      ...(input.narration === undefined ? {} : { narration: input.narration }),
      ...(input.voucherNumber === undefined ? {} : { voucherNumber: input.voucherNumber }),
      ...(input.reference === undefined ? {} : { reference: input.reference }),
      ...(partyLedger === undefined ? {} : { partyLedger }),
      ...(items.length === 0 ? {} : { items }),
    },
    voucherType,
    table,
    itemTable,
    total: debit.toFixed(2),
    warnings,
  };
}

function touchesCash(
  lines: readonly VoucherLine[],
  ledgers: readonly Ledger[],
  groups: readonly Group[]
): boolean {
  const index = buildGroupIndex(groups);
  return lines.some((line) => {
    const ledger = ledgers.find((l) => l.name === line.ledger);
    return ledger !== undefined && isUnderAnyGroup(ledger.parent, CASH_GROUPS, index);
  });
}

/** Refuse a date before the books begin; TallyPrime would reject it with a misleading message. */
export async function assertDateInBooks(deps: ToolDeps, company: string, date: string): Promise<void> {
  const profile = await companyNamed(deps, company);
  const start = profile?.startingFrom ?? null;
  if (start !== null && date < start) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `${date} is before the books of "${company}" begin (${start}).`
    );
  }
  if (isKnownEducationalMode(company) && !EDUCATIONAL_DAYS.includes(date.slice(8, 10))) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `"${company}" is running in TallyPrime Educational mode, which only accepts the 1st, 2nd and ` +
        `31st of a month; ${date} would be rejected. Nothing was sent — a rejected voucher can leave ` +
        'a hidden trace that stops its ledgers being deleted.',
      { suggestion: 'Use a date on the 1st, 2nd or 31st, or post this in a licensed TallyPrime.' }
    );
  }
}

/**
 * MasterId from a voucher GUID.
 *
 * Verified live: a voucher's GUID is the company GUID, a dash, and its MasterId
 * as eight hex digits — "...-00000979" is MasterId 2425. Used only to cross-check
 * the MASTERID field, never instead of it.
 */
export function masterIdFromGuid(guid: string): number | null {
  const tail = /-([0-9a-f]{8})$/i.exec(guid)?.[1];
  return tail === undefined ? null : parseInt(tail, 16);
}

/** One voucher, found by GUID on its date, with the identifiers a targeted write needs. */
export interface TargetVoucher {
  voucher: Voucher;
  masterId: number;
  alterId: string | null;
}

/**
 * Find the voucher a write is aimed at, by GUID, reading the books fresh.
 *
 * The date scopes the read to one financial year, which is what keeps this
 * affordable; the GUID is what makes it exact. Both come straight from the read
 * tools' output.
 */
export async function findVoucher(
  deps: ToolDeps,
  company: string,
  guid: string,
  date: string
): Promise<TargetVoucher | null> {
  const { vouchers } = await fetchVouchers(
    deps,
    company,
    { fromDate: date, toDate: date },
    true,
    true
  );
  const voucher = vouchers.find((v) => v.guid === guid);
  if (voucher === undefined) return null;

  const masterId = Number(voucher.fields?.MASTERID ?? masterIdFromGuid(guid) ?? NaN);
  if (!Number.isInteger(masterId) || masterId <= 0) {
    throw new TallyError(
      'TALLY_INVALID_RESPONSE',
      `Could not read the MasterId of voucher ${guid}.`
    );
  }
  return { voucher, masterId, alterId: voucher.fields?.ALTERID ?? null };
}

/** Find a voucher by MasterId on a date — how a just-created voucher is read back. */
export async function findVoucherByMasterId(
  deps: ToolDeps,
  company: string,
  masterId: number,
  date: string
): Promise<Voucher | null> {
  const { vouchers } = await fetchVouchers(
    deps,
    company,
    { fromDate: date, toDate: date },
    true,
    true
  );
  return vouchers.find((v) => Number(v.fields?.MASTERID) === masterId) ?? null;
}

/** Require the target, refusing clearly when the GUID is not on that date. */
export async function requireVoucher(
  deps: ToolDeps,
  company: string,
  guid: string,
  date: string
): Promise<TargetVoucher> {
  const found = await findVoucher(deps, company, guid, date);
  if (found === null) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `No voucher with GUID ${guid} is dated ${date} in "${company}".`,
      {
        suggestion: 'Take both the guid and the date from tally_get_vouchers or another read tool.',
      }
    );
  }
  return found;
}

/** A voucher's lines as an accountant reads them, for before/after previews. */
export function describeVoucher(voucher: Voucher): Record<string, unknown> {
  return {
    voucherType: voucher.voucherType,
    date: voucher.date,
    voucherNumber: voucher.voucherNumber,
    party: voucher.partyLedgerName,
    narration: voucher.narration,
    cancelled: voucher.isCancelled,
    entries: voucher.entries.map((e) => ({
      ledger: e.ledgerName,
      amount: describeSigned(e.amount?.amount),
    })),
    ...(hasStockLines(voucher) ? { items: describeItems(voucher) } : {}),
  };
}

/** Do a voucher's lines match the content written? Compares ledger and signed amount as multisets. */
export function contentMatches(voucher: Voucher, content: VoucherContent): boolean {
  return (content.items?.length ?? 0) > 0 ? itemVoucherMatches(voucher, content) : linesMatch(voucher, content.lines);
}

export function linesMatch(voucher: Voucher, lines: readonly VoucherLine[]): boolean {
  const key = (ledger: string, amount: string | null | undefined): string =>
    `${ledger}\u0000${amount === null || amount === undefined ? 'null' : new Decimal(amount).toFixed(4)}`;
  const actual = voucher.entries.map((e) => key(e.ledgerName, e.amount?.amount)).sort();
  const expected = lines.map((l) => key(l.ledger, l.amount)).sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

/**
 * Bill references the written lines asked for that the voucher as read back
 * does not carry. Empty means every bill landed.
 */
export function missingBills(voucher: Voucher, lines: readonly VoucherLine[]): string[] {
  const missing: string[] = [];
  for (const line of lines) {
    const wanted = (line.bills ?? []).map((bill) => bill.name).filter((name) => name !== undefined);
    if (wanted.length === 0) continue;
    const entry = voucher.entries.find((e) => e.ledgerName === line.ledger);
    const present = new Set(
      (entry?.nested?.['BILLALLOCATIONS.LIST'] ?? []).map((record) => record.fields.NAME ?? '')
    );
    for (const name of wanted) if (!present.has(name)) missing.push(`${line.ledger}: ${name}`);
  }
  return missing;
}

/**
 * Other live vouchers of the same type and number in the company's current
 * book year. Not an error — a manually numbered type can legitimately repeat —
 * but an accountant needs to know, because a repeated number is what a
 * duplicate posting looks like on a register.
 */
export async function sameNumberElsewhere(
  deps: ToolDeps,
  company: string,
  made: Voucher
): Promise<string | null> {
  if (made.voucherNumber === null || made.date === null) return null;
  const year = await companyBookYear(deps, company);
  if (year === null || made.date < year.fromDate || made.date > year.toDate) return null;
  const { vouchers } = await fetchVouchers(deps, company, year);
  const clashes = vouchers.filter(
    (v) =>
      v.guid !== made.guid &&
      !v.isCancelled &&
      v.voucherType === made.voucherType &&
      v.voucherNumber === made.voucherNumber
  );
  if (clashes.length === 0) return null;
  return (
    `TallyPrime numbered this ${String(made.voucherType)} "${made.voucherNumber}", which ` +
    `${String(clashes.length)} other ${String(made.voucherType)} voucher(s) this year also carry ` +
    `(e.g. dated ${String(clashes[0]?.date)}). Give voucherNumber explicitly to control numbering, ` +
    'or renumber in TallyPrime.'
  );
}

/**
 * Header fields that were written but are not on the voucher as read back:
 * reference, an explicitly given number, the party. Empty means all landed.
 */
export function headerMismatches(voucher: Voucher, content: VoucherContent): string[] {
  const problems: string[] = [];
  if (
    content.reference !== undefined &&
    (voucher.fields?.REFERENCE ?? null) !== content.reference
  ) {
    problems.push(
      `reference: wanted "${content.reference}", found "${String(voucher.fields?.REFERENCE ?? '')}"`
    );
  }
  if (content.voucherNumber !== undefined && voucher.voucherNumber !== content.voucherNumber) {
    problems.push(
      `voucherNumber: wanted "${content.voucherNumber}", found "${String(voucher.voucherNumber)}"`
    );
  }
  if (content.partyLedger !== undefined && voucher.partyLedgerName !== content.partyLedger) {
    problems.push(
      `party: wanted "${content.partyLedger}", found "${String(voucher.partyLedgerName)}"`
    );
  }
  if ((content.narration ?? '') !== (voucher.narration ?? '')) {
    problems.push(
      `narration: wanted "${content.narration ?? ''}", found "${voucher.narration ?? ''}"`
    );
  }
  if (voucher.date !== content.date)
    problems.push(`date: wanted ${content.date}, found ${String(voucher.date)}`);
  return problems;
}
