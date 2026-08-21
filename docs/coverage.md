# Coverage register

What of TallyPrime's data this server can reach, what it cannot, and why.

The point of counting it: "100% coverage" is only meaningful if it is measured.
A release states its Layer 1 coverage as a number, and every gap is listed with a
reason. A gap that is not listed here is not "assumed closed" — it is unknown,
which is a different and worse state.

**Layers.** Layer 1 is everything TallyPrime holds, which must become reachable.
Layer 2 is everything Tally does *not* hold, covered by accepting it as caller
input (GSTR-2B, 26AS, bank statements, credit terms). Layer 3 is the irreducible
residue after both.

> First established 14 Aug 2026 from live measurement against
> **MUDALS TECHNOLOGIES PRIVATE LIMITED**, then re-measured the same day against
> **three companies loaded simultaneously**. Evidence:
> [probe-findings-2026-08-14.md](probe-findings-2026-08-14.md).

### The companies this register has actually been measured against

| Company | Country | Currency as Tally sends it | Books | Features in use |
|---|---|---|---|---|
| AGBV Nutrition GmbH - (from 1-Jan-24) | Germany | `?` (euro, destroyed in transport) | 2023-01-01 → 2026-07-31 | — |
| AgEx Pharma LLC (25-26) | USA | `$` | 2025-04-01 → 2026-03-31 | inventory (3 items), cost centres enabled on 25 of 54 ledgers |
| MUDALS TECHNOLOGIES PRIVATE LIMITED | India | `?` (rupee, same) | 2021-04-01 → 2026-07-28 | GST, 330 ledgers |

Three currencies and three different year-ends, which is what makes this a usable
test bed rather than one company generalised from.

**What three companies resolved.** Multi-company reading works: `SVCURRENTCOMPANY`
selects per request and the three return genuinely different figures, so the
"one company at a time" limitation is withdrawn. Name matching was measured as
case-insensitive and whitespace-tolerant, with an unmatched name returning empty
rather than another company's data.

**What three companies did NOT resolve, and this is the important part.** None of
the three uses **bill-wise tracking**, so bill references, ageing and the whole
Schedule III note remain unverified against real bills — the single largest
remaining gap. None has **Edit Log** on, a **budget** defined, **fixed assets with
depreciation entries**, or a **bank reconciliation done inside Tally**. And
`Cost Category Summary` returned empty even on the company with cost centres
enabled on 25 ledgers, so cost-centre reachability is still unproven.

So the rows below that say `unknown` mostly still say it. Three companies was a
large improvement in confidence about what *works*, and almost no improvement in
coverage of the features nobody here uses.

---

## The collection-TYPE safety rule, as it now stands (2026-08-21)

The rule was **never send a collection TYPE this server has not observed**, after
two probes hung TallyPrime behind a modal dialog. Seven master lists were
documented unreachable on that basis.

Re-probed on 2026-08-21 against TallyPrime 7.1 — with somebody watching the Tally
window, the scheduled export disabled, one type at a time, a 12-second timeout, a
health check between each, and a `Ledger` control — **all seven were accepted**:
`CostCentre`, `CostCategory`, `Godown`, `Unit`, `StockGroup`, `StockCategory`,
`Budget`. Fastest 14ms, slowest 30ms. No dialog. No `LINEERROR`. The control
passed alongside them, so the probe itself was sound.

**What this does and does not change.** Those seven are now production routes and
ship as workbook tabs. What is NOT established is that any type is safe: the two
hangs were real, and the likeliest explanation is a type name TallyPrime does not
recognise at all. So the rule becomes *probe deliberately* rather than *never
probe* — `scripts/probe-collection-types.mjs` is the way, and its header lists the
three conditions that have to hold first. Adding a name to `SIMPLE_MASTER_TYPES`
without running it would reintroduce exactly the hazard.

---

## Layer 1 status summary

| Status | Meaning | Count |
|---|---|---|
| `reachable` | Verified working against live data | 19 |
| `reachable-shape-unverified` | Route works; this company has no such data, so the response shape is unproven | 5 |
| `blocked` | Verified route does NOT exist, or is unsafe to use | 6 |
| `unknown` | Not measured. Not a claim either way | 7 |

**Layer 1 coverage is not stated as a percentage yet, deliberately.** With rows
still unknown and four report shapes still unverified, any percentage would be a
guess dressed as a measurement. It becomes statable once the rows below are resolved
against companies that use the relevant features — and going from one company to
three did not resolve them, because all three lack the same features.

---

## Masters

| Data | Status | Route | Evidence / reason |
|---|---|---|---|
| Companies (name, start date) | reachable | `Company` collection | production |
| Company `EndingAt` | reachable | `Company` collection | **Row corrected 17 Aug 2026** — was recorded as blocked-ours. `tally_list_companies` surfaces it as `endingAt` for all four loaded companies |
| Ledgers | reachable | `Ledger` collection | 331 records live |
| Groups | reachable | `Group` collection | production |
| Voucher types | reachable | `VoucherType` collection | production |
| Currencies | reachable | `Currency` collection | production |
| Stock items | reachable-shape-unverified | `StockItem` collection | 0 items on this company |
| Chart of accounts | reachable | `List of Accounts` report | 7.5 MB live |
| `ISRELATEDPARTY` flag | reachable | ledger field | 330/330 populated. Corrects an earlier plan assumption |
| TDS / TCS applicability | reachable | ledger fields | **Verified live 17 Aug 2026.** `ISTDSAPPLICABLE`, `ISTCSAPPLICABLE`, `ISTDSEXPENSE`, `IGNORETDSEXEMPT`, `TDSDEDUCTEEISSPECIALRATE`, `TDSDEDUCTEESPECIALRATE`, `TAXTYPE` all present on a live ledger master, carrying explicit negatives where the feature is off. Surfaced by `tally_get_tds` |
| TDS section / nature of payment | unknown | separate master | Not observed populated — no probed company deducts tax. Passed through where it appears; never claimed complete. The TYPE name is unknown, and an unknown TYPE is still not probed casually — but see the note below: the rule is now "probe deliberately", not "never probe" |
| MSME / Udyam registration | unknown | ledger field, unconfirmed | **Row corrected 17 Aug 2026** — briefly recorded as blocked, which one company cannot support. Absent across all 472 ledgers of MUDALS TECHNOLOGIES, and Tally does emit unpopulated fields, so this company genuinely does not record it. TallyPrime DOES offer MSME details on the party ledger in recent releases; whether they transport over HTTP is **untested** for want of a company that uses them. Same class as cost centres and bill-wise: waiting on books, not on code |
| `ALTERID` / `UPDATEDDATETIME` | reachable | ledger fields | 367/367 populated |
| Cost centres (masters) | reachable | `CostCentre` collection | **Row corrected 2026-08-20→21 — was "not sent, probing stopped after two hangs".** Re-probed 2026-08-21 on TallyPrime 7.1, watched, export disabled, with a `Ledger` control: accepted in 14ms, no dialog, no error. 0 records on AGBV (the company defines none) — an empty list, not a refusal. Now a workbook tab |
| Cost categories (masters) | reachable | `CostCategory` collection | **Row corrected 2026-08-21.** Accepted in 30ms under the same probe; returned `Primary Cost Category` on AGBV. Now a workbook tab |
| Godowns (masters) | reachable | `Godown` collection | **Row corrected 2026-08-21.** Accepted in 24ms; returned `Main Location` with parent `Primary` on AGBV. The derived "used" list and the `Godown Summary` report both remain, answering different questions — defined, posted-to, and holding stock are three things |
| Budgets | reachable (route), unproven (shape) | `Budget` collection | **Row corrected 2026-08-21.** The two REPORTS are still rejected, but the `Budget` collection TYPE is accepted — no dialog, no error — and returned 0 records on every company loaded, none of which uses budgets. So the route exists and the row shape has never been observed. Now a workbook tab that will populate on a company that budgets |

## Transactions

| Data | Status | Route | Evidence / reason |
|---|---|---|---|
| Vouchers, **current** financial year | reachable | `Voucher` collection | 285 vouchers live |
| Vouchers, **any prior** year | reachable | `Voucher Register` report, one book year per call | **Row corrected 2026-08-20 — was recorded as blocked.** The collection is current-FY only and `Day Book` does ignore its dates, both still true. But `Voucher Register` is a REPORT and reports honour a date range: verified live 2026-08-17 (14 vouchers for FY2023-24 with 50 entries; 788 and 1,534 for the two years after) and again 2026-08-20, when the workbook export went from 284 vouchers in one year to **2,738 across five**, entries still summing to zero. Cost is the reason no interactive tool defaults to it: ~880KB/0.3s, 39MB/27s and 79MB/103s for three successive years. `fetchAcrossBookYears` routes prior years here and the current year to the collection |
| Ledger entries (debit/credit lines) | reachable | `AllLedgerEntries` in FETCH | 985 live |
| Bill allocations | reachable-shape-unverified | arrives free in shipped FETCH | 985 containers; company has bill-wise tracking off, so contents unproven |
| Bank allocations | reachable | arrives free in shipped FETCH | 985; production tool reads it |
| Cost centre allocations | reachable-shape-unverified | `AllLedgerEntries.CategoryAllocations.CostCentreAllocations` | Path accepted and safe; 0 allocations on this company. Hierarchy is one level deeper than assumed |
| Inventory entries | reachable-shape-unverified | `AllInventoryEntries` | no inventory on this company |
| Batch / godown allocations | reachable | `AllInventoryEntries.BatchAllocations` | **Row corrected 2026-08-20 — was unknown/untried.** Found by walking the nested tree rather than probing: 42 on AgEx Pharma, 668 rows on AGBV Nutrition, carrying `GODOWNNAME`, `BATCHNAME`, `BATCHID`, `ORDERNO`, `TRACKINGNUMBER` and quantities. This is TWO levels deep — it hangs off an inventory ENTRY, not off the voucher — which is why a one-level fetch had never seen it |
| Edit log / voucher versions | **blocked** | — | Settled 2026-08-18: eleven report IDs rejected against a working control on two companies, and `EnteredBy`/`AlteredBy` are served but EMPTY on every voucher of all three companies with data. Who altered an entry is not obtainable |
| Voucher-level audit fields | reachable | `UpdatedDateTime` etc. in FETCH | Settled 2026-08-18: `UpdatedDateTime`, `Audited`, `IsDeleted`, `IsDeletedVchRetained`, `IsSecurityOnWhenEntered`, `PersistedView`, `AsOriginal` all populated per voucher. `UpdatedDateTime` is a real per-voucher LAST-WRITTEN stamp (668 vouchers, 2 of 3 companies; the third returns all-zero placeholders) and ships as `tally_test_vouchers` test `late_entry`. `Audited` and `IsSecurityOnWhenEntered` read `No` on every voucher of all three, so they are readable with no variation to test against |

## Statements and reports

| Data | Status | Route | Evidence / reason |
|---|---|---|---|
| Trial balance | reachable | `Trial Balance` | production; carries stock at opening |
| Balance sheet | reachable | `Balance Sheet` | production |
| Profit and loss | reachable | `Profit and Loss` | production |
| Cash flow (monthly) | reachable | `Cash Flow` | production |
| Funds flow (monthly) | reachable | `Funds Flow` | production |
| Statement for a **mid-year** period | **blocked** | — | End date binds only on a 31st; otherwise accumulates to a fixed endpoint. Format-independent — four wire encodings tested |
| Negative ledgers (exception) | reachable | `Negative Ledgers` | 20,909 B live. **New capability** |
| Negative stock (exception) | reachable-shape-unverified | `Negative Stock` | valid but empty; no inventory |
| Ratio analysis | reachable | `Ratio Analysis` | **Row corrected 2026-08-20 — was recorded as reachable-but-empty.** The workbook export returned **21 populated rows** on MUDALS (Working Capital, Cash-in-Hand, Bank Accounts and so on), read for the company's defaulted period rather than the 1-Apr-26..28-Jul-26 window the 17 Aug probe used. So the report does serve content; the earlier zero was a property of that period, not of the report. Values arrive as FORMATTED STRINGS carrying Indian digit grouping and a Dr/Cr suffix — `1,46,32,571.18 Dr` — not as numbers, which is why the workbook writes every generic-report column as text. Still no first-class ratio tool: the column meanings remain unverified |
| Sales / purchase / journal registers | reachable | three report IDs | live |
| Stock summary / godown summary | reachable-shape-unverified | production builders | no inventory |
| Bills receivable / payable | reachable-shape-unverified | both IDs valid | empty; no bill-wise tracking |
| Cost centre break-up | **blocked** | — | report ID rejected; use the nested fetch path instead |
| Day book | **blocked (useless)** | `Day Book` | Valid, but ignores its date range entirely — byte-identical output for two different years |
| Licence / edition (Educational check) | **blocked** | — | six candidate report IDs all rejected |

## Audit procedures built on top of Layer 1

These compute nothing Tally holds; they arrange what it holds into the shape an
audit needs. Listed here because "reachable" says nothing about whether a
procedure exists to use the data.

| Procedure | Tool | Note |
|---|---|---|
| Monetary-unit (PPS) sampling | `tally_test_vouchers` → `sampleMethod: "monetary_unit"` | Value-weighted, certainty stratum flagged separately, interval and value tested disclosed. Directed at OVERSTATEMENT and says so |
| Related-party disclosure table | `tally_test_vouchers` → `test: "related_party"`, `byParty` | AS 18 / Ind AS 24 shape. Not netted, and a voucher between two related parties counts under both, so rows do not sum to a company total |
| Fixed asset movement schedule | `tally_get_fixed_assets` | Opening + additions − disposals vs closing, from two independent sources. Ties on all 10 readable ledgers of MUDALS, live 17 Aug 2026. Depreciation reported, never recomputed |
| Balance confirmation selection | `tally_get_confirmation_list` | Uncontactable parties retained and flagged rather than dropped. No default cut-off — that is a judgement |
| Workpaper rendering | `tally_make_workpaper` | Re-runs the procedure rather than formatting figures from the conversation. Refuses to write the conclusion |
| TDS / TCS configuration | `tally_get_tds` | Affirmative values only — Tally stamps the negatives onto every ledger |

## Layer 2 — caller-supplied

| Data | Status | Note |
|---|---|---|
| GSTR-2B | not built | Tally holds one side only; highest-value Layer 2 item still outstanding |
| Form 26AS / TDS | not built | one side only |
| Bank statement | not built | would turn the item list into a real reconciliation |
| Credit terms | **built** | `tally_get_outstanding` → `creditTerms`; per party or per group, party wins. Bills past their credit period are reported as `overdue`, and `overdue` is **absent** rather than zero when no terms were supplied |
| MSME party list | **deliberately not built** | Needed for the 45-day test under Sec 43B(h). NOT built on purpose: if Tally turns out to transport its own MSME fields, a caller-supplied list would make accountants retype data the books already hold. Decide only after probing a company that records MSME |
| Related-party list | **built** | `tally_test_vouchers` → `test: "related_party"`, `relatedParties`. **Extends** `ISRELATEDPARTY` rather than replacing it |
| Currency, where Tally sent `?` | **built** | `TALLY_CURRENCY_LABEL`. Used ONLY where Tally's symbol was untransportable, and the response says the label came from configuration |

## Layer 3 — irreducible

| Item | Why |
|---|---|
| Currency symbol | Tally converts `₹`, `€` and curly quotes to a literal `?` **before the bytes leave**. A label, never a number — every amount is exact. **Now covered at Layer 2** by `TALLY_CURRENCY_LABEL`, so Layer 3 is empty of anything that affects a figure |

---

## What changed on 14 Aug 2026, after the register was first written

Recorded here rather than only in the CHANGELOG, because this file is the one
that is supposed to say what is reachable.

**Newly reachable (Layer 1).** Nine built-in report views behind the allowlisted
`tally_get_report`: `Negative Ledgers`, `Ratio Analysis`, `Sales Register`,
`Purchase Register`, `Journal Register` (row shape read from live content), plus
`Negative Stock`, `Bills Receivable`, `Bills Payable`, `Cost Category Summary`
(ID accepted live, **row shape still unproven** — each returned empty on the probe
company, and the tool says so on every call). `ISRELATEDPARTY` is now fetched and
surfaced on every ledger.

**Newly computed, not newly fetched.** Eight audit procedures over the voucher
population that was already reachable — journal screening, Benford, reproducible
sampling, duplicates, round numbers, cut-off, weekend dating, related-party
screening — plus Schedule III ageing buckets computed as real calendar months.
None of these needed a new Tally route, which is the cheapest coverage there is.

**Re-probed against all three companies, still unverified.** `Negative Stock`,
`Bills Receivable`, `Bills Payable` and `Cost Category Summary` returned the
identical 21-byte empty envelope on all three — twelve combinations, no rows.
`Negative Ledgers` by contrast returns real content on all three (4 rows on AgEx,
67 on MUDALS, 34 on AGBV), which is what makes the empty results credible as
"nothing to show" rather than "route broken".

**A limitation this register itself had.** Everything above was first written from
one company. Three companies then refuted two of its entries within minutes, and
exposed a bug introduced the same day — a global currency label that would have
labelled rupees EUR. Treat any row measured against a single company as provisional.

**Still blocked, and honestly so.** Prior-year vouchers (the collection returns
only the current FY); cost-centre allocations (`Cost Centre Break-up` is rejected
as a report, and the dotted collection TYPE is unsafe to send); Edit Log (settled
2026-08-18 — no report ID exists and `EnteredBy`/`AlteredBy` are served but empty; the
partial substitute is `UpdatedDateTime`, now read by `tally_test_vouchers` test
`late_entry`); Budgets.
The untried candidate for prior-year vouchers is a custom-TDL **report** — which
is a report, so the collection-TYPE hazard does not apply — and it needs live
verification.

**The coverage percentage is still not stated,** for the reason given above: rows
remain `unknown`, and resolving them needs companies that use the relevant
features (see Part 7 of the plan). A number published over unknowns would be the
exact failure this register exists to prevent.

---

## Blocking prerequisite — RESOLVED

**The health probe reported false green.** With TallyPrime parked behind its
"incorrect object type" dialog, `tally_connection_status` returned
`connected: true, responseTimeMs: 0` while a real request timed out at 30 s.

Every probe script's safety guard depends on that probe to decide whether to keep
sending. It cannot be trusted to fire. **Fix this before any further live
probing**, or the `unknown` rows above stay unknown — they are not safely
resolvable until the guard works.

**Fixed.** `tally_connection_status` now sends with the cache bypassed, so a green
means TallyPrime answered just now rather than five minutes ago. The probe scripts'
safety guard can be relied on again.
