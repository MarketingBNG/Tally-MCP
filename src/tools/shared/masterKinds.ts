import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { SimpleMasterType } from '../../tally/requests.js';
import type { MasterFields, MasterTag } from '../../tally/requests/import.js';
import { TallyError } from '../../tally/TallyError.js';
import { fetchStockItems } from '../read/inventory.js';
import { fetchSimpleMasters } from '../read/simpleMasters.js';
import type { ToolDeps } from './toolResult.js';
import { currentGroups, findExisting, requireExisting } from './writeInputs.js';

/**
 * The masters behind tally_create_master / tally_alter_master / tally_delete_master,
 * and what each one accepts.
 *
 * Every kind here was created, read back and deleted live on 2026-10-14 (see
 * MASTER_TAGS in requests/import.ts). Ledgers are not here: they have their own
 * tools, because a ledger carries far more an accountant needs to see.
 */

export const MASTER_KINDS = ['group', 'costCentre', 'costCategory', 'unit', 'stockGroup', 'godown', 'stockItem'] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];

/** One existing master, reduced to what the write tools compare. */
export interface MasterRecord {
  name: string;
  parent: string | null;
  /** Stock item only: as TallyPrime reports them. */
  baseUnits?: string | null;
  openingQuantity?: string | null;
  openingValue?: string | null;
}

interface KindSpec {
  tag: MasterTag;
  label: string;
  /** Which kind a `parent` must name, or null when this kind takes no parent. */
  parentKind: MasterKind | null;
  /** Whether a parent is required on create. */
  parentRequired: boolean;
  /** The input fields this kind accepts besides name/parent. */
  accepts: readonly (keyof MasterInput)[];
  canRename: boolean;
}

export const KIND_SPECS: Record<MasterKind, KindSpec> = {
  group: { tag: 'GROUP', label: 'group', parentKind: 'group', parentRequired: true, accepts: [], canRename: true },
  costCentre: {
    tag: 'COSTCENTRE',
    label: 'cost centre',
    parentKind: 'costCentre',
    parentRequired: false,
    accepts: ['category'],
    canRename: true,
  },
  // Not probed as a write: listed so its names resolve for costCentre.category,
  // never offered as a kind to create — see the schema below.
  costCategory: { tag: 'COSTCENTRE', label: 'cost category', parentKind: null, parentRequired: false, accepts: [], canRename: false },
  unit: {
    tag: 'UNIT',
    label: 'unit',
    parentKind: null,
    parentRequired: false,
    accepts: ['formalName', 'decimalPlaces'],
    canRename: false,
  },
  stockGroup: { tag: 'STOCKGROUP', label: 'stock group', parentKind: 'stockGroup', parentRequired: false, accepts: [], canRename: true },
  godown: { tag: 'GODOWN', label: 'godown', parentKind: 'godown', parentRequired: false, accepts: [], canRename: true },
  stockItem: {
    tag: 'STOCKITEM',
    label: 'stock item',
    parentKind: 'stockGroup',
    parentRequired: false,
    accepts: ['baseUnits', 'openingQuantity', 'openingRate'],
    canRename: true,
  },
};

/** The kinds a caller may write. Cost categories are read-only here. */
export const WRITABLE_KINDS = ['group', 'costCentre', 'unit', 'stockGroup', 'godown', 'stockItem'] as const;

export const masterInputShape = {
  kind: z
    .enum(WRITABLE_KINDS)
    .describe('group, costCentre, unit, stockGroup, godown or stockItem. (Ledgers have their own tools.)'),
  parent: z
    .string()
    .trim()
    .optional()
    .describe(
      'group: parent group (required). costCentre: parent cost centre. stockGroup: parent stock ' +
        'group. godown: parent godown. stockItem: its stock group. Empty for top level.'
    ),
  category: z.string().trim().min(1).optional().describe('costCentre only: its cost category.'),
  formalName: z.string().trim().min(1).max(100).optional().describe('unit only: full name, e.g. "Kilograms".'),
  decimalPlaces: z.number().int().min(0).max(4).optional().describe('unit only: decimal places for quantities.'),
  baseUnits: z.string().trim().min(1).optional().describe('stockItem only: unit symbol, e.g. "kg". Required on create.'),
  openingQuantity: z.number().positive().optional().describe('stockItem only: opening quantity in its base unit.'),
  openingRate: z.number().nonnegative().optional().describe('stockItem only: opening rate per base unit.'),
};

export interface MasterInput {
  parent?: string | undefined;
  category?: string | undefined;
  formalName?: string | undefined;
  decimalPlaces?: number | undefined;
  baseUnits?: string | undefined;
  openingQuantity?: number | undefined;
  openingRate?: number | undefined;
}

const SIMPLE_TYPE: Partial<Record<MasterKind, SimpleMasterType>> = {
  costCentre: 'CostCentre',
  costCategory: 'CostCategory',
  unit: 'Unit',
  stockGroup: 'StockGroup',
  godown: 'Godown',
};

/** Every existing master of a kind, read fresh enough for a write decision. */
export async function listMasters(deps: ToolDeps, company: string, kind: MasterKind): Promise<MasterRecord[]> {
  if (kind === 'group') {
    return (await currentGroups(deps, company)).map((g) => ({ name: g.name, parent: g.parent }));
  }
  if (kind === 'stockItem') {
    return (await fetchStockItems(deps, company, false)).items.map((item) => ({
      name: item.name,
      parent: item.parent,
      baseUnits: item.baseUnits,
      openingQuantity: item.openingBalance,
      openingValue: item.openingValue?.amount ?? null,
    }));
  }
  const type = SIMPLE_TYPE[kind];
  if (type === undefined) throw new Error(`No list for ${kind}`);
  const { data } = await fetchSimpleMasters(deps, company, type);
  return data.map((m) => ({ name: m.name, parent: m.parent }));
}

/** Refuse any field the kind does not take, rather than sending it to TallyPrime to guess at. */
export function assertFieldsFitKind(kind: MasterKind, input: MasterInput): void {
  const spec = KIND_SPECS[kind];
  const stray = (['category', 'formalName', 'decimalPlaces', 'baseUnits', 'openingQuantity', 'openingRate'] as const)
    .filter((field) => input[field] !== undefined && !spec.accepts.includes(field));
  if (input.parent !== undefined && input.parent !== '' && spec.parentKind === null) stray.unshift('parent' as never);
  if (stray.length > 0) {
    throw new TallyError('INVALID_PARAMETERS', `A ${spec.label} does not take: ${stray.join(', ')}.`);
  }
  if ((input.openingQuantity === undefined) !== (input.openingRate === undefined)) {
    throw new TallyError('INVALID_PARAMETERS', 'Give openingQuantity and openingRate together, or neither.');
  }
}

/**
 * Resolve the given fields against the live masters into import fields and a
 * preview, refusing any reference that does not exist.
 */
export async function resolveMasterFields(
  deps: ToolDeps,
  company: string,
  kind: MasterKind,
  input: MasterInput,
  baseUnitsOfExisting?: string | null
): Promise<{ fields: MasterFields; shown: Record<string, unknown> }> {
  const spec = KIND_SPECS[kind];
  const fields: MasterFields = {};
  const shown: Record<string, unknown> = {};

  if (input.parent !== undefined && spec.parentKind !== null) {
    if (input.parent === '') {
      if (spec.parentRequired) throw new TallyError('INVALID_PARAMETERS', `A ${spec.label} needs a parent group.`);
      fields.parent = '';
      shown.parent = '(top level)';
    } else {
      const parentSpec = KIND_SPECS[spec.parentKind];
      const parent = requireExisting(await listMasters(deps, company, spec.parentKind), input.parent, (m) => m.name, parentSpec.label);
      fields.parent = parent.name;
      shown.parent = parent.name;
    }
  }
  if (input.category !== undefined) {
    const category = requireExisting(await listMasters(deps, company, 'costCategory'), input.category, (m) => m.name, 'cost category');
    fields.category = category.name;
    shown.category = category.name;
  }
  if (input.formalName !== undefined) shown.formalName = fields.formalName = input.formalName;
  if (input.decimalPlaces !== undefined) shown.decimalPlaces = fields.decimalPlaces = input.decimalPlaces;

  let units = baseUnitsOfExisting ?? undefined;
  if (input.baseUnits !== undefined) {
    const unit = requireExisting(await listMasters(deps, company, 'unit'), input.baseUnits, (m) => m.name, 'unit');
    units = fields.baseUnits = unit.name;
    shown.baseUnits = unit.name;
  }
  if (input.openingQuantity !== undefined && input.openingRate !== undefined) {
    if (units === undefined) {
      throw new TallyError('INVALID_PARAMETERS', 'An opening quantity needs the item\'s base unit (baseUnits).');
    }
    const quantity = new Decimal(input.openingQuantity);
    const rate = new Decimal(input.openingRate);
    const value = quantity.times(rate);
    fields.openingQuantity = `${quantity.toFixed()} ${units}`;
    fields.openingRate = `${rate.toFixed()}/${units}`;
    // Stock in hand is a debit, which is NEGATIVE in TallyPrime's sign — the
    // same convention the read side reports (verified live: -50 for 5 @ 10).
    fields.openingValue = value.negated().toFixed();
    shown.opening = `${quantity.toFixed()} ${units} @ ${rate.toFixed(2)} = ${value.toFixed(2)} Dr`;
  }

  return { fields, shown };
}

/** Find an existing master of a kind, or undefined. */
export async function findMaster(
  deps: ToolDeps,
  company: string,
  kind: MasterKind,
  name: string
): Promise<MasterRecord | undefined> {
  return findExisting(await listMasters(deps, company, kind), name, (m) => m.name);
}

/**
 * Whether two parents are the same place, treating every spelling of "top
 * level" as one. Verified live: a stock item sent with an empty PARENT is read
 * back with parent "Primary".
 */
export function sameParent(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (value: string | null | undefined): string => {
    const text = (value ?? '').trim().toLowerCase();
    return text === 'primary' ? '' : text;
  };
  return norm(a) === norm(b);
}
