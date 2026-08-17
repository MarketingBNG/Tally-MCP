import { XMLParser } from 'fast-xml-parser';
import { TallyError } from './TallyError.js';

/**
 * Structural parsing of TallyPrime XML responses.
 *
 * This module turns a payload into ordered, tag-aware nodes. It does not know
 * what a ledger or a voucher is — that is `normalize.ts`. The split matters
 * because Tally's three response shapes are structurally different from one
 * another, and only one of them is what you would expect.
 *
 * ## The three shapes, as confirmed against a live TallyPrime 7.x install
 *
 * 1. **Collections** (companies, ledgers) nest properly:
 *
 *        <DATA><COLLECTION><LEDGER NAME="...">
 *          <PARENT>...</PARENT><CLOSINGBALANCE>...</CLOSINGBALANCE>
 *
 * 2. **Reports** (trial balance, balance sheet, P&L) do NOT nest. They emit
 *    two *parallel sibling arrays* directly under `<ENVELOPE>`:
 *
 *        <DSPACCNAME><DSPDISPNAME>Capital Account</DSPDISPNAME></DSPACCNAME>
 *        <DSPACCINFO>...amounts...</DSPACCINFO>
 *        <DSPACCNAME><DSPDISPNAME>Loans (Liability)</DSPDISPNAME></DSPACCNAME>
 *        <DSPACCINFO>...amounts...</DSPACCINFO>
 *
 *    Nothing links a name to its own amounts except *position*. Any parser
 *    that groups children by tag name — which is what a non-order-preserving
 *    XML parser produces — silently loses the association and will happily
 *    report one account's balance under another account's name. That is a
 *    wrong-number bug in an auditing tool, so document order is preserved
 *    throughout this module rather than as an option.
 *
 * 3. **Vouchers** nest, but are ~95% empty scaffolding: roughly 200 empty
 *    date and tax elements per voucher. Callers extract the few fields they
 *    need; nothing tries to represent the whole tree.
 *
 * Values are never coerced by the XML layer. Amounts stay strings all the way
 * to `parseTallyAmount`, because letting a parser turn "110223458.98" into a
 * float loses precision before accounting code ever sees it.
 */

/** Key fast-xml-parser uses for an element's attributes in preserveOrder mode. */
const ATTRIBUTES_KEY = ':@';
/** Key fast-xml-parser uses for a text node in preserveOrder mode. */
const TEXT_KEY = '#text';

/**
 * One element in document order. Exactly one key is the tag name, whose value
 * is the ordered list of children; `:@` carries attributes when present.
 */
export type TallyNode = Record<string, unknown>;

const parser = new XMLParser({
  // Non-negotiable: see the header comment on parallel sibling arrays.
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Keep every value a string. Precision is lost the moment a float appears.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Tally emits <FOO/> constantly; an empty element must be distinguishable
  // from a missing one, so it becomes a node with no children rather than
  // being dropped or turned into an empty string.
  ignoreDeclaration: true,
  ignorePiTags: true,
});

/**
 * Parse a sanitised Tally XML payload into ordered nodes.
 *
 * Expects text that has already been through `sanitizeTallyXml` — raw Tally
 * output is frequently not well-formed and would throw here.
 */
export function parseTallyXml(xml: string): TallyNode[] {
  let nodes: unknown;
  try {
    nodes = parser.parse(xml) as unknown;
  } catch (error) {
    throw new TallyError(
      'TALLY_INVALID_RESPONSE',
      'TallyPrime returned a payload that could not be parsed as XML.',
      { cause: error }
    );
  }

  if (!Array.isArray(nodes)) {
    throw new TallyError(
      'TALLY_INVALID_RESPONSE',
      'TallyPrime returned a payload with an unexpected top-level structure.'
    );
  }

  return nodes as TallyNode[];
}

/** The tag name of a node, or null for a text node. */
export function tagNameOf(node: TallyNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ATTRIBUTES_KEY && key !== TEXT_KEY) return key;
  }
  return null;
}

/** Ordered children of a node. Empty for `<FOO/>` and for text nodes. */
export function childrenOf(node: TallyNode): TallyNode[] {
  const tag = tagNameOf(node);
  if (tag === null) return [];
  const value = node[tag];
  return Array.isArray(value) ? (value as TallyNode[]) : [];
}

/**
 * Attributes of a node, keyed by attribute name.
 *
 * Numeric character references are decoded here exactly as they are for text
 * content — see `decodeNumericRefs`. An attribute is text and Tally escapes it
 * the same way, so decoding one and not the other made the SAME value read
 * differently depending on which the normaliser happened to use.
 *
 * Found live 2026-08-15. `normalizeLedgers` takes a ledger's name from the
 * NAME attribute, so a real creditor came back as
 * `"BUNDESANZEIGER VERLAG G&#13;&#10; MBH"` — the escape sequence shown
 * literally, in the party name printed on an audit finding. The same ledger's
 * `<NAME>` child element decoded correctly, which is why this went unnoticed.
 */
export function attributesOf(node: TallyNode): Record<string, string> {
  const raw = node[ATTRIBUTES_KEY];
  if (raw === null || typeof raw !== 'object') return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = decodeNumericRefs(value);
  }
  return out;
}

/**
 * Direct text content of a node.
 *
 * Returns null when the element is empty. This distinction is load-bearing:
 * Tally uses `<DSPCLDRAMTA></DSPCLDRAMTA>` for "no debit balance" while also
 * emitting a genuine `0.00` elsewhere, and collapsing the two would invent a
 * zero the accounting system never reported.
 */
export function textOf(node: TallyNode): string | null {
  for (const child of childrenOf(node)) {
    const text = child[TEXT_KEY];
    if (typeof text === 'string') return decodeNumericRefs(text);
    if (typeof text === 'number') return String(text);
  }
  return null;
}

/**
 * Turn numeric character references into the characters they denote.
 *
 * fast-xml-parser decodes NAMED entities (`&amp;`, `&quot;`) but leaves NUMERIC
 * ones alone, and Tally emits numeric ones heavily. Verified live 2026-08-13: a
 * real bank narration came back as
 *
 *   "...24906415108227233530943&#13;&#10;RECURRING CKCD 5968..."
 *
 * so the accountant read six literal escape characters where the statement has a
 * line break. Worse, `matchesText` could not match a phrase spanning the break,
 * so a narration search silently missed vouchers that do contain the phrase.
 *
 * This runs AFTER `sanitizeTallyXml`, which has already removed references to
 * characters XML forbids (603 of them on one real company). Anything left should
 * be legal, but the guard is kept: a reference to a control character is dropped
 * rather than decoded, because putting a raw 0x04 into a ledger name would just
 * move the corruption downstream.
 *
 * Known limitation, accepted: a literal `&#13;` that Tally escaped as `&amp;#13;`
 * arrives here already decoded to `&#13;` and is turned into a carriage return.
 * That requires an accountant to have typed the escape sequence itself into a
 * narration, and reading it as a newline is a far smaller error than showing
 * every real line break as `&#13;&#10;`.
 */
function decodeNumericRefs(text: string): string {
  if (!text.includes('&#')) return text;

  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (match, digits: string) => {
    const code =
      digits[0] === 'x' || digits[0] === 'X'
        ? Number.parseInt(digits.slice(1), 16)
        : Number.parseInt(digits, 10);

    if (!Number.isFinite(code)) return match;

    // Tab, newline and carriage return are the only control characters XML
    // permits; the rest are dropped, matching what the sanitiser does upstream.
    const isLegal =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);

    return isLegal ? String.fromCodePoint(code) : '';
  });
}

/** Every direct child carrying the given tag name. */
export function childrenNamed(node: TallyNode, tag: string): TallyNode[] {
  return childrenOf(node).filter((child) => tagNameOf(child) === tag);
}

/**
 * Every populated scalar field on a node, as a flat name/value map.
 *
 * This is how "give me everything this record has" is answered without
 * hardcoding a field list per company. Tally emits a fixed superset of
 * elements covering every feature it supports — GST, excise, VAT, payroll,
 * banking — and leaves the ones that do not apply empty. A company with GST
 * enabled and one without therefore differ only in which elements have
 * content, so **dropping the empties yields exactly the fields that company
 * actually uses.** The 200-odd blank elements per voucher stop being noise
 * and become the mechanism.
 *
 * Only scalars are returned. Nested list structures (`*.LIST`) are records in
 * their own right and are handled by dedicated normalisation where they
 * matter, rather than being flattened into unreadable keys here.
 */
export function scalarFieldsOf(
  node: TallyNode,
  exclude: ReadonlySet<string> = new Set()
): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const child of childrenOf(node)) {
    const tag = tagNameOf(child);
    if (tag === null || exclude.has(tag)) continue;

    // A node with element children is a structure, not a scalar field.
    if (childrenOf(child).some((grandchild) => tagNameOf(grandchild) !== null)) continue;

    const text = textOf(child);
    if (text === null) continue;

    const trimmed = text.trim();
    if (trimmed === '') continue;

    // Repeated tags keep the first occurrence; later ones would silently
    // overwrite an earlier value with no way for a caller to notice.
    fields[tag] ??= trimmed;
  }

  return fields;
}

/** The first direct child with the given tag name, or null. */
export function childNamed(node: TallyNode, tag: string): TallyNode | null {
  return childrenNamed(node, tag)[0] ?? null;
}

/** Text of the first direct child with the given tag name, or null. */
export function childText(node: TallyNode, tag: string): string | null {
  const child = childNamed(node, tag);
  return child === null ? null : textOf(child);
}

/**
 * Every descendant with the given tag name, in document order.
 *
 * Used where the depth is not worth asserting — `TALLYMESSAGE` wrappers come
 * and go between report types, and pinning an exact path would make the
 * parser brittle against a Tally version that adds one more layer.
 */
export function findAll(nodes: readonly TallyNode[], tag: string): TallyNode[] {
  const found: TallyNode[] = [];

  const walk = (list: readonly TallyNode[]): void => {
    for (const node of list) {
      if (tagNameOf(node) === tag) found.push(node);
      walk(childrenOf(node));
    }
  };

  walk(nodes);
  return found;
}

/**
 * The first descendant with the given tag name, or null.
 *
 * Walks in the same document order as `findAll` and stops at the first hit,
 * rather than collecting every match and discarding all but the first. Same
 * node either way — but `dataScope` calls this on every response to find one
 * `DATA` element near the top, and the collecting form paid a walk of the
 * entire multi-megabyte tree to do it.
 */
export function findFirst(nodes: readonly TallyNode[], tag: string): TallyNode | null {
  for (const node of nodes) {
    if (tagNameOf(node) === tag) return node;
    const nested = findFirst(childrenOf(node), tag);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * A nested structure hanging off a record — a bill allocation, a bank
 * instrument, an inventory line, a GST breakdown.
 *
 * Recursive because Tally nests these several deep (an inventory entry owns
 * batch allocations, which own godown allocations).
 */
export interface NestedRecord {
  fields: Record<string, string>;
  nested?: Record<string, NestedRecord[]>;
}

/** How deep to follow nesting before giving up. */
const MAX_NEST_DEPTH = 5;

/**
 * Every non-empty nested structure on a record, grouped by tag name.
 *
 * Tally hangs 50-plus `*.LIST` structures off a single voucher — bill
 * allocations, bank instrument details, inventory lines, GST breakdowns,
 * excise, payroll, VAT, e-way bill — and leaves the ones that do not apply
 * empty. Exactly as with scalar fields, **a structure containing no populated
 * value anywhere is dropped**, so what remains is what this voucher actually
 * has.
 *
 * That is what makes this work across companies without a hardcoded list. On
 * a company using cheques, `BANKALLOCATIONS.LIST` appears with the instrument
 * type and payee. On a GST company, `GST.LIST` appears. Neither needs to be
 * anticipated here, and a company that uses neither pays no size penalty.
 *
 * Returned as arrays because `*.LIST` legitimately repeats — a voucher can
 * settle several bills.
 */
export function nestedRecordsOf(
  node: TallyNode,
  exclude: ReadonlySet<string> = new Set(),
  depth = MAX_NEST_DEPTH
): Record<string, NestedRecord[]> {
  if (depth <= 0) return {};

  const grouped: Record<string, NestedRecord[]> = {};

  for (const child of childrenOf(node)) {
    const tag = tagNameOf(child);
    if (tag === null || exclude.has(tag)) continue;

    // Scalars are handled by scalarFieldsOf; only structures belong here.
    const hasElementChildren = childrenOf(child).some(
      (grandchild) => tagNameOf(grandchild) !== null
    );
    if (!hasElementChildren) continue;

    const fields = scalarFieldsOf(child);
    const nested = nestedRecordsOf(child, exclude, depth - 1);

    // Empty scaffolding: no value at any depth. Dropping it is the whole point.
    if (Object.keys(fields).length === 0 && Object.keys(nested).length === 0) continue;

    const record: NestedRecord = Object.keys(nested).length === 0 ? { fields } : { fields, nested };

    (grouped[tag] ??= []).push(record);
  }

  return grouped;
}

/**
 * A name/value pair recovered from a report's parallel sibling arrays.
 *
 * `index` is retained because it is the only stable identity a report row
 * has — report output carries no GUID, and display names repeat across
 * groups (two different parents can each own a "Duties & Taxes").
 */
export interface PairedRow {
  index: number;
  name: string;
  /** The value-side node, e.g. DSPACCINFO / BSAMT / PLAMT. */
  value: TallyNode | null;
}

/**
 * Pair a report's two parallel sibling arrays back into rows.
 *
 * Walks the container's children in document order, opening a row on each
 * `nameTag` and attaching the next `valueTag` that follows it. This mirrors
 * how the data is actually emitted, and — unlike zipping two filtered
 * lists — it stays correct when one side is missing an entry, which happens
 * on subtotal and heading rows.
 *
 * A name with no following value yields a row with `value: null` rather than
 * being dropped, so a caller can report the gap instead of silently
 * shortening the report.
 */
export function pairReportRows(
  container: TallyNode,
  nameTag: string,
  valueTag: string
): PairedRow[] {
  const rows: PairedRow[] = [];
  let pending: { index: number; name: string } | null = null;

  const flush = (value: TallyNode | null): void => {
    if (pending === null) return;
    rows.push({ index: pending.index, name: pending.name, value });
    pending = null;
  };

  for (const child of childrenOf(container)) {
    const tag = tagNameOf(child);

    if (tag === nameTag) {
      // Two names in a row means the previous one had no value block.
      flush(null);
      pending = { index: rows.length, name: displayNameOf(child) ?? '' };
      continue;
    }

    if (tag === valueTag && pending !== null) {
      flush(child);
    }
  }

  flush(null);
  return rows;
}

/**
 * Pull the display name out of a report's name-side node.
 *
 * The trial balance and P&L put it directly in `DSPACCNAME > DSPDISPNAME`,
 * while the balance sheet wraps the same structure one level deeper inside
 * `BSNAME`. A descendant search covers both without special-casing either.
 * The flow reports' `DSPPERIOD` carries the name as its own text with no
 * `DSPDISPNAME` wrapper at all, hence the fallback.
 */
export function displayNameOf(nameNode: TallyNode): string | null {
  const display = findFirst([nameNode], 'DSPDISPNAME');
  return display === null ? textOf(nameNode) : textOf(display);
}

/**
 * Detect an error TallyPrime reported inside an otherwise-200 response.
 *
 * Tally signals TDL failures with `<LINEERROR>` rather than an HTTP status.
 *
 * IMPORTANT, and the reason this is narrower than it looks: during sample
 * collection, a request naming a collection it had not defined did not
 * produce an error response at all. TallyPrime raised a modal dialog on the
 * desktop, stopped serving HTTP entirely, and then terminated when the dialog
 * was dismissed. There is no response to parse in that case — the connection
 * simply dies. `LINEERROR` handling here covers the errors Tally *does*
 * return; it cannot cover the class of request that takes Tally down instead,
 * which is why `requests.ts` never emits an undefined collection reference.
 * See docs/known-limitations.md.
 */
export function assertNoTallyError(nodes: readonly TallyNode[]): void {
  const lineError = findFirst(nodes, 'LINEERROR');
  if (lineError === null) return;

  const message = textOf(lineError)?.trim();
  if (message === undefined || message === '') return;

  // A missing/unloaded company is the common case and has its own code, so
  // Claude can tell the user to load it rather than reporting a parse failure.
  if (/company/i.test(message) && /(not\s+found|does\s+not\s+exist|unknown)/i.test(message)) {
    throw new TallyError('TALLY_COMPANY_NOT_LOADED', `TallyPrime reported: ${message}`, {
      context: { lineError: message },
    });
  }

  throw new TallyError('TALLY_INVALID_RESPONSE', `TallyPrime reported an error: ${message}`, {
    context: { lineError: message },
  });
}

/**
 * True when the payload is Tally's plain liveness reply rather than data.
 *
 * A bare GET to Tally returns `<RESPONSE>TallyPrime Server is Running</RESPONSE>`.
 * It proves reachability and nothing else, so treating it as an empty result
 * set would report "no ledgers" when the real answer is "wrong request".
 */
export function isLivenessResponse(nodes: readonly TallyNode[]): boolean {
  const response = findFirst(nodes, 'RESPONSE');
  if (response === null) return false;
  return /server is running/i.test(textOf(response) ?? '');
}
