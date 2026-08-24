
import {
  toMoney,
  type Money,
} from '../../utils/numbers.js';
import {
  TallyError,
} from '../TallyError.js';
import {
  childrenOf,
  findFirst,
  isLivenessResponse,
  parseTallyXml,
  tagNameOf,
  textOf,
  assertNoTallyError,
  type TallyNode,
} from '../TallyResponseParser.js';

/**
 * The pieces every normaliser in this directory uses.
 *
 * Document opening, the report container and data scope, money reading, source
 * references, and the unread-payload invariant. Nothing domain-specific lives
 * here: no ledger, voucher or report shape is known to this module.
 *
 * Split out of the single normalize.ts, which had grown to 1,461 lines across
 * thirteen banner-delimited sections. Every function here follows the same two
 * rules as the rest of the normalisers.
 *
 * **Sign is preserved, never corrected.** Tally's trial balance reports debit
 * balances as negative and P&L expenses as negative. That is Tally's own
 * encoding, and silently flipping it would mean the number Claude reasons about
 * is not the number the accountant would see in Tally.
 *
 * **An unreadable value becomes null plus a warning, never a zero.** A
 * fabricated 0.00 in an audit context is worse than an admitted gap, because it
 * is indistinguishable from a real balance of zero.
 */

/**
 * Every TallyPrime element name this module depends on, in one place.
 *
 * These are the wire contract, and TallyPrime does not document it. Scattered as
 * bare literals through the normalisers they were unreviewable: a tag renamed or
 * dropped in a future Tally build yields ZERO ROWS, not a type error, and the
 * only way to find what a normaliser actually requires was to read every line of
 * it. Collected here, "what does this module need from Tally?" is one block to
 * read and one place to change.
 *
 * The keys are the tag names themselves rather than friendlier aliases: an alias
 * would put a second vocabulary between the reader and the payload they are
 * comparing against, and the payload only ever says the tag.
 */
const TAG = {
  DATA: 'DATA',
  ENVELOPE: 'ENVELOPE',
} as const;

/** A normalised result together with anything the caller should be told. */
export interface Normalized<T> {
  data: T;
  warnings: string[];
}

/**
 * Where a record came from, carried on every normalised record so a figure
 * can be traced back to the system that produced it.
 */
export interface SourceRef {
  system: 'tallyprime';
  entityType:
    | 'company'
    | 'ledger'
    | 'group'
    | 'voucher'
    | 'stockItem'
    | 'godown'
    | 'reportRow';
  /** Best available identity: a GUID where Tally provides one, else a name. */
  identifier: string;
}

export function sourceRef(entityType: SourceRef['entityType'], identifier: string): SourceRef {
  return { system: 'tallyprime', entityType, identifier };
}

/** Parse, reject non-data payloads, and hand back the ordered document. */
export function openDocument(xml: string): TallyNode[] {
  const nodes = parseTallyXml(xml);
  assertNoTallyError(nodes);

  if (isLivenessResponse(nodes)) {
    throw new TallyError(
      'TALLY_INVALID_RESPONSE',
      'TallyPrime returned its liveness reply instead of data.',
      {
        suggestion:
          'Tally is reachable but did not treat this as a data request. Check that a company is loaded.',
      }
    );
  }

  return nodes;
}

/**
 * The element whose children are a report's parallel arrays.
 *
 * Reports put them directly under `<ENVELOPE>` with no BODY/DATA wrapper,
 * unlike collections. Falling back to the document root keeps this working if
 * a future Tally build adds one.
 */
export function reportContainer(nodes: TallyNode[]): TallyNode {
  const envelope = findFirst(nodes, TAG.ENVELOPE);
  return envelope ?? { ENVELOPE: nodes };
}

/**
 * Narrow a collection response to its `<DATA>` section.
 *
 * This is not tidiness — it prevents a real class of bug. Every collection
 * response opens with a `<CMPINFO>` block of record counters whose tag names
 * are the *same* as the record tags: `<COMPANY>0</COMPANY>`,
 * `<LEDGER>0</LEDGER>`, `<VOUCHER>0</VOUCHER>`. A document-wide search for
 * "VOUCHER" therefore finds a phantom leading record with no fields, which
 * both inflates counts by one and shifts every index. Scoping to DATA removes
 * the counters at the source rather than filtering for their symptoms.
 *
 * Falls back to the whole document when there is no DATA wrapper.
 */
export function dataScope(nodes: TallyNode[]): TallyNode[] {
  const data = findFirst(nodes, TAG.DATA);
  return data === null ? nodes : [data];
}

/**
 * Read an amount, recording a warning when a present value will not parse.
 *
 * `currency` is REQUIRED rather than defaulted, and that is deliberate. It used
 * to default to INR, which meant every figure this server returned was labelled
 * INR whatever the company's books were actually in — verified live 2026-08-13
 * against a US company whose base currency is `$`, whose dollar balances came
 * back labelled `"currency": "INR"`. Nothing converted, so the numbers were
 * right and only the label lied, which is the more dangerous failure: an
 * accountant reading 494,397.50 INR against books stating $494,397.50 has been
 * handed a plausible wrong fact. Making the parameter mandatory means the
 * compiler, not a reviewer, guarantees every construction site supplies it.
 */
export function readMoney(
  raw: string | null,
  label: string,
  warnings: string[],
  currency: string
): Money | null {
  if (raw === null || raw.trim() === '') return null;

  const money = toMoney(raw, currency);
  if (money === null) {
    warnings.push(`Could not read the amount "${raw}" for ${label}; it is reported as null.`);
  }
  return money;
}

/**
 * Size of TallyPrime's empty-result envelope, plus room for whitespace.
 *
 * Measured at 23 bytes on a live install (see genericReport.ts). Anything
 * meaningfully larger carried content, which is what separates "no rows" from
 * "rows this parser could not read".
 */
export const EMPTY_ENVELOPE_BYTES = 64;

/**
 * The invariant every normaliser is held to: a payload that carried content
 * must never be reported as an empty result.
 *
 * ## Why this is a shared rule and not a per-parser detail
 *
 * `normalizeGenericReport` read one row shape and returned zero rows for three
 * reports that use others. TallyPrime had sent 2,098 bytes of Journal Register
 * and 1,677 of Ratio Analysis; the tool answered "no rows" and appended its
 * standing note that an empty result is a real answer on an exception report.
 * The output did not merely lose the figures, it argued the loss was clean.
 *
 * That was one parser's bug, but it is a shape EVERY parser here can take: each
 * one matches specific tag names against a payload whose shape TallyPrime does
 * not document, and each returns an array that is empty both when there is
 * nothing and when nothing matched. Those two cases are indistinguishable from
 * the outside and mean opposite things.
 *
 * So the distinction is drawn once, from the only evidence available — the byte
 * count. Above the empty-envelope size, content arrived; zero rows then means
 * this server failed to read it, and says so in those words.
 *
 * Returns the warning to push, or undefined when there is nothing to say.
 * Callers append it; nothing is suppressed or rewritten.
 */
export function unreadablePayloadWarning(
  xml: string,
  rowsParsed: number,
  /** What was being parsed, named as the caller would describe it. */
  what: string
): string | undefined {
  if (rowsParsed > 0) return undefined;
  if (xml.length <= EMPTY_ENVELOPE_BYTES) return undefined;

  return (
    `UNREAD PAYLOAD: TallyPrime returned ${String(xml.length)} bytes for ${what}, so this is NOT ` +
    'an empty result — but no rows could be read from it. Something in the response did not ' +
    'match the layout this server expects. Do NOT report this as "none found" or "nothing to ' +
    'report": there is data here that was not parsed. Check the same view on screen in ' +
    'TallyPrime, and treat this as a gap in this server rather than in the books.'
  );
}

/** Every scalar tag at any depth below a node, first occurrence winning. */
export function descendantScalars(node: TallyNode): Record<string, string> {
  const found: Record<string, string> = {};

  const walk = (current: TallyNode): void => {
    for (const child of childrenOf(current)) {
      const tag = tagNameOf(child);
      if (tag === null) continue;
      if (childrenOf(child).some((grandchild) => tagNameOf(grandchild) !== null)) {
        walk(child);
        continue;
      }
      const text = textOf(child);
      if (text === null) continue;
      const trimmed = text.trim();
      if (trimmed === '') continue;
      found[tag] ??= trimmed;
    }
  };

  walk(node);
  return found;
}

/** Tally's boolean encoding. Anything that is not an explicit Yes is false. */
export function isYes(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === 'yes';
}

/**
 * Structures excluded from `nested`.
 *
 * Two kinds:
 *
 * - **Entry lists**, because they are returned as `entries` in their own
 *   right. Repeating them here would report the same data twice in two
 *   different shapes.
 * - **Tally's internal audit-trail lists**, which carry row IDs and a `-1`
 *   sentinel rather than anything about the transaction. They are populated on
 *   every record, so without this they would appear as a nested structure on
 *   every single voucher and entry and crowd out the structures that matter.
 */
export const NON_ACCOUNTING_STRUCTURES = new Set([
  'ALLLEDGERENTRIES.LIST',
  'LEDGERENTRIES.LIST',
  'OLDAUDITENTRYIDS.LIST',
  'AUDITENTRIES.LIST',
  'OLDAUDITENTRIES.LIST',
  'ACCOUNTAUDITENTRIES.LIST',
]);
