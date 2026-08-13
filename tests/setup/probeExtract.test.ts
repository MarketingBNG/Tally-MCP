import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM helper, shipped without type declarations because
// it must run under the bundled Node runtime with no build step.
import { extractCompanies } from '../../installer/scripts/lib/probe.mjs';

/**
 * Regression tests for the doctor's company detection.
 *
 * These exist because the first version of this parser reported "no company is
 * open" against a live TallyPrime that had one open — twice, for two different
 * reasons. Both are captured below. A false "no company" is the worst possible
 * output here: it sends the user off to fix something that is not broken.
 *
 * The payload below is the real shape returned by TallyPrime for the connection
 * probe, trimmed but not otherwise altered.
 */

const LIVE_RESPONSE = `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <STATUS>1</STATUS>
 </HEADER>
 <BODY>
  <DESC>
   <CMPINFO>
    <COMPANY>0</COMPANY>
    <GROUP>0</GROUP>
    <LEDGER>0</LEDGER>
    <VOUCHER>0</VOUCHER>
   </CMPINFO>
  </DESC>
  <DATA>
   <COLLECTION>
    <COMPANY NAME="MUDALS TECHNOLOGIES PRIVATE LIMITED" RESERVEDNAME="">
     <NAME TYPE="String">MUDALS TECHNOLOGIES PRIVATE LIMITED</NAME>
     <ISGSTON TYPE="Logical">Yes</ISGSTON>
    </COMPANY>
   </COLLECTION>
  </DATA>
 </BODY>
</ENVELOPE>`;

describe('extractCompanies', () => {
  it('finds the company in a real TallyPrime response', () => {
    expect(extractCompanies(LIVE_RESPONSE)).toEqual(['MUDALS TECHNOLOGIES PRIVATE LIMITED']);
  });

  it('ignores the COMPANY count inside CMPINFO', () => {
    // <CMPINFO><COMPANY>0</COMPANY> is a count, not a record. Reading it as one
    // is what caused the original false "no company is open".
    const noData = `<ENVELOPE><BODY><DESC><CMPINFO><COMPANY>0</COMPANY></CMPINFO></DESC></BODY></ENVELOPE>`;

    expect(extractCompanies(noData)).toEqual([]);
  });

  it('reads names from tags that carry attributes', () => {
    // <NAME TYPE="String"> — a regex anchored on a bare <NAME> matches nothing.
    const attributeOnly = `<DATA><COLLECTION><COMPANY><NAME TYPE="String">ACME LTD</NAME></COMPANY></COLLECTION></DATA>`;

    expect(extractCompanies(attributeOnly)).toEqual(['ACME LTD']);
  });

  it('returns an empty list when Tally reports no companies', () => {
    const empty = `<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>`;

    expect(extractCompanies(empty)).toEqual([]);
  });

  it('handles several open companies without duplicating them', () => {
    const two = `<DATA><COLLECTION>
      <COMPANY NAME="ALPHA LTD"><NAME TYPE="String">ALPHA LTD</NAME></COMPANY>
      <COMPANY NAME="BETA LTD"><NAME TYPE="String">BETA LTD</NAME></COMPANY>
    </COLLECTION></DATA>`;

    expect(extractCompanies(two)).toEqual(['ALPHA LTD', 'BETA LTD']);
  });

  it('decodes escaped characters in company names', () => {
    const escaped = `<DATA><COLLECTION><COMPANY NAME="SMITH &amp; SONS"></COMPANY></COLLECTION></DATA>`;

    expect(extractCompanies(escaped)).toEqual(['SMITH & SONS']);
  });

  it('is not fooled by a response with no DATA section at all', () => {
    expect(extractCompanies('<RESPONSE>Unknown Request, cannot be processed</RESPONSE>')).toEqual(
      []
    );
  });
});
