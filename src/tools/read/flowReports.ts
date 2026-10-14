/**
 * Cash flow and fund flow — monthly movement, deliberately NOT classified
 * statements.
 *
 * These two are variants of `tally_get_statement` (see reports.ts), which owns
 * the registration; this module contributes only the descriptive text, because
 * what is worth saying about a funds flow has nothing in common with what is
 * worth saying about a trial balance. The request builders and normalisers live
 * in requests.ts and normalize.ts alongside the other three statements.
 *
 * ## History, and why the output is shaped this way
 *
 * Until 2026-08-12 both tools always refused with
 * `TALLY_UNSUPPORTED_OPERATION`, for two reasons. The first — "the retrieval
 * path is unverified and probing it is dangerous" — was disproven by a live
 * probe on 2026-08-10: `Cash Flow` and `Funds Flow` are real report IDs that
 * answer with month-by-month figures, and an unresolvable report ID rejects
 * cleanly. (The crash documented in docs/known-limitations.md belongs to
 * undefined *collections*, a different request shape.)
 *
 * The second reason still stands and shapes the output: Tally supplies no
 * operating/investing/financing classification, so this data is monthly
 * movement, not a cash flow statement. The variants return Tally's three
 * columns per month under Tally's own vocabulary (debit, credit, net), and the
 * descriptions tell Claude to present it as movement, never as a classified
 * statement. Inventing the classification here would present a judgement
 * about the business as fact — the thing this server exists not to do.
 *
 * Verified live 2026-08-12 (TallyPrime 7.x): cash flow rows satisfy
 * net = debit + credit; funds flow rows satisfy net = credit − debit, with
 * each month's debit equal to the previous month's credit — i.e. Tally is
 * reporting opening funds, closing funds and the change.
 */

const MONTH_LABEL_NOTE =
  'MONTH LABELS: Tally labels rows by month name only ("April"), in order from fromDate; the ' +
  'year is not repeated. A period spanning more than twelve months repeats month names.';

/** The `cash_flow` variant of tally_get_statement. */
export const CASH_FLOW_SUMMARY = [
  "cash_flow — monthly cash movement from TallyPrime's own Cash Flow report. NOT a classified " +
    'cash flow statement.',
  '',
  "RETURNS: one row per month with Tally's own debit, credit and net columns (net = debit + " +
    'credit). Receipts into cash are debits to cash accounts; payments out are credits.',
  '',
  'WHAT THIS IS NOT — say so when presenting it: a formal cash flow statement classifies ' +
    'movements into operating, investing and financing activities. Tally supplies no such ' +
    'classification and this server invents none. Present it as "monthly cash movement". If a ' +
    'classified statement is wanted, this plus tally_get_ledger_transactions on the cash and bank ' +
    'ledgers is the raw material; the classification is a judgement to make with the user and to ' +
    'state.',
  '',
  MONTH_LABEL_NOTE,
].join('\n');

/** The `fund_flow` variant of tally_get_statement. */
export const FUND_FLOW_SUMMARY = [
  "fund_flow — monthly funds movement, from TallyPrime's own Funds Flow report. NOT a " +
    'classified fund flow statement.',
  '',
  'WHEN TO USE: for month-by-month questions about the funds position over a period.',
  '',
  "RETURNS: one row per month with Tally's three columns passed through under Tally's own " +
    "names: debit, credit and net. Verified against a live install: each month's debit equals " +
    "the previous month's credit, and net = credit − debit — Tally is reporting the month's " +
    'opening funds (debit column), closing funds (credit column) and the change (net). The ' +
    "columns are passed through without renaming, and Tally's sign convention is preserved.",
  '',
  'WHAT THIS IS NOT: a fund flow statement decides what counts as a source and an application ' +
    'of funds. That judgement is not made here, because Tally does not supply it. Present this ' +
    'as monthly movement; a sources-and-applications view can be assembled from two calls with ' +
    "statement: 'balance_sheet' at two dates plus this data, stating the basis used.",
  '',
  MONTH_LABEL_NOTE,
].join('\n');
