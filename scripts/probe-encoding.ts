/**
 * Find a way to make TallyPrime send non-ASCII characters intact.
 *
 * THE PROBLEM, established 2026-08-14 by reading raw response bytes. A German
 * company's base currency arrived as `<NAME TYPE="String">?</NAME>`, and the byte
 * at that offset is `0x3F` — a real ASCII question mark. So this is not a decoding
 * bug on our side: TallyPrime is substituting the character before it reaches the
 * wire, which is what its export does when the encoding cannot represent a symbol.
 * The response even claims `charset=utf-8` while containing a substituted `?`.
 *
 * Why it matters more than a cosmetic label. Every monetary figure this server
 * returns carries the base currency symbol. A euro company's figures are currently
 * labelled `"?"`. Nothing is converted, so the NUMBERS are right and only the label
 * is wrong — which is the more dangerous shape of the bug, and the same class as
 * the hard-coded INR default fixed on 2026-08-13: an accountant reading a figure
 * against books stating euros has to guess.
 *
 * It is not only currency. Any company name, party name, ledger name or narration
 * containing a non-ASCII character — umlauts, accents, Devanagari — is being
 * flattened the same way, silently, in a system whose whole job is to report what
 * the books actually say.
 *
 * SAFETY. Every candidate below is a STATICVARIABLES entry on a Collection over
 * `Currency`, a documented type already used in production. Unknown static
 * variables are documented to be IGNORED rather than rejected, and that was
 * verified live on 2026-08-13 by scripts/probe-statement-period.ts, which sent six
 * unknown ones with no incident. No unknown report ID and no undefined COLLECTION
 * is sent — those are the shapes that close TallyPrime.
 *
 * The residual risk is lost UNSAVED work, so:
 *
 *   TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-encoding.ts
 */

import { loadConfig } from '../src/config/config.js';

/**
 * Static variables to try, each as a name/value pair inserted alongside the
 * usual SVEXPORTFORMAT. `null` is the baseline: no extra variable at all.
 *
 * These are guesses at a NAME, which is the safe kind of guess here — a wrong
 * name is ignored. What is not guessed at is the verdict: success is decided by
 * whether a byte above 0x7F appears in the response, not by whether the request
 * looked accepted.
 */
const CANDIDATES: { label: string; extra: string | null }[] = [
  { label: 'baseline (no encoding hint)', extra: null },
  { label: 'SVENCODINGFORMAT=UNICODE', extra: '<SVENCODINGFORMAT>UNICODE</SVENCODINGFORMAT>' },
  { label: 'SVENCODINGFORMAT=UTF-8', extra: '<SVENCODINGFORMAT>UTF-8</SVENCODINGFORMAT>' },
  { label: 'SVEXPORTENCODING=UNICODE', extra: '<SVEXPORTENCODING>UNICODE</SVEXPORTENCODING>' },
  { label: 'SVEXPORTENCODING=UTF-8', extra: '<SVEXPORTENCODING>UTF-8</SVEXPORTENCODING>' },
  { label: 'ENCODINGTYPE=UNICODE', extra: '<ENCODINGTYPE>UNICODE</ENCODINGTYPE>' },
  { label: 'SVUNICODE=Yes', extra: '<SVUNICODE>Yes</SVUNICODE>' },
  { label: 'SVISUNICODE=Yes', extra: '<SVISUNICODE>Yes</SVISUNICODE>' },
  { label: 'SVCHARSET=UTF-8', extra: '<SVCHARSET>UTF-8</SVCHARSET>' },
  // Tally's own export dialog offers "Unicode (UTF-8)" as an ENCODING beside the
  // format, so the format token itself is worth one try.
  { label: 'SVEXPORTFORMAT=$$SysName:UnicodeXML', extra: null, },
];

/** The format override for the one candidate that changes SVEXPORTFORMAT itself. */
const FORMAT_OVERRIDE: Record<string, string> = {
  'SVEXPORTFORMAT=$$SysName:UnicodeXML': '$$SysName:UnicodeXML',
};

function requestFor(extra: string | null, format: string): string {
  return (
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>' +
    '<TYPE>Collection</TYPE><ID>Currencies</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
    `<SVEXPORTFORMAT>${format}</SVEXPORTFORMAT>${extra ?? ''}` +
    '</STATICVARIABLES><TDL><TDLMESSAGE>' +
    '<COLLECTION NAME="Currencies" ISMODIFY="No" ISFIXED="No"><TYPE>Currency</TYPE>' +
    '<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>MailingName</NATIVEMETHOD>' +
    '<NATIVEMETHOD>IsBaseCurrency</NATIVEMETHOD><NATIVEMETHOD>DecimalPlaces</NATIVEMETHOD>' +
    '</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  );
}

/**
 * What the response says about the currency symbol, judged from BYTES.
 *
 * Deliberately byte-level. Decoding first would hide the distinction this whole
 * script exists to make: a substituted `0x3F` and a correctly-transported symbol
 * both render as *something* in a string, and only the bytes say which happened.
 */
function verdict(bytes: Buffer): { highBytes: number; substituted: boolean; sample: string } {
  let highBytes = 0;
  for (const byte of bytes) if (byte >= 0x80) highBytes++;

  const text = bytes.toString('utf8');
  // EVERY currency, not the first. A company defines several and only the
  // non-ASCII one is substituted — reading just the first reported "$" and
  // concluded nothing was wrong, which is the opposite of the truth.
  const symbols = [...text.matchAll(/<CURRENCY NAME="([^"]*)"/g)].map((m) => m[1]);

  return {
    highBytes,
    substituted: symbols.includes('?'),
    sample: symbols.length === 0 ? '(no currency element)' : symbols.join(' '),
  };
}

async function post(body: string, url: string): Promise<Buffer> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body,
  });
  return Buffer.from(await response.arrayBuffer());
}

async function main(): Promise<void> {
  if (process.env.TALLY_PROBE_CONFIRM !== 'yes') {
    console.error(
      [
        'Refusing to run without confirmation.',
        '',
        'This sends a small number of unrecognised STATICVARIABLES to a live',
        'TallyPrime. Unknown static variables are documented and verified to be',
        'ignored, but the residual risk is lost UNSAVED work. Save, then re-run:',
        '',
        '  TALLY_PROBE_CONFIRM=yes npx tsx scripts/probe-encoding.ts',
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ ...process.env });
  const url = config.tallyBaseUrl;
  console.log(`Probing ${url}\n`);
  console.log('Success means a byte above 0x7F arrives where TallyPrime is currently');
  console.log("substituting '?'. Judged from raw bytes, not from a decoded string.\n");

  for (const candidate of CANDIDATES) {
    const format = FORMAT_OVERRIDE[candidate.label] ?? '$$SysName:XML';
    let bytes: Buffer;
    try {
      bytes = await post(requestFor(candidate.extra, format), url);
    } catch (error) {
      console.log(`${candidate.label.padEnd(38)} ERROR  ${(error as Error).message}`);
      continue;
    }

    const { highBytes, substituted, sample } = verdict(bytes);
    const outcome =
      highBytes > 0 && !substituted
        ? 'NON-ASCII ARRIVED'
        : substituted
          ? 'still "?"'
          : 'no symbol found';

    console.log(
      `${candidate.label.padEnd(38)} ${outcome.padEnd(18)} ` +
        `${String(bytes.length).padStart(6)}B  highBytes=${String(highBytes).padStart(3)}  ` +
        `symbol=${JSON.stringify(sample)}`
    );
  }

  console.log(
    [
      '',
      'If every line says still "?", TallyPrime is substituting before export and no',
      'request-side setting reaches it. That is a finding, not a failure: it means the',
      'fix has to be disclosure — say the symbol is unavailable rather than label every',
      'figure with a question mark — and it belongs in known-limitations.md so nobody',
      'probes this space again without a new, specific candidate.',
    ].join('\n')
  );
}

await main();
