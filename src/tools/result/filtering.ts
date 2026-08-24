import { Decimal } from 'decimal.js';
import type { z } from 'zod';
import type { conditionSchema } from '../../schemas/common.js';
import { TallyError } from '../../tally/TallyError.js';
import type { Money } from '../../utils/numbers.js';

/**
 * The generic field-condition filter behind the merged master tools.
 *
 * Moved out of toolResult.ts unchanged. It shares nothing with the rest of that
 * module — no company, period, currency or provenance concern reaches it — and
 * it was the one part a reader could mistake for a query engine, which is
 * exactly what its own doc comment below exists to deny.
 */

/**
 * Generic field-condition filter, shared by the merged master tools
 * (tally_get_masters type "ledger" / tally_get_masters type "group" / tally_get_masters type "stockItem").
 *
 * Deliberately NOT a SQL or freeform query layer: each dataset exposes a
 * fixed, small field allowlist via `DatasetSpec`, and this only evaluates
 * conditions against that allowlist — never an arbitrary Tally
 * report/collection ID.
 */
export type FieldType = 'string' | 'money' | 'boolean';

export interface FieldSpec<T> {
  type: FieldType;
  get: (record: T) => string | boolean | Money | null;
}

export type DatasetSpec<T> = Record<string, FieldSpec<T>>;

type Op = z.infer<typeof conditionSchema>['op'];

const STRING_OPS: readonly Op[] = ['eq', 'neq', 'contains', 'isNull', 'isNotNull'];
const NUMERIC_OPS: readonly Op[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'isNotNull'];
const BOOLEAN_OPS: readonly Op[] = ['eq', 'neq', 'isNull', 'isNotNull'];

const OPS_BY_TYPE: Record<FieldType, readonly Op[]> = {
  string: STRING_OPS,
  money: NUMERIC_OPS,
  boolean: BOOLEAN_OPS,
};

function moneyAmount(value: Money | null): Decimal | null {
  return value === null ? null : new Decimal(value.amount);
}

function evaluateCondition(
  fieldName: string,
  fieldType: FieldType,
  raw: string | boolean | Money | null,
  op: Op,
  compareTo: string | number | boolean | undefined
): boolean {
  if (op === 'isNull') return raw === null;
  if (op === 'isNotNull') return raw !== null;

  if (raw === null) return false;

  if (fieldType === 'string') {
    const actual = (raw as string).toLowerCase();
    if (typeof compareTo !== 'string') {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `Condition on "${fieldName}" needs a string value for op "${op}".`
      );
    }
    const expected = compareTo.toLowerCase();
    if (op === 'eq') return actual === expected;
    if (op === 'neq') return actual !== expected;
    if (op === 'contains') return actual.includes(expected);
    throw new TallyError(
      'INVALID_PARAMETERS',
      `Op "${op}" is not valid for string field "${fieldName}".`
    );
  }

  if (fieldType === 'boolean') {
    if (typeof compareTo !== 'boolean') {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `Condition on "${fieldName}" needs a boolean value for op "${op}".`
      );
    }
    if (op === 'eq') return raw === compareTo;
    if (op === 'neq') return raw !== compareTo;
    throw new TallyError(
      'INVALID_PARAMETERS',
      `Op "${op}" is not valid for boolean field "${fieldName}".`
    );
  }

  // Money.
  if (typeof compareTo !== 'number') {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `Condition on "${fieldName}" needs a numeric value for op "${op}".`
    );
  }
  const actual = moneyAmount(raw as Money);
  if (actual === null) return false;
  const expected = new Decimal(compareTo);
  if (op === 'eq') return actual.equals(expected);
  if (op === 'neq') return !actual.equals(expected);
  if (op === 'gt') return actual.greaterThan(expected);
  if (op === 'gte') return actual.greaterThanOrEqualTo(expected);
  if (op === 'lt') return actual.lessThan(expected);
  if (op === 'lte') return actual.lessThanOrEqualTo(expected);
  throw new TallyError(
    'INVALID_PARAMETERS',
    `Op "${op}" is not valid for money field "${fieldName}".`
  );
}

export function applyConditions<T>(
  records: readonly T[],
  dataset: DatasetSpec<T>,
  conditions: readonly z.infer<typeof conditionSchema>[]
): T[] {
  for (const condition of conditions) {
    const spec = dataset[condition.field];
    if (!spec) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `Unknown field "${condition.field}" for this dataset.`,
        { suggestion: `Valid fields: ${Object.keys(dataset).join(', ')}` }
      );
    }
    if (!OPS_BY_TYPE[spec.type].includes(condition.op)) {
      throw new TallyError(
        'INVALID_PARAMETERS',
        `Op "${condition.op}" is not valid for field "${condition.field}" (a ${spec.type} field).`,
        { suggestion: `Valid ops for ${spec.type}: ${OPS_BY_TYPE[spec.type].join(', ')}` }
      );
    }
  }

  return records.filter((record) =>
    conditions.every((condition) => {
      const spec = dataset[condition.field];
      if (!spec) return false;
      return evaluateCondition(
        condition.field,
        spec.type,
        spec.get(record),
        condition.op,
        condition.value
      );
    })
  );
}
