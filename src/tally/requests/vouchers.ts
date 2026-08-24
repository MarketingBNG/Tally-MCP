
/**
 * Tally request construction.
 *
 * Tally is a single-endpoint POST API: everything goes to the same URL and
 * the payload decides what you get. Request *shape* is documented (unlike
 * response shape), so this module can be written and tested without
 * ground-truth samples.
 *
 * READ-ONLY GUARANTEE: `TALLYREQUEST` is hard-coded to `Export` in every
 * builder here, and no builder emits an Import/Alter/Delete envelope. This is
 * the only place Tally request bodies are constructed — tool code never
 * assembles payloads directly — so this file is the single place to audit
 * that claim. There is a test asserting no write verb appears anywhere.
 */
import { buildCollectionRequest, buildReportRequest, type TallyRequestOptions } from './envelope.js';

/**
 * The voucher collection, the register, and the two AlterId fingerprint requests.
 *
 * Split out of requests.ts at 736 lines. The fingerprint requests are what let
 * the unattended exporter ask "has anything changed?" without re-exporting the
 * books, and they are defined here rather than in their caller so the
 * Export-only guarantee covers them too.
 */

/**
 * Vouchers WITH their ledger and inventory entries.
 *
 * A collection over `Voucher`, not the `Voucher Register` report, and the
 * difference is not a preference — the report cannot answer an accounting
 * question at all. Verified live 2026-08-13 against TallyPrime on a company
 * with 453 vouchers: the report returns 28 KB of field scaffolding per voucher
 * (246 distinct tags, almost all empty) and **zero** ledger entries. No
 * `ALLLEDGERENTRIES.LIST`, no `LEDGERNAME`, no `AMOUNT`. `EXPLODEFLAG` does
 * not change that. Every voucher therefore parsed with `entries: []`, which
 * silently zeroed every movement-based figure this server produces — the
 * tie-out control reported 34 exceptions and 0 vouchers checked against books
 * that actually balance.
 *
 * The entry lists MUST be named explicitly in `FETCH`. `<FETCH>*</FETCH>` is
 * the trap: it returns 10.9 MB of every scalar Tally holds and still omits the
 * entries, so it looks like the most complete request available while being
 * exactly as useless as the report. Verified on the same company — `*` gave 0
 * entries, the explicit list gave 907 ledger entries and 466 inventory entries.
 *
 * DATES ARE NOT SCOPED HERE, and that is Tally's behaviour, not an omission.
 * A collection ignores SVFROMDATE/SVTODATE: asked for April 2025 alone (13
 * vouchers) it returned all 453 spanning the full year. So the whole book comes
 * back and callers filter by date themselves. `staticVariables` still emits the
 * dates — they cost nothing and a future Tally build may honour them — but
 * nothing may rely on them having been applied.
 */
export function buildVoucherCollectionRequest(
  options: TallyRequestOptions,
  allFields = false
): string {
  // Order matters for `allFields`: `*` first, then the entry lists, because the
  // wildcard does not imply them and naming them after it is what brings them back.
  const fields = allFields
    ? ['*', 'AllLedgerEntries', 'AllInventoryEntries']
    : [
        'Date',
        'GUID',
        'VoucherTypeName',
        'VoucherNumber',
        'PartyLedgerName',
        'Narration',
        'IsCancelled',
        'IsOptional',
        // Order and note vouchers are NOT transactions in the accounting sense.
        // `tally-database-loader` fetches both flags precisely so they can be
        // excluded from financial totals: a sales or purchase ORDER is a
        // commitment carrying no ledger entries, and a delivery or receipt note
        // moves stock without touching accounts — so a receipt note and the
        // purchase invoice that follows it both carry inventory lines for the
        // same goods, and counting both double-counts the movement.
        //
        // Absent on a company that records neither, which reads as false. Adding
        // them to the fetch list costs nothing: Tally sends the field superset
        // regardless and leaves the inapplicable ones empty.
        'IsOrderVoucher',
        'IsInventoryVoucher',
        /**
         * When the voucher was last WRITTEN, as distinct from the date it is
         * dated. The nearest thing to an entry timestamp this interface serves —
         * Tally's Edit Log has no report ID and `EnteredBy`/`AlteredBy` come back
         * empty (docs/probe-findings-2026-08-18.md), so this is the only evidence
         * available that an entry was keyed in long after the date on its face.
         *
         * Costs nothing measurable: one 17-digit field per voucher. Absent as a
         * real value on a company that does not stamp — it arrives as all zeros,
         * which `tallyDateTimeToIso` deliberately reads as null.
         */
        'UpdatedDateTime',
        'AllLedgerEntries',
        'AllInventoryEntries',
      ];

  return buildCollectionRequest('AllVouchers', 'Voucher', fields, options, 'commaFetch');
}

/**
 * Every voucher's `AlterId` and `MasterId`, and nothing else — the change check.
 *
 * This is what lets the unattended exporter ask "has anything changed?" every
 * minute instead of re-exporting the books: measured live 2026-08-13, 537.6KB in
 * 199-260ms against 8.6MB in ~2,000ms, so roughly 16x smaller and 10x faster.
 * `src/export/fingerprint.ts` is the caller, and carries the reasoning that
 * matters — why the SET of pairs rather than the maximum (a maximum cannot see a
 * deletion), and what still rests on `ALTERID` moving on every edit.
 *
 * `MasterId` is fetched alongside because it is what makes a deletion visible:
 * the pair simply disappears from the set.
 *
 * The shape is defined here rather than in the caller so that the Export-only
 * guarantee this file carries covers it too. `scripts/probe-alterid.mjs` imports
 * it for the same reason — a probe that builds its own request body would not be
 * testing what production sends.
 */
export function buildVoucherAlterIdRequest(options: TallyRequestOptions): string {
  return buildCollectionRequest(
    'VoucherAlterIds',
    'Voucher',
    ['AlterId', 'MasterId'],
    options,
    'commaFetch'
  );
}

/**
 * Every ledger's `AlterId`, and nothing else — the masters half of the change check.
 *
 * A voucher-only fingerprint cannot see a renamed ledger, a new ledger or a
 * changed opening balance: none of those touches a voucher, so the workbook
 * would keep serving the old chart of accounts until somebody happened to post
 * an entry. Measured live 2026-08-18: the ledger collection carries `ALTERID`
 * on all 367 records, so the masters get the same treatment as the vouchers.
 *
 * `Ledger` is a collection TYPE this server already uses (see
 * `buildLedgerListRequest`), which matters: an UNOBSERVED collection type parks
 * TallyPrime behind a modal dialog until someone dismisses it, so a new one is
 * never introduced casually.
 */
export function buildLedgerAlterIdRequest(options: TallyRequestOptions): string {
  return buildCollectionRequest(
    'LedgerAlterIds',
    'Ledger',
    ['AlterId', 'MasterId', 'Name'],
    options,
    'commaFetch'
  );
}

/**
 * Vouchers WITH their entries, for a period a collection cannot reach.
 *
 * ## Why this exists when a Voucher collection already returns vouchers
 *
 * A Voucher collection is pinned to the company's CURRENT financial year and
 * cannot be moved off it. Measured live 2026-08-17 against MUDALS (books
 * 2021-04-01 to 2026-07-28): `SVFROMDATE`/`SVTODATE`, `SVCURRENTDATE` and
 * `SVCURRENTPERIOD` were each tried, alone and combined, and every one returned
 * the same 284 current-year vouchers dated 2026-04-01 to 2026-07-28 — byte for
 * byte the same response. Five years of real history were unreachable.
 *
 * `Voucher Register` is a REPORT, and reports honour the date range. The same
 * probe returned 14 vouchers for FY2023-24 with 50 ledger entries, and 788 and
 * 1,534 vouchers for the two years after.
 *
 * ## This corrects an earlier finding in this codebase
 *
 * `buildVoucherCollectionRequest` above records that Voucher Register returns
 * "zero ledger entries". That was measured WITHOUT an explicit date range. With
 * one, the report carries full `ALLLEDGERENTRIES.LIST` data and the existing
 * `normalizeVouchers` reads it unchanged.
 *
 * Equivalence was checked rather than assumed, because mixing two sources in one
 * answer is only safe if they agree: over the same period the collection and this
 * report returned **284 vouchers, 985 entries, identical GUID sets and the same
 * total to the paisa**.
 *
 * ## Cost, which is the reason this is not simply used everywhere
 *
 * For the same 284 vouchers the collection sent 336KB and this report 17MB —
 * about 50x. Per financial year, measured: FY2023-24 880KB/0.3s, FY2024-25
 * 39MB/27s, FY2025-26 79MB/103s. One request for the whole five-year span TIMED
 * OUT at 120s. So callers fetch ONE FINANCIAL YEAR PER CALL and keep the
 * collection for the current year.
 */
export function buildVoucherRegisterRequest(options: TallyRequestOptions): string {
  return buildReportRequest('Voucher Register', options);
}
