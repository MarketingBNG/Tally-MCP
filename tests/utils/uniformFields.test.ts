import { describe, it, expect } from 'vitest';
import { foldUniformFields, uniformFieldsNote } from '../../src/utils/uniformFields.js';

/**
 * The saving is easy; the honesty rules are what these tests are for. Folding
 * relocates data, so every rule here exists to stop a relocation becoming an
 * assertion the records never made.
 */

interface Row {
  id: string;
  fields?: Record<string, string>;
}

const fold = (rows: Row[]) =>
  foldUniformFields(
    rows,
    (row) => row.fields,
    (row, fields) => ({ ...row, fields })
  );

describe('foldUniformFields', () => {
  it('folds a field identical on every record and leaves varying ones alone', () => {
    const result = fold([
      { id: 'a', fields: { ISDELETED: 'No', REFERENCE: 'INV/1' } },
      { id: 'b', fields: { ISDELETED: 'No', REFERENCE: 'INV/2' } },
    ]);

    expect(result.uniformFields).toEqual({ ISDELETED: 'No' });
    expect(result.records.map((r) => r.fields)).toEqual([
      { REFERENCE: 'INV/1' },
      { REFERENCE: 'INV/2' },
    ]);
    expect(result.foldedOccurrences).toBe(2);
  });

  /**
   * The rule that keeps folding honest. A field missing from one record is
   * information — Tally left it empty there — and hoisting it to the response
   * level would claim every record carried it.
   */
  it('does NOT fold a field that is absent from any record', () => {
    const result = fold([
      { id: 'a', fields: { AUDITED: 'No', REFERENCE: 'INV/1' } },
      { id: 'b', fields: { REFERENCE: 'INV/2' } },
    ]);

    expect(result.uniformFields).toEqual({});
    expect(result.records[0]?.fields).toEqual({ AUDITED: 'No', REFERENCE: 'INV/1' });
  });

  it('does not fold when values differ, even by one record', () => {
    const result = fold([
      { id: 'a', fields: { STATUS: 'No' } },
      { id: 'b', fields: { STATUS: 'No' } },
      { id: 'c', fields: { STATUS: 'Yes' } },
    ]);

    expect(result.uniformFields).toEqual({});
  });

  /**
   * With one record every field is trivially "uniform"; folding would empty the
   * record and move its entire contents to a summary, which is not a saving and
   * is actively confusing on a fetch-one-voucher call.
   */
  it('folds nothing below two records', () => {
    const single = fold([{ id: 'a', fields: { ISDELETED: 'No', REFERENCE: 'INV/1' } }]);

    expect(single.uniformFields).toEqual({});
    expect(single.records[0]?.fields).toEqual({ ISDELETED: 'No', REFERENCE: 'INV/1' });
    expect(fold([]).records).toEqual([]);
  });

  it('leaves records without a field map untouched', () => {
    const result = fold([{ id: 'a' }, { id: 'b', fields: { X: '1' } }]);

    expect(result.uniformFields).toEqual({});
    expect(result.records).toEqual([{ id: 'a' }, { id: 'b', fields: { X: '1' } }]);
  });

  /** No value may be lost: folded plus retained must reconstruct the input. */
  it('is lossless — every original field is recoverable', () => {
    const input: Row[] = [
      { id: 'a', fields: { CONST: 'same', VARIES: '1', ALSOCONST: 'x' } },
      { id: 'b', fields: { CONST: 'same', VARIES: '2', ALSOCONST: 'x' } },
      { id: 'c', fields: { CONST: 'same', VARIES: '3', ALSOCONST: 'x' } },
    ];
    const result = fold(input);

    expect(result.uniformFields).toEqual({ CONST: 'same', ALSOCONST: 'x' });
    for (const [index, record] of result.records.entries()) {
      const reconstructed = { ...result.uniformFields, ...record.fields };
      expect(reconstructed).toEqual(input[index]?.fields);
    }
  });

  it('does not mutate the records it was given', () => {
    const rows: Row[] = [
      { id: 'a', fields: { CONST: 'x', V: '1' } },
      { id: 'b', fields: { CONST: 'x', V: '2' } },
    ];
    fold(rows);

    expect(rows[0]?.fields).toEqual({ CONST: 'x', V: '1' });
  });

  it('reports the real saving on a payload shaped like live data', () => {
    // 25 records, 30 constant fields each plus one that varies — the observed
    // ratio was worse than this (171 of 204 constant).
    const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      fields: {
        ...Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`CONST${String(k)}`, 'No'])),
        REFERENCE: `INV/${String(i)}`,
      },
    }));

    const before = JSON.stringify(rows).length;
    const result = fold(rows);
    const after = JSON.stringify({ uniformFields: result.uniformFields, items: result.records }).length;

    expect(Object.keys(result.uniformFields)).toHaveLength(30);
    expect(result.foldedOccurrences).toBe(750);
    // Not a precise target — just proof the relocation is a large win, not noise.
    expect(after).toBeLessThan(before / 4);
  });
});

describe('uniformFieldsNote', () => {
  /**
   * Without this sentence a reader who searches a record for a folded field and
   * finds nothing could conclude TallyPrime never reported it. The note is the
   * thing that makes the relocation safe, so it must say where to look.
   */
  it('says where the fields went and warns they are probably defaults', () => {
    const note = uniformFieldsNote(171, 4275, 'voucher');

    expect(note).toContain('uniformFields');
    expect(note).toMatch(/relocated, not dropped/i);
    expect(note).toMatch(/default/i);
    expect(note).toContain('171');
    expect(note).toContain('4275');
  });
});
