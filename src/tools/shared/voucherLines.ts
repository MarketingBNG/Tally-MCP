import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { groupKey } from '../../model/groupTree.js';
import type { Ledger, Voucher, VoucherType } from '../../tally/normalize.js';
import type {
  CostCategoryAllocation,
  InventoryLine,
  StockLine,
  VoucherContent,
} from '../../tally/requests/import.js';
import type { NestedRecord } from '../../tally/TallyResponseParser.js';
import { TallyError } from '../../tally/TallyError.js';
import { fetchStockItems } from '../read/inventory.js';
import { fetchSimpleMasters } from '../read/simpleMasters.js';
import type { ToolDeps } from './toolResult.js';
import { amountSchema, requireExisting, toTallySigned } from './writeInputs.js';

/**
 * Item lines and cost-centre splits — the parts of a voucher beyond plain
 * ledger lines. Each shape here was posted, read back and removed live on
 * Probotix on 2026-10-14 before being offered.
 */

export const costCentreSchema = z.object({
  name: z.string().trim().min(1).describe('Cost centre, exactly as in TallyPrime.'),
  amount: amountSchema
    .optional()
    .describe('Its share of the line. May be omitted when the line goes to ONE cost centre.'),
});

export const costCentresSchema = z
  .array(costCentreSchema)
  .min(1)
  .max(50)
  .optional()
  .describe('Split this line across cost centres. The shares must add up to the line amount.');

export const itemLineSchema = z.object({
  item: z.string().trim().min(1).describe('Stock item, exactly as in TallyPrime.'),
  quantity: z.number().positive().describe('Quantity in the item\'s base unit.'),
  rate: z.number().nonnegative().describe('Rate per base unit. The line amount is quantity × rate.'),
  ledger: z
    .string()
    .trim()
    .min(1)
    .describe('The sales or purchase ledger this item posts to, e.g. "Sales Accounts" ledger "Local Sales".'),
  godown: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Godown (location). Optional when the company has only one, or uses "Main Location".'),
  costCentres: costCentresSchema,
});

export type ItemLineInput = z.infer<typeof itemLineSchema>;

export const stockLineSchema = z.object({
  item: z.string().trim().min(1).describe('Stock item, exactly as in TallyPrime.'),
  quantity: z.number().positive(),
  rate: z.number().nonnegative().describe('Rate per base unit.'),
  godown: z.string().trim().min(1).optional().describe('Godown. Optional when there is only one.'),
});

export type StockLineInput = z.infer<typeof stockLineSchema>;

/**
 * Which way stock moves on an item voucher, by the built-in type it derives from.
 * Out = the item line is a credit (a sale), in = a debit (a purchase).
 */
const STOCK_DIRECTION: Record<string, 'out' | 'in'> = {
  sales: 'out',
  'delivery note': 'out',
  'debit note': 'out',
  purchase: 'in',
  'receipt note': 'in',
  'credit note': 'in',
};

export function stockDirection(voucherType: VoucherType): 'out' | 'in' {
  const direction = STOCK_DIRECTION[groupKey(voucherType.parent ?? voucherType.name)];
  if (direction === undefined) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `A ${voucherType.name} voucher does not take stock items. Item lines are for Sales, Purchase, ` +
        'Credit Note, Debit Note, Delivery Note and Receipt Note (and types based on them). For moving ' +
        'stock between godowns or into production, use tally_create_stock_journal.'
    );
  }
  return direction;
}

/** The masters item and cost-centre lines are checked against, read once per write. */
export interface LineMasters {
  items: { name: string; baseUnits: string | null }[];
  godowns: string[];
  /** Unit symbol to the decimal places TallyPrime keeps quantities to. */
  unitDecimals: Map<string, number>;
  costCentres: { name: string; category: string | null }[];
}

export async function readLineMasters(
  deps: ToolDeps,
  company: string,
  need: { items: boolean; costCentres: boolean }
): Promise<LineMasters> {
  const items = need.items
    ? (await fetchStockItems(deps, company, false)).items.map((i) => ({ name: i.name, baseUnits: i.baseUnits }))
    : [];
  const godowns = need.items ? (await fetchSimpleMasters(deps, company, 'Godown')).data.map((g) => g.name) : [];
  const unitDecimals = new Map<string, number>();
  if (need.items) {
    for (const unit of (await fetchSimpleMasters(deps, company, 'Unit')).data) {
      const places = Number(unit.fields.DECIMALPLACES ?? '0');
      unitDecimals.set(unit.name.toLowerCase(), Number.isFinite(places) ? places : 0);
    }
  }
  const costCentres = need.costCentres
    ? (await fetchSimpleMasters(deps, company, 'CostCentre')).data.map((c) => ({
        name: c.name,
        category: c.fields.CATEGORY ?? null,
      }))
    : [];
  return { items, godowns, unitDecimals, costCentres };
}

/** Amount = quantity × rate, refused when it would need rounding. */
export function lineAmount(quantity: number, rate: number, what: string): Decimal {
  const amount = new Decimal(quantity).times(rate);
  if (amount.decimalPlaces() > 2) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `${what}: ${String(quantity)} × ${String(rate)} = ${amount.toFixed()}, which is not a whole ` +
        'cent. Adjust the rate so the amount is exact; nothing is rounded silently.'
    );
  }
  if (amount.isZero()) throw new TallyError('INVALID_PARAMETERS', `${what} has a zero amount.`);
  return amount;
}

/** Which godown a stock line goes to, refusing a guess when there is a real choice. */
export function resolveGodown(masters: LineMasters, given: string | undefined, item: string): string | undefined {
  if (given !== undefined) return requireExisting(masters.godowns, given, (g) => g, 'godown');
  if (masters.godowns.length === 0) return undefined;
  if (masters.godowns.length === 1) return masters.godowns[0];
  const main = masters.godowns.find((g) => g.toLowerCase() === 'main location');
  if (main !== undefined) return main;
  throw new TallyError('INVALID_PARAMETERS', `Say which godown "${item}" moves from or to; this company has several.`);
}

/**
 * Refuse a quantity finer than the unit keeps. Verified live 2026-10-14: 2.5 of a
 * unit with 0 decimal places was stored as 3 while the amount stayed 2.5 × rate,
 * so the invoice no longer reconciled quantity to value.
 */
export function assertQuantityFits(masters: LineMasters, unit: string, quantity: number, item: string): void {
  const places = masters.unitDecimals.get(unit.toLowerCase());
  if (places === undefined) return;
  if (new Decimal(quantity).decimalPlaces() > places) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `"${item}" is counted in ${unit}, which TallyPrime keeps to ${String(places)} decimal place(s); ` +
        `${String(quantity)} would be rounded and no longer match its amount.`
    );
  }
}

export function resolveItem(masters: LineMasters, name: string): { name: string; unit: string } {
  const item = requireExisting(masters.items, name, (i) => i.name, 'stock item');
  const unit = item.baseUnits;
  if (unit === null || unit === '' || /^not applicable$/i.test(unit)) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `The stock item "${item.name}" has no unit of measure, so it cannot be billed by quantity. ` +
        'Give it a unit in TallyPrime (or with tally_alter_master), or post it as a ledger line.'
    );
  }
  return { name: item.name, unit };
}

/**
 * Turn the given cost-centre shares into allocations grouped by category, in
 * TallyPrime's sign, refusing shares that do not add up to the line.
 */
export function resolveCostCentres(
  masters: LineMasters,
  given: readonly { name: string; amount?: string | undefined }[] | undefined,
  lineAmountAbs: Decimal,
  side: 'Dr' | 'Cr',
  what: string
): CostCategoryAllocation[] | undefined {
  if (given === undefined || given.length === 0) return undefined;
  if (given.length > 1 && given.some((c) => c.amount === undefined)) {
    throw new TallyError('INVALID_PARAMETERS', `${what}: give an amount for every cost centre when splitting.`);
  }
  const byCategory = new Map<string, { name: string; amount: string }[]>();
  let total = new Decimal(0);
  for (const share of given) {
    const centre = requireExisting(masters.costCentres, share.name, (c) => c.name, 'cost centre');
    const amount = share.amount === undefined ? lineAmountAbs : new Decimal(share.amount);
    total = total.plus(amount);
    const category = centre.category ?? 'Primary Cost Category';
    const list = byCategory.get(category) ?? [];
    list.push({ name: centre.name, amount: toTallySigned(amount.toFixed(), side) });
    byCategory.set(category, list);
  }
  // Each category is a complete split of the line on its own.
  for (const [category, centres] of byCategory) {
    const sum = centres.reduce((s, c) => s.plus(new Decimal(c.amount).abs()), new Decimal(0));
    if (!sum.equals(lineAmountAbs)) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `${what}: the cost centres in "${category}" add up to ${sum.toFixed(2)}, not the line ` +
          `amount ${lineAmountAbs.toFixed(2)}.`
      );
    }
  }
  if (byCategory.size === 0 || total.isZero()) return undefined;
  return [...byCategory].map(([category, centres]) => ({ category, centres }));
}

/** Build the item lines of a voucher, with the debit/credit total they add. */
export function resolveItemLines(
  masters: LineMasters,
  ledgers: readonly Ledger[],
  voucherType: VoucherType,
  given: readonly ItemLineInput[]
): { items: InventoryLine[]; side: 'Dr' | 'Cr'; total: Decimal; table: Record<string, string>[] } {
  const side = stockDirection(voucherType) === 'out' ? 'Cr' : 'Dr';
  let total = new Decimal(0);
  const items: InventoryLine[] = [];
  const table: Record<string, string>[] = [];
  for (const line of given) {
    const item = resolveItem(masters, line.item);
    assertQuantityFits(masters, item.unit, line.quantity, item.name);
    const ledger = requireExisting(ledgers, line.ledger, (l) => l.name, 'ledger');
    const amount = lineAmount(line.quantity, line.rate, `"${item.name}"`);
    const godown = resolveGodown(masters, line.godown, item.name);
    const costCentres = resolveCostCentres(masters, line.costCentres, amount, side, `"${item.name}"`);
    total = total.plus(amount);
    items.push({
      item: item.name,
      quantity: new Decimal(line.quantity).toFixed(),
      unit: item.unit,
      rate: new Decimal(line.rate).toFixed(),
      amount: toTallySigned(amount.toFixed(2), side),
      ledger: ledger.name,
      ...(godown === undefined ? {} : { godown }),
      ...(costCentres === undefined ? {} : { costCentres }),
    });
    table.push({
      item: item.name,
      quantity: `${new Decimal(line.quantity).toFixed()} ${item.unit}`,
      rate: new Decimal(line.rate).toFixed(2),
      amount: amount.toFixed(2),
      side,
      ledger: ledger.name,
      ...(godown === undefined ? {} : { godown }),
      ...(costCentres === undefined
        ? {}
        : { costCentres: costCentres.flatMap((c) => c.centres.map((x) => `${x.name} ${new Decimal(x.amount).abs().toFixed(2)}`)).join(', ') }),
    });
  }
  return { items, side, total, table };
}

/** Build one side of a stock journal. */
export function resolveStockLines(
  masters: LineMasters,
  given: readonly StockLineInput[],
  what: string
): { lines: StockLine[]; total: Decimal } {
  let total = new Decimal(0);
  const lines = given.map((line): StockLine => {
    const item = resolveItem(masters, line.item);
    assertQuantityFits(masters, item.unit, line.quantity, item.name);
    const amount = lineAmount(line.quantity, line.rate, `${what} "${item.name}"`);
    const godown = resolveGodown(masters, line.godown, item.name);
    total = total.plus(amount);
    return {
      item: item.name,
      quantity: new Decimal(line.quantity).toFixed(),
      unit: item.unit,
      rate: new Decimal(line.rate).toFixed(),
      amount: amount.toFixed(2),
      ...(godown === undefined ? {} : { godown }),
    };
  });
  return { lines, total };
}

// ---- Read-back checks -------------------------------------------------------

const qty = (text: string | undefined): string => {
  const number = /-?[\d.]+/.exec((text ?? '').replace(/,/g, ''))?.[0];
  return number === undefined ? 'null' : new Decimal(number).toFixed(4);
};
const money = (text: string | undefined | null): string =>
  text === undefined || text === null || text.trim() === '' ? 'null' : new Decimal(text.trim()).toFixed(4);

/** Ledger totals a voucher's entries come to, by ledger. */
function totalsByLedger(pairs: readonly (readonly [string, string | null | undefined])[]): Map<string, string> {
  const totals = new Map<string, Decimal>();
  for (const [ledger, amount] of pairs) {
    if (amount === null || amount === undefined) continue;
    totals.set(ledger, (totals.get(ledger) ?? new Decimal(0)).plus(amount));
  }
  return new Map([...totals].filter(([, v]) => !v.isZero()).map(([k, v]) => [k, v.toFixed(4)]));
}

/**
 * Whether an item voucher as read back carries what was written: the same total
 * per ledger (TallyPrime may merge lines to one ledger) and the same items.
 */
export function itemVoucherMatches(voucher: Voucher, content: VoucherContent): boolean {
  const actual = totalsByLedger(voucher.entries.map((e) => [e.ledgerName, e.amount?.amount] as const));
  const expected = totalsByLedger([
    ...content.lines.map((l) => [l.ledger, l.amount] as const),
    ...(content.items ?? []).map((i) => [i.ledger, i.amount] as const),
  ]);
  if (actual.size !== expected.size || [...expected].some(([k, v]) => actual.get(k) !== v)) return false;

  const key = (item: string | undefined, amount: string | undefined, quantity: string | undefined): string =>
    `${item ?? ''}\u0000${money(amount)}\u0000${qty(quantity)}`;
  const got = (voucher.nested?.['ALLINVENTORYENTRIES.LIST'] ?? [])
    .map((r) => key(r.fields.STOCKITEMNAME, r.fields.AMOUNT, r.fields.BILLEDQTY))
    .sort();
  const want = (content.items ?? []).map((i) => key(i.item, i.amount, i.quantity)).sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

function centresIn(records: readonly NestedRecord[] | undefined): Set<string> {
  const found = new Set<string>();
  for (const category of records ?? []) {
    for (const centre of category.nested?.['COSTCENTREALLOCATIONS.LIST'] ?? []) {
      found.add(`${centre.fields.NAME ?? ''}\u0000${money(centre.fields.AMOUNT)}`);
    }
  }
  return found;
}

/** Cost-centre shares that were written but are not on the voucher as read back. */
export function missingCostCentres(voucher: Voucher, content: VoucherContent): string[] {
  const missing: string[] = [];
  const check = (where: string, records: readonly NestedRecord[] | undefined, wanted: readonly CostCategoryAllocation[] | undefined): void => {
    const present = centresIn(records);
    for (const category of wanted ?? []) {
      for (const centre of category.centres) {
        if (!present.has(`${centre.name}\u0000${money(centre.amount)}`)) missing.push(`${where}: ${centre.name} ${centre.amount}`);
      }
    }
  };
  for (const line of content.lines) {
    if (line.costCentres === undefined) continue;
    const entry = voucher.entries.find((e) => e.ledgerName === line.ledger);
    check(line.ledger, entry?.nested?.['CATEGORYALLOCATIONS.LIST'], line.costCentres);
  }
  for (const item of content.items ?? []) {
    if (item.costCentres === undefined) continue;
    const record = (voucher.nested?.['ALLINVENTORYENTRIES.LIST'] ?? []).find(
      (r) => r.fields.STOCKITEMNAME === item.item && money(r.fields.AMOUNT) === money(item.amount)
    );
    const allocations = (record?.nested?.['ACCOUNTINGALLOCATIONS.LIST'] ?? []).flatMap(
      (a) => a.nested?.['CATEGORYALLOCATIONS.LIST'] ?? []
    );
    check(item.item, allocations, item.costCentres);
  }
  return missing;
}

/** Whether a stock journal as read back carries the lines written. */
export function stockJournalMatches(
  voucher: Voucher,
  consumed: readonly StockLine[],
  produced: readonly StockLine[]
): boolean {
  const key = (item: string | undefined, amount: string | undefined, quantity: string | undefined): string =>
    `${item ?? ''}\u0000${money(amount)}\u0000${qty(quantity)}`;
  const side = (tag: string, lines: readonly StockLine[], sign: string): boolean => {
    const got = (voucher.nested?.[tag] ?? []).map((r) => key(r.fields.STOCKITEMNAME, r.fields.AMOUNT, r.fields.BILLEDQTY)).sort();
    const want = lines.map((l) => key(l.item, `${sign}${l.amount}`, l.quantity)).sort();
    return got.length === want.length && got.every((k, i) => k === want[i]);
  };
  return side('INVENTORYENTRIESOUT.LIST', consumed, '') && side('INVENTORYENTRIESIN.LIST', produced, '-');
}

/** The stock lines of an existing voucher, for previews. */
export function describeItems(voucher: Voucher): Record<string, string | undefined>[] {
  const lists = ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIESOUT.LIST', 'INVENTORYENTRIESIN.LIST'];
  return lists.flatMap((tag) =>
    (voucher.nested?.[tag] ?? []).map((r) => ({
      ...(tag === 'ALLINVENTORYENTRIES.LIST' ? {} : { side: tag.includes('OUT') ? 'consumed' : 'produced' }),
      item: r.fields.STOCKITEMNAME,
      quantity: r.fields.BILLEDQTY?.trim(),
      rate: r.fields.RATE,
      amount: r.fields.AMOUNT,
    }))
  );
}

/** Whether an existing voucher carries stock lines an accounting-only rewrite would drop. */
export function hasStockLines(voucher: Voucher): boolean {
  return (
    (voucher.nested?.['ALLINVENTORYENTRIES.LIST']?.length ?? 0) > 0 ||
    (voucher.nested?.['INVENTORYENTRIESIN.LIST']?.length ?? 0) > 0 ||
    (voucher.nested?.['INVENTORYENTRIESOUT.LIST']?.length ?? 0) > 0
  );
}
