
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
import {
  buildCollectionRequest,
  UNSCOPED,
  type TallyRequestOptions,
} from './envelope.js';

/**
 * The master collections: companies, ledgers, groups, voucher types, currencies,
 * stock items, and the simple name/parent masters.
 *
 * Split out of requests.ts at 736 lines. Each of these names a collection TYPE,
 * and an UNRECOGNISED type parks TallyPrime behind a modal dialog until somebody
 * dismisses it — which is why SIMPLE_MASTER_TYPES is a closed list with a probe
 * script behind it rather than something to extend casually.
 */

/**
 * Company list, including basic period metadata and the base currency.
 *
 * `CurrencyName` is what stops every figure being mislabelled. Tally reports it
 * as a SYMBOL rather than an ISO code — verified live 2026-08-13, a US company
 * returned `<CURRENCYNAME>$</CURRENCYNAME>` and
 * `<COUNTRYNAME>United States of America</COUNTRYNAME>`. Without it the server
 * fell back to a hard-coded INR and labelled dollar balances as rupees.
 *
 * `BaseCurrencySymbol` and `BaseCurrencyFormalName` were probed at the same time
 * and are NOT supported on this collection: Tally silently omitted them rather
 * than erroring, which is worth knowing — an unsupported native method here fails
 * open, so a missing field means "not served", never "not set".
 */
export function buildCompanyListRequest(
  // Defaulted to UNSCOPED, and this is the one builder where a default is
  // right: "which companies are open" is not a question about a company, so
  // there is nothing to scope it to and no way to forget one.
  options: TallyRequestOptions = { company: UNSCOPED }
): string {
  return buildCollectionRequest(
    'List of Companies',
    'Company',
    ['Name', 'StartingFrom', 'EndingAt', 'CompanyNumber', 'GUID', 'CurrencyName', 'CountryName'],
    options
  );
}

/**
 * Ledger masters.
 *
 * `allFields` switches from the curated set to everything Tally holds. Use it
 * when the question is about what a company actually records — different
 * companies enable different features, so the field set is a property of the
 * company, not something this server can know in advance. It costs roughly
 * 37x the payload, so it is opt-in.
 */
export function buildLedgerListRequest(
  options: TallyRequestOptions,
  allFields = false
): string {
  return buildCollectionRequest(
    'Ledgers',
    'Ledger',
    // Order matters for `allFields`, exactly as it does for vouchers: `*` first,
    // then the curated names, because the wildcard does not imply them.
    allFields ? ['*', ...LEDGER_FIELDS] : LEDGER_FIELDS,
    options
  );
}

/**
 * The curated ledger fields, named once because `allFields` must ALSO request
 * them rather than relying on `*`.
 *
 * WHY. `<FETCH>*</FETCH>` does not include `ClosingBalance`. Verified live
 * 2026-08-17 against MUDALS TECHNOLOGIES: listing ledgers returned ADP India
 * Pvt. Ltd. with a closing balance of -14,822,831, while fetching that same
 * ledger BY NAME — which takes the `allFields` path — returned `null` for it.
 * The wildcard is not the superset its name implies; it is a different set.
 *
 * That made the failure worse than a missing field. Rule 1 of the model is
 * that `null` means unreadable, so the most complete request available was
 * reporting the most important number on the account as unavailable when Tally
 * would have sent it for the asking. An accountant opening one party's detail
 * would read a blank balance as nothing to see.
 *
 * The cost of naming them alongside `*` is a duplicated tag or two in a
 * response already carrying ninety fields.
 */
const LEDGER_FIELDS = [
  'Name',
  'Parent',
  'OpeningBalance',
  'ClosingBalance',
  'LedgerPhone',
  'LedgerContact',
  'PartyGSTIN',
  'GSTRegistrationType',
  'IsBillWiseOn',
  'IsCostCentresOn',
  // Tally's own related-party flag. Verified live 2026-08-14: a real
  // ledger master field, returned populated on 330 of 330 ledgers. It
  // corrects earlier research for this project which concluded that
  // TallyPrime holds no related-party marking at all — it does, and it
  // is the right SEED for related-party screening even though it is not
  // by itself a complete list.
  'IsRelatedParty',
] as const;

/**
 * Ledger groups — the chart of accounts hierarchy itself, as distinct from
 * the ledgers filed under it. `Parent` is the group this one nests under
 * (empty for a primary group), and `IsRevenue`/`IsDeemedPositive` classify it
 * as P&L vs balance sheet and debit vs credit respectively.
 */
export function buildGroupListRequest(options: TallyRequestOptions): string {
  return buildCollectionRequest(
    'Groups',
    'Group',
    ['Name', 'Parent', 'IsRevenue', 'IsDeemedPositive', 'IsSubLedger'],
    options
  );
}

/**
 * Voucher types defined in the company, with the base type each derives from.
 *
 * Needed because voucher type NAMES are company-specific: a company can define
 * "GST Sales" or "Tax Invoice" deriving from the built-in `Sales` type.
 * Matching a voucher's type name against the string "sales" would miss those
 * and quietly under-report. `Parent` is the base type, so this lets the family
 * be resolved from Tally rather than guessed.
 *
 * Verified against a live install.
 *
 * `allFields` is required to see the numbering setup, and the reason is a trap
 * worth knowing. The curated form CANNOT return it: the top-level
 * `NUMBERINGMETHOD` element on a voucher type reads `None` on every type — it is
 * a legacy field — while the real method lives in the nested
 * `VOUCHERNUMBERSERIES.LIST`, one entry per numbering series. Verified live
 * 2026-08-12 on a company where all 26 types reported top-level `None` and every
 * series was actually `Automatic` / `Auto Retain`, with a real invoice prefix.
 * Reading the scalar therefore produces a confident answer that is wrong, which
 * is why `numberingSeries` is normalised from the nested list instead and the
 * scalar is not reported at all.
 *
 * The whole collection with every field measured 142 KB for 26 types, so unlike
 * ledgers there is no meaningful cost to paying for it. The curated form is kept
 * because voucher-family resolution needs only name and parent, and it runs on
 * every family query.
 */
export function buildVoucherTypeListRequest(
  options: TallyRequestOptions,
  allFields = false
): string {
  return buildCollectionRequest(
    'VoucherTypes',
    'VoucherType',
    allFields ? '*' : ['Name', 'Parent', 'IsDeemedPositive'],
    options
  );
}

/**
 * The currencies this company defines.
 *
 * Cheap (1.7KB on a real company) and it answers one question that matters: is this
 * company multi-currency? Tally does not report a per-voucher currency on
 * single-currency books — probed live 2026-08-13, no CURRENCYNAME or FOREX field
 * appears on any voucher or entry — so this server cannot tell a foreign-currency
 * transaction from a base-currency one. Where more than one currency is DEFINED, that
 * gap is disclosed rather than left silent.
 *
 * `IsBaseCurrency` is requested but not served — Tally silently omits it, the same
 * fail-open behaviour as `BaseCurrencySymbol` on the company collection. The base
 * currency therefore comes from the company's own `CurrencyName`, not from here.
 */
export function buildCurrencyListRequest(options: TallyRequestOptions): string {
  return buildCollectionRequest(
    'Currencies',
    'Currency',
    ['Name', 'MailingName', 'IsBaseCurrency', 'DecimalPlaces'],
    options
  );
}

/**
 * Stock item masters.
 *
 * UNVERIFIED SHAPE: the request uses the same proven collection form as
 * ledgers and returns 200 OK, but the test company holds **zero stock items**
 * (`<STOCKITEM>0</STOCKITEM>`), so a populated inventory response has never
 * been seen. Normalisation therefore promotes only `Name` and `Parent` — safe
 * by analogy with every other master — and returns everything else through the
 * generic field extraction, so the tool reports whatever Tally actually sends
 * rather than a guessed mapping. See docs/known-limitations.md.
 */
export function buildStockItemListRequest(
  options: TallyRequestOptions,
  allFields = false
): string {
  return buildCollectionRequest(
    'StockItems',
    'StockItem',
    allFields
      ? '*'
      : [
          'Name',
          'Parent',
          'Category',
          'BaseUnits',
          'ClosingBalance',
          'ClosingValue',
          'ClosingRate',
          'OpeningBalance',
          'OpeningValue',
        ],
    options
  );
}

/**
 * One of the simple master lists — cost centres, units, stock groups and their kin.
 *
 * ## The safety rule this sits inside
 *
 * Each of these needs a collection TYPE, and an unrecognised TYPE parks
 * TallyPrime behind a modal dialog until somebody dismisses it. That is why
 * type probing was stopped after two hangs and why these lists were documented
 * as unreachable rather than untried.
 *
 * The types named in `SIMPLE_MASTER_TYPES` below were re-probed on 2026-08-21
 * against TallyPrime 7.1 — watched, one at a time, export disabled, with a
 * `Ledger` control — and every one was accepted in under 30ms with no dialog.
 * That is why they are here, and why the list is CLOSED: adding a type to it
 * without running scripts/probe-collection-types.mjs first would reintroduce
 * exactly the hazard the rule exists for.
 */
export const SIMPLE_MASTER_TYPES = [
  'CostCentre',
  'CostCategory',
  'Godown',
  'Unit',
  'StockGroup',
  'StockCategory',
  'Budget',
] as const;

export type SimpleMasterType = (typeof SIMPLE_MASTER_TYPES)[number];

export function buildSimpleMasterRequest(
  type: SimpleMasterType,
  options: TallyRequestOptions
): string {
  // `*` rather than a named list: these are small — one to a few dozen records —
  // and which fields a company populates on a cost centre or a unit is exactly
  // the interesting part, the same reasoning the ledger all-fields path follows.
  return buildCollectionRequest(`${type}Masters`, type, '*', options);
}
