import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import {
  sanitizeTallyXml,
  normalizeEncodingDeclaration,
} from '../../src/tally/sanitizeXml.js';

/**
 * These cases reproduce the malformations TallyPrime actually emits.
 * The point of each test is that a strict parser survives the payload —
 * so several assert on parseability, not just on string content.
 */

const strictParser = new XMLParser({ ignoreAttributes: false });

/** Parse for its throwing behaviour only, discarding the untyped result. */
function parseStrict(xml: string): void {
  strictParser.parse(xml);
}

describe('sanitizeTallyXml', () => {
  it('leaves clean XML untouched and reports no repairs', () => {
    const clean = '<ENVELOPE><NARRATION>Payment received</NARRATION></ENVELOPE>';
    const result = sanitizeTallyXml(clean);
    expect(result.xml).toBe(clean);
    expect(result.repairs).toEqual([]);
  });

  it('removes the &#4; reference Tally leaves in narrations', () => {
    const raw = '<ENVELOPE><NARRATION>Cheque&#4;no 12345</NARRATION></ENVELOPE>';
    const result = sanitizeTallyXml(raw);

    expect(result.xml).not.toContain('&#4;');
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toMatch(/control-character reference/i);
    expect(() => parseStrict(result.xml)).not.toThrow();
  });

  it('removes hex control references too', () => {
    const result = sanitizeTallyXml('<A>x&#x04;y</A>');
    expect(result.xml).toBe('<A>xy</A>');
  });

  it('preserves legal whitespace references', () => {
    // Tab, LF and CR are valid XML and must survive sanitisation.
    const raw = '<A>a&#9;b&#10;c&#13;d</A>';
    expect(sanitizeTallyXml(raw).xml).toBe(raw);
  });

  it('preserves ordinary character references', () => {
    const raw = '<A>caf&#233; &amp; bar</A>';
    const result = sanitizeTallyXml(raw);
    expect(result.xml).toBe(raw);
    expect(result.repairs).toEqual([]);
  });

  it('strips raw control bytes sent without escaping', () => {
    const raw = `<A>before${String.fromCharCode(4)}after</A>`;
    const result = sanitizeTallyXml(raw);

    expect(result.xml).toBe('<A>beforeafter</A>');
    expect(result.repairs[0]).toMatch(/raw control character/i);
    expect(() => parseStrict(result.xml)).not.toThrow();
  });

  it('escapes a bare ampersand in a party name', () => {
    const raw = '<PARTYNAME>Sharma & Sons</PARTYNAME>';
    const result = sanitizeTallyXml(raw);

    expect(result.xml).toBe('<PARTYNAME>Sharma &amp; Sons</PARTYNAME>');
    expect(() => parseStrict(result.xml)).not.toThrow();
  });

  it('does not double-escape ampersands that are already valid entities', () => {
    const raw = '<A>a &amp; b &lt; c &#233; d &#x1F; e</A>';
    const result = sanitizeTallyXml(raw);

    expect(result.xml).toContain('&amp;');
    expect(result.xml).not.toContain('&amp;amp;');
    expect(result.xml).toContain('&lt;');
    // The &#x1F; is an illegal control point and should still be dropped.
    expect(result.xml).not.toContain('&#x1F;');
  });

  it('removes a byte-order mark ahead of the declaration', () => {
    const raw = `${String.fromCharCode(0xfeff)}<?xml version="1.0"?><A>x</A>`;
    const result = sanitizeTallyXml(raw);

    expect(result.xml.startsWith('<?xml')).toBe(true);
    expect(result.repairs[0]).toMatch(/byte-order mark/i);
  });

  it('handles a payload with several problems at once', () => {
    const raw = `<ENVELOPE><NARRATION>M/s Gupta & Co&#4; inv 12${String.fromCharCode(
      1
    )}3</NARRATION></ENVELOPE>`;
    const result = sanitizeTallyXml(raw);

    expect(result.repairs.length).toBeGreaterThanOrEqual(3);
    expect(() => parseStrict(result.xml)).not.toThrow();

    const parsed = strictParser.parse(result.xml) as {
      ENVELOPE: { NARRATION: string };
    };
    expect(parsed.ENVELOPE.NARRATION).toBe('M/s Gupta & Co inv 123');
  });

  it('never throws, whatever it is given', () => {
    expect(() => sanitizeTallyXml('')).not.toThrow();
    expect(() => sanitizeTallyXml('<<<>>>not xml at all&&&')).not.toThrow();
  });

  /**
   * Pins the exact output for a payload exercising all four repair classes at
   * once, so the sanitiser can be reimplemented for speed without anyone having
   * to reason about whether the result still comes out byte-for-byte the same.
   * If this fails, the rewrite changed behaviour — that is the whole point.
   */
  it('produces byte-identical output for every repair class at once', () => {
    const raw = [
      String.fromCharCode(0xfeff),
      '<?xml version="1.0"?>',
      '<ENVELOPE>',
      `<NARRATION>M/s Gupta & Co&#4; inv${String.fromCharCode(1)} 12&#x1F;3</NARRATION>`,
      '<PARTYNAME>caf&#233; &amp; bar &lt;x&gt;</PARTYNAME>',
      `<TAB>a&#9;b${String.fromCharCode(9)}c${String.fromCharCode(0x85)}</TAB>`,
      `<HIGH>ÿ😀</HIGH>`,
      '</ENVELOPE>',
    ].join('');

    const result = sanitizeTallyXml(raw);

    expect(result.xml).toBe(
      '<?xml version="1.0"?>' +
        '<ENVELOPE>' +
        '<NARRATION>M/s Gupta &amp; Co inv 123</NARRATION>' +
        '<PARTYNAME>caf&#233; &amp; bar &lt;x&gt;</PARTYNAME>' +
        `<TAB>a&#9;b${String.fromCharCode(9)}c</TAB>` +
        '<HIGH>ÿ😀</HIGH>' +
        '</ENVELOPE>'
    );

    expect(result.repairs).toEqual([
      'Removed a byte-order mark preceding the XML declaration.',
      'Removed 2 illegal control-character reference(s) from text fields.',
      'Removed 2 raw control character(s) from the payload.',
      'Escaped 1 unescaped ampersand(s) in text fields.',
    ]);
  });

  it('leaves an astral-plane character intact', () => {
    // Illegal code points are all below 160, so no surrogate pair can contain
    // one — a code-unit scan must not mistake half a pair for a control byte.
    const raw = '<A>😀𐀀</A>';
    const result = sanitizeTallyXml(raw);

    expect(result.xml).toBe(raw);
    expect(result.repairs).toEqual([]);
  });
});

describe('normalizeEncodingDeclaration', () => {
  it('rewrites a declaration that misreports the actual encoding', () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><A>x</A>';
    const result = normalizeEncodingDeclaration(xml, 'utf-8');

    expect(result.xml).toContain('encoding="utf-8"');
    expect(result.xml).not.toContain('UTF-16');
    expect(result.repair).toMatch(/declared encoding "UTF-16"/);
  });

  it('leaves a correct declaration alone', () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?><A>x</A>';
    const result = normalizeEncodingDeclaration(xml, 'UTF-8');

    expect(result.xml).toBe(xml);
    expect(result.repair).toBeNull();
  });

  it('is a no-op when there is no declaration at all', () => {
    const xml = '<A>x</A>';
    const result = normalizeEncodingDeclaration(xml, 'utf-8');

    expect(result.xml).toBe(xml);
    expect(result.repair).toBeNull();
  });
});
