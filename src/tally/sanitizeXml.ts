/**
 * Tally XML sanitisation.
 *
 * Real TallyPrime exports are frequently not well-formed by strict-parser
 * standards. Observed in the wild:
 *
 *  - Raw control characters (notably the reference written as &#4;) embedded
 *    in NARRATION, ledger names and party names. Tally uses these internally
 *    as field separators and does not strip them on export.
 *  - Encoding declarations that do not match the bytes actually sent.
 *  - Unescaped ampersands in free-text fields.
 *
 * A strict parser throws on all of these. Sanitisation lives here — in one
 * place inside `tally/` — rather than being scattered through normalisation,
 * so there is exactly one answer to "where did this character go?".
 *
 * This module is intentionally shape-agnostic: it knows nothing about
 * ledgers or vouchers, only about making a byte stream parseable.
 */

const CODE_TAB = 9;
const CODE_LF = 10;
const CODE_CR = 13;
const CODE_SPACE = 32;
const CODE_DEL = 127;
const CODE_C1_END = 159;
const CODE_BOM = 0xfeff;

/**
 * Code points XML forbids, whether sent raw or written as a character
 * reference. Tab, LF and CR are legal and deliberately preserved.
 */
function isIllegalCodePoint(code: number): boolean {
  if (code === CODE_TAB || code === CODE_LF || code === CODE_CR) return false;
  if (code < CODE_SPACE) return true;
  return code >= CODE_DEL && code <= CODE_C1_END;
}

/**
 * Any numeric or hex character reference. Whether a given one is legal
 * depends on the code point it denotes, so that decision is made in code
 * rather than encoded into an unreadable character class.
 */
const NUMERIC_ENTITY = /&#(x)?([0-9a-fA-F]+);/g;

/**
 * A bare ampersand that does not begin a valid entity reference.
 * Matching what a well-formed reference looks like is easier than
 * enumerating everything that isn't one.
 */
const BARE_AMPERSAND = /&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g;

export interface SanitizeResult {
  xml: string;
  /**
   * What had to be repaired. Surfaced as tool `warnings` so a malformed
   * export is visible rather than silently patched over.
   */
  repairs: string[];
}

/**
 * Drop forbidden code points, reporting how many were removed.
 *
 * Scans UTF-16 code units rather than code points: every illegal code point is
 * below 160, so it can never be half of a surrogate pair, and the two scans
 * therefore agree — but the code-unit one does not have to decode the payload.
 *
 * The common case by far is a payload with nothing to strip, so that case
 * returns the input itself and allocates nothing. When there is something to
 * strip, the kept runs are sliced out whole and joined once; building the
 * result a character at a time is what made this the slowest step in the
 * pipeline on a multi-megabyte voucher register.
 */
function stripIllegalCharacters(input: string): { text: string; removed: number } {
  const kept: string[] = [];
  let runStart = 0;

  for (let i = 0; i < input.length; i += 1) {
    if (!isIllegalCodePoint(input.charCodeAt(i))) continue;
    kept.push(input.slice(runStart, i));
    runStart = i + 1;
  }

  if (runStart === 0) return { text: input, removed: 0 };

  kept.push(input.slice(runStart));
  return { text: kept.join(''), removed: kept.length - 1 };
}

/**
 * Make a raw Tally XML payload safe to hand to a strict parser.
 * Never throws — if the input is unsalvageable, that surfaces at parse time
 * as TALLY_INVALID_RESPONSE, with the raw payload logged locally at DEBUG.
 */
export function sanitizeTallyXml(raw: string): SanitizeResult {
  const repairs: string[] = [];
  let xml = raw;

  // Strip a byte-order mark: legal in the byte stream, but breaks parsers
  // when it survives into a decoded string ahead of the declaration.
  if (xml.charCodeAt(0) === CODE_BOM) {
    xml = xml.slice(1);
    repairs.push('Removed a byte-order mark preceding the XML declaration.');
  }

  // Illegal character references, e.g. the &#4; Tally leaves in narrations.
  let entityRepairs = 0;
  xml = xml.replace(NUMERIC_ENTITY, (match, hexFlag: string | undefined, digits: string) => {
    const code = Number.parseInt(digits, hexFlag === undefined ? 10 : 16);
    if (Number.isNaN(code) || !isIllegalCodePoint(code)) return match;
    entityRepairs += 1;
    return '';
  });
  if (entityRepairs > 0) {
    repairs.push(
      `Removed ${String(entityRepairs)} illegal control-character reference(s) from text fields.`
    );
  }

  // The same characters, but sent raw rather than as references.
  const stripped = stripIllegalCharacters(xml);
  if (stripped.removed > 0) {
    xml = stripped.text;
    repairs.push(`Removed ${String(stripped.removed)} raw control character(s) from the payload.`);
  }

  // Counted in the replacement callback rather than by a separate `.match()`,
  // so the payload is traversed once here instead of twice.
  let bareAmpersands = 0;
  const escaped = xml.replace(BARE_AMPERSAND, () => {
    bareAmpersands += 1;
    return '&amp;';
  });
  if (bareAmpersands > 0) {
    xml = escaped;
    repairs.push(`Escaped ${String(bareAmpersands)} unescaped ampersand(s) in text fields.`);
  }

  return { xml, repairs };
}

/**
 * Reconcile a declared encoding with the one actually decoded.
 *
 * Tally may declare an encoding it did not use. We decode the bytes
 * ourselves and rewrite the declaration to match reality, so the parser is
 * not misled by a stale label.
 */
export function normalizeEncodingDeclaration(
  xml: string,
  actualEncoding: string
): { xml: string; repair: string | null } {
  const declaration = /^<\?xml\s+[^?]*\?>/.exec(xml);
  if (!declaration) return { xml, repair: null };

  const declaredMatch = /encoding\s*=\s*["']([^"']+)["']/i.exec(declaration[0]);
  if (!declaredMatch?.[1]) return { xml, repair: null };

  const declared = declaredMatch[1];
  if (declared.toLowerCase() === actualEncoding.toLowerCase()) return { xml, repair: null };

  const corrected = declaration[0].replace(
    /encoding\s*=\s*["'][^"']+["']/i,
    `encoding="${actualEncoding}"`
  );

  return {
    xml: corrected + xml.slice(declaration[0].length),
    repair: `Tally declared encoding "${declared}" but the payload decoded as "${actualEncoding}"; the declaration was corrected.`,
  };
}
