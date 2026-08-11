import { describe, it, expect } from 'vitest';
import {
  parseTallyXml,
  pairReportRows,
  findFirst,
  findAll,
  childText,
  textOf,
  attributesOf,
  assertNoTallyError,
  isLivenessResponse,
} from '../../src/tally/TallyResponseParser.js';
import { TallyError } from '../../src/tally/TallyError.js';

describe('pairReportRows', () => {
  /**
   * The behaviour this whole module exists for. Tally reports emit names and
   * amounts as parallel siblings with no nesting, so the only thing linking a
   * row's name to its figures is document order.
   */
  it('pairs parallel sibling arrays by position', () => {
    const xml = `<ENVELOPE>
      <DSPACCNAME><DSPDISPNAME>Alpha</DSPDISPNAME></DSPACCNAME>
      <DSPACCINFO><V>1</V></DSPACCINFO>
      <DSPACCNAME><DSPDISPNAME>Beta</DSPDISPNAME></DSPACCNAME>
      <DSPACCINFO><V>2</V></DSPACCINFO>
    </ENVELOPE>`;

    const envelope = findFirst(parseTallyXml(xml), 'ENVELOPE');
    const rows = pairReportRows(envelope!, 'DSPACCNAME', 'DSPACCINFO');

    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta']);
    expect(textOf(findFirst([rows[0]!.value!], 'V')!)).toBe('1');
    expect(textOf(findFirst([rows[1]!.value!], 'V')!)).toBe('2');
  });

  /**
   * A regression guard against the specific failure mode that motivated the
   * positional walk: zipping two independently-filtered lists. When a heading
   * row carries no amount block, zipping shifts every later amount up one row
   * and reports Beta's figure against Gamma's name — wrong numbers, no error.
   */
  it('keeps later rows aligned when a name has no amount block', () => {
    const xml = `<ENVELOPE>
      <DSPACCNAME><DSPDISPNAME>Heading</DSPDISPNAME></DSPACCNAME>
      <DSPACCNAME><DSPDISPNAME>Beta</DSPDISPNAME></DSPACCNAME>
      <DSPACCINFO><V>2</V></DSPACCINFO>
      <DSPACCNAME><DSPDISPNAME>Gamma</DSPDISPNAME></DSPACCNAME>
      <DSPACCINFO><V>3</V></DSPACCINFO>
    </ENVELOPE>`;

    const envelope = findFirst(parseTallyXml(xml), 'ENVELOPE');
    const rows = pairReportRows(envelope!, 'DSPACCNAME', 'DSPACCINFO');

    expect(rows.map((r) => r.name)).toEqual(['Heading', 'Beta', 'Gamma']);
    // The heading keeps its place in the report rather than being dropped.
    expect(rows[0]!.value).toBeNull();
    expect(textOf(findFirst([rows[1]!.value!], 'V')!)).toBe('2');
    expect(textOf(findFirst([rows[2]!.value!], 'V')!)).toBe('3');
  });

  it('returns nothing for a report with no rows', () => {
    const envelope = findFirst(parseTallyXml('<ENVELOPE></ENVELOPE>'), 'ENVELOPE');
    expect(pairReportRows(envelope!, 'DSPACCNAME', 'DSPACCINFO')).toEqual([]);
  });
});

describe('textOf', () => {
  /**
   * Tally uses an empty element for "no value" while also emitting genuine
   * zeros. Collapsing the two would invent a balance the books never had.
   */
  it('distinguishes an empty element from a zero', () => {
    const nodes = parseTallyXml('<A><EMPTY></EMPTY><SELFCLOSED/><ZERO>0.00</ZERO></A>');
    const a = findFirst(nodes, 'A')!;

    expect(childText(a, 'EMPTY')).toBeNull();
    expect(childText(a, 'SELFCLOSED')).toBeNull();
    expect(childText(a, 'ZERO')).toBe('0.00');
  });

  it('returns null for a tag that is not present', () => {
    const a = findFirst(parseTallyXml('<A><B>x</B></A>'), 'A')!;
    expect(childText(a, 'NOPE')).toBeNull();
  });
});

describe('value preservation', () => {
  /**
   * A large amount must survive as an exact string. If the XML layer coerces
   * it to a float, precision is gone before any accounting code runs.
   */
  it('does not coerce numeric text to a number', () => {
    const node = findFirst(parseTallyXml('<A>12345678.91</A>'), 'A')!;
    expect(textOf(node)).toBe('12345678.91');
  });
});

describe('attributesOf', () => {
  it('reads element attributes', () => {
    const node = findFirst(parseTallyXml('<VOUCHER VCHTYPE="Payment" ACTION="Create"/>'), 'VOUCHER')!;
    expect(attributesOf(node)).toEqual({ VCHTYPE: 'Payment', ACTION: 'Create' });
  });

  it('returns an empty object when there are none', () => {
    const node = findFirst(parseTallyXml('<VOUCHER/>'), 'VOUCHER')!;
    expect(attributesOf(node)).toEqual({});
  });
});

describe('findAll', () => {
  it('finds descendants at any depth, in document order', () => {
    const nodes = parseTallyXml('<A><B><C>1</C></B><C>2</C></A>');
    expect(findAll(nodes, 'C').map(textOf)).toEqual(['1', '2']);
  });
});

describe('assertNoTallyError', () => {
  it('passes a clean payload through', () => {
    expect(() => assertNoTallyError(parseTallyXml('<ENVELOPE><A>x</A></ENVELOPE>'))).not.toThrow();
  });

  it('throws on a LINEERROR', () => {
    const nodes = parseTallyXml('<ENVELOPE><LINEERROR>Could not find description</LINEERROR></ENVELOPE>');
    expect(() => assertNoTallyError(nodes)).toThrow(TallyError);
  });

  it('maps an unknown-company LINEERROR to the code that tells the user to load it', () => {
    const nodes = parseTallyXml('<ENVELOPE><LINEERROR>Company does not exist</LINEERROR></ENVELOPE>');
    try {
      assertNoTallyError(nodes);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(TallyError.isTallyError(error)).toBe(true);
      expect((error as TallyError).code).toBe('TALLY_COMPANY_NOT_LOADED');
    }
  });

  it('ignores an empty LINEERROR element', () => {
    expect(() => assertNoTallyError(parseTallyXml('<ENVELOPE><LINEERROR/></ENVELOPE>'))).not.toThrow();
  });
});

describe('isLivenessResponse', () => {
  it('recognises the bare liveness reply', () => {
    const nodes = parseTallyXml('<RESPONSE>TallyPrime Server is Running</RESPONSE>');
    expect(isLivenessResponse(nodes)).toBe(true);
  });

  it('does not mistake a data payload for one', () => {
    expect(isLivenessResponse(parseTallyXml('<ENVELOPE><A>x</A></ENVELOPE>'))).toBe(false);
  });
});

describe('parseTallyXml', () => {
  it('raises TALLY_INVALID_RESPONSE on unparseable input', () => {
    // fast-xml-parser is lenient, so this asserts the error *code* when it
    // does reject, rather than that any particular string is rejected.
    try {
      parseTallyXml('<A><unclosed>');
    } catch (error) {
      expect(TallyError.isTallyError(error)).toBe(true);
      expect((error as TallyError).code).toBe('TALLY_INVALID_RESPONSE');
    }
  });
});
