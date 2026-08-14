# Live probe findings — 14 Aug 2026

Measured against a live TallyPrime on `127.0.0.1:9000`, company
**MUDALS TECHNOLOGIES PRIVATE LIMITED** (India, books 2021-04-01 → 2026-07-28,
330 ledgers, no inventory, GST in use, bill-wise tracking off).

Every finding below is a measurement, not an inference. Where something was not
measured it says so. Nothing here was concluded from documentation alone —
two documented claims were tested and **both turned out wrong**.

> Companion to [known-limitations.md](known-limitations.md). Scripts:
> `probe-date-format.ts`, `probe-nonbinding-span.ts`, `probe-accumulation-end.ts`,
> `probe-audit-fields.ts`, `probe-voucher-reach.ts`, `probe-nested-fetch.ts`,
> `probe-master-types.ts`, plus the extended `probe-reports.ts`.

---

## 1. SAFETY: an invalid collection TYPE parks Tally behind a modal dialog

**The most important finding here.** It cost two TallyPrime restarts during this
session, and it revises the safety model this project has been working from.

Sending a `<COLLECTION>` whose `<TYPE>` Tally does not recognise makes TallyPrime
raise a **modal error dialog reading "incorrect object type"**. While that dialog
is open, the HTTP interface accepts connections but serves nothing. Confirmed by
the operator reading the dialog off the screen.

Two request shapes did this:

| Shape sent | Outcome |
|---|---|
| `<TYPE>Voucher.AllLedgerEntries</TYPE>` (a dotted sub-collection name) | dialog; Tally restarted |
| `<TYPE>NoSuchTypeXyz</TYPE>` (a deliberately invalid name) | dialog; Tally restarted |

What this changes:

- **It is not a crash and not an infinite loop.** Nothing is corrupted and no
  books are altered — every request sent was `Export`. Dismissing the dialog
  restores service; a restart is not actually required.
- **But it is worse than a crash for unattended use.** One bad request blocks
  *every* subsequent request until a human is physically at the machine to click
  OK. On an accountant's desktop mid-audit that is a stall with no explanation
  visible from our side.
- **The `known-limitations.md` claim that "a bare COLLECTION name with no
  definition" is the dangerous form is too narrow.** A collection *with* a
  complete inline definition is equally dangerous if the TYPE is unrecognised.
  The dangerous ingredient is the TYPE, not the missing definition.
- **Report IDs remain the safe class.** An unknown `TYPE=Data` `<ID>` returns
  `<LINEERROR>` harmlessly — re-confirmed across 25 candidates this session with
  controls at both ends. The asymmetry between reports and collections is real
  and must not be reasoned across again.

**Rule going forward: never send a collection TYPE that has not already been
observed working.** Not "probe it carefully" — do not send it. The allowlist
discipline was right, and this is the concrete reason why.

### A corollary bug: `tally_connection_status` can report a false green

While Tally was behind the dialog, the health probe returned
`connected: true, responseTimeMs: 0` while a real `tally_list_companies` timed
out at 30 s. Every probe script in this repository — including the ones written
today — uses that probe to decide whether it is safe to continue. It is too
cheap to be a liveness test, so an abort-on-unhealthy guard cannot be trusted to
fire. Worth fixing before any further probing is ever done.

---

## 2. SEVERE: voucher history is unreachable — five financial years of it

The `AllVouchers` collection returns **only the current financial year**,
whatever date range is requested.

| Requested | Returned |
|---|---|
| 2021-04-01 → 2026-07-28 (whole book) | 2026-04 → 2026-07, 284 vouchers |
| 2023-04-01 → 2024-03-31 (past year) | `dates=20260401 .. 20260728`, 285 vouchers |
| 2024-04-01 → 2024-04-30 | 0 vouchers |

The data demonstrably exists: `Profit and Loss` for FY 2023-24 returns real
Indirect Expenses of 633,669.2. So this is truncation, not an empty book.

**Why it is severe rather than merely limiting:** the response is reported as
`hasMore: false`, `truncated: false`, and — on `tally_summarise_movements` —
`allGroupsNetToZero: true`. Every completeness signal the server has says the
answer is whole. A question about FY 2023-24 returns four months of FY 2026-27
and nothing anywhere says so.

Affected: `tally_get_vouchers`, `tally_summarise_movements`, `tally_check_tie_out`,
`tally_get_gst` (transactions view), `tally_get_bank_reconciliation`,
`tally_get_inventory_movements`, `tally_get_outstanding` (bill allocations),
`tally_get_ledger_transactions`, `tally_get_party_statement` — and every planned
tool that draws a voucher population (#4, #5, #6, #7, #10).

**Routes tested and ruled out:**

| Route | Result |
|---|---|
| `SVFROMDATE`/`SVTODATE` on the collection | ignored (already documented) |
| `<FILTER>` + `<SYSTEM TYPE="Formulae">` on `$Date` | returned 1,511 B / 1 record for both a current and a past year — did not work as written, and a filter narrows rather than widens, so it cannot escape the scope anyway |
| `Day Book` report with a date range | **ignores the range entirely** — byte-identical 147,942 B responses for FY 2023-24 and FY 2026-27, every `DATE` tag being 2026-07-28 |
| `Ledger Vouchers` report | empty envelope (needs a ledger parameter) |

**Not yet tested:** the custom-TDL-report route (`TYPE=Data` with an inline
`REPORT`/`FORM`/`PART`/`LINE`/`FIELD` definition over a Voucher collection), which
is what `tally-database-loader` actually uses for multi-year extraction. That
remains the most promising candidate and is **not** blocked by finding 1, because
it is a report rather than a collection. It was not attempted today.

---

## 3. SEVERE: statements accumulate to a fixed date, mislabelled as the period asked for

When a statement's end date does not bind, figures accumulate to **the end of the
financial year containing the company's `EndingAt`** — here 2027-03-31. This is a
*fixed* endpoint, independent of where the period starts.

Verified across six start dates, end date held non-binding (a 30th):

| fromDate | rows | implied end |
|---|---|---|
| 2021-04-01 | 72 | 2027-03 |
| 2022-04-01 | 60 | 2027-03 |
| 2023-04-01 | 48 | 2027-03 |
| 2024-04-01 | 36 | 2027-03 |
| 2025-04-01 | 24 | 2027-03 |
| 2026-04-01 | 12 | 2027-03 |

Binding controls returned exactly what was asked: 2024-04-01→2024-07-31 gave 4
rows; 2023-04-01→2023-12-31 gave 9 rows.

**Two bugs follow.**

**(a) The shipped caveat states the wrong rule.** It says figures "accumulate from
fromDate to the end of the company's financial year". The real endpoint is the
end of the *last* financial year of the books — 2027-03-31, which is eight months
past the books' own end date and, for an FY 2023-24 request, **four years** of
accumulation presented as one.

**(b) The reported span is arithmetically impossible.** Asked for FY 2023-24, the
live response carried:

```
"period":            { "fromDate": "2023-04-01", "toDate": "2024-03-31" },
"coversPeriodRequested": false,
"figuresActuallyCover":  { "fromDate": "2023-04-01", "toDate": "2022-03-31" }
```

An end date **before** the start date, in a user-facing warning. CHANGELOG 0.4.0
claims this class of bug fixed ("a warning claiming the figures covered a period
ending before it started"); it is live in the built `dist/`. The value 2022-03-31
is the end of the FY containing the *books' start date*, so the calculation is
anchored to the wrong date entirely.

---

## 4. REFUTED: the date wire format is not the cause of the "31st" rule

Hypothesis: the 31st-only end-date binding was a parsing artefact of sending
`YYYYMMDD`, and `d-MMM-yyyy` (what `tally-database-loader` sends) would fix it.

**Wrong.** Four encodings, same dates, byte-identical behaviour for three:

| Encoding | 2024-06-30 | 2024-07-31 | 2024-09-30 | 2024-12-31 |
|---|---|---|---|---|
| `20240630` (current) | 36 | 4 | 36 | 9 |
| `30-Jun-2024` | 36 | 4 | 36 | 9 |
| `TYPE="Date"` attribute | 36 | 4 | 36 | 9 |
| `2024-06-30` (ISO) | 12 | 12 | 12 | 12 |

The 31st rule is real and format-independent. The existing guard is correct and
`tally_get_trend` (#8) does need its per-period caveat machinery after all.

**One new warning:** ISO `YYYY-MM-DD` is silently mis-parsed — it returns a
constant 12 rows regardless of the end date, i.e. Tally falls back to a single
financial year. Never send ISO on the wire. The current `YYYYMMDD` is fine.

---

## 5. Edit Log / audit trail: not reachable, and a near-miss worth recording

**No report path exists.** `Edit Log`, `Edit Log Summary`, `Audit Trail` and
`Alteration Report` were all rejected with `<LINEERROR>`, against working
controls. Likewise every licence-detection candidate (`License Info`,
`Licensing Info`, `License`, `Company Info`, `About`, `Version`) — so the
Educational-version check remains impossible, as already documented.

**The near-miss.** `List of Accounts` returns 7.5 MB and its payload mentions
`createdby`, `enteredby`, `username` and `altered` — apparently the audit trail.
Counting populated values per tag shows otherwise:

| Tag | populated / total |
|---|---|
| `ACCOUNTAUDITENTRIES.LIST` | 0 / 330 |
| `AUDITDETAILS.LIST` | 0 / 365 |
| `AUDITENTRIES.LIST` | 0 / 330 |
| `LEDGERAUDITCLASS.LIST` | 0 / 330 |
| `OLDAUDITENTRIES.LIST` | 0 / 330 |

Every audit container is **empty scaffolding** — Tally's documented habit of
emitting the full field superset. Reporting this as an edit-log capability would
have repeated the exact failure that produced the 0.2.0 corrections: a
confident, well-formed, empty structure.

**Genuinely populated and useful**, on masters only:

| Tag | populated / total | Use |
|---|---|---|
| `ALTERID` | 367 / 367 | Confirms incremental-sync cache validation is viable |
| `GUID` | 367 / 367 | Stable key |
| `UPDATEDDATETIME` | 367 / 367 | When a *master* was last altered |
| `ISSECURITYONWHENENTERED` | 367 / 367 | Partial CARO Rule 11(g) evidence |
| `AUDITED` | 330 / 330 | Tally's own audited flag |
| `ISRELATEDPARTY` | 330 / 330 | **See finding 7** |

None of these is voucher-level, so none substitutes for the edit log that CARO
Rule 11(g) requires. **Untested:** whether a Voucher collection carries the same
fields populated — blocked today because the voucher collection only reaches the
current year (finding 2) and because collection probing was stopped (finding 1).

---

## 6. Report IDs: six new working views, three firm rejections

Controls behaved (`Statistics` → data, `Outstandings` → rejected), so these
verdicts are trustworthy.

**Working, and new to this server:**

| Report ID | Bytes | Note |
|---|---|---|
| `Negative Ledgers` | 20,909 | Real content. Audit-grade exception report — negative cash is a classic red flag |
| `Ratio Analysis` | 1,676 | Partly serves tool #8 |
| `Sales Register` | 2,817 | |
| `Purchase Register` | 2,751 | |
| `Journal Register` | 2,098 | The highest-risk population for tool #4 |
| `List of Accounts` | 7,538,301 | Chart of accounts; see finding 5 |

**Rejected — do not plan against these:** `Cost Centre Break-up` (so cost centres
have no report route), `Budget Variance`, `Budgets` (so tool #2 has no report
route), and all Edit Log / licence names.

**Valid but empty on this company** — all four returned the identical 23-byte
empty envelope, which is the "valid report, nothing to show" reply, *not* a
rejection: `Negative Stock`, `Bills Receivable`, `Bills Payable`,
`Cost Category Summary`. Consistent with a company that has no inventory and no
bill-wise tracking. Their response *shape* is therefore still unverified and
needs a company that uses those features.

---

## 7. CORRECTED: Tally does have a related-party flag

Earlier research for the plan concluded "Tally has no structured related-party
flag; it must come from a caller-supplied list". **That is wrong.**
`ISRELATEDPARTY` is a real ledger master field, returned populated on 330 of 330
ledgers (all `No` on this company, but present and readable).

Tool #7 should therefore **seed** from Tally's own flag and accept the caller's
list to extend it — not ignore Tally and rely on the list alone. The
caller-supplied list stays required, because a company that has never set the
flag would otherwise silently produce an empty disclosure.

---

## 8. Cost centres: the hierarchy is deeper than the plan assumed

The nested-fetch mechanism **works and is safe** — `<TYPE>Voucher</TYPE>` (plain,
never dotted) with nested paths in `<FETCH>`. This is the safe alternative to the
dotted TYPE that hung Tally.

Measured, all with Tally healthy before and after:

| Fetch list | `CATEGORYALLOCATIONS` | `COSTCENTREALLOCATIONS` |
|---|---|---|
| shipped list (control) | 0 | 0 |
| `+ AllLedgerEntries.CostCentreAllocations` | **985** | 0 |
| `+ AllLedgerEntries.CategoryAllocations.CostCentreAllocations` | 985 | 0 |

Asking for cost-centre allocations makes Tally emit `CATEGORYALLOCATIONS` — its
**parent** level. So the real hierarchy is
`AllLedgerEntries → CategoryAllocations → CostCentreAllocations`, one level
deeper than the plan assumed, and the plan's fetch path was wrong.

`COSTCENTREALLOCATIONS` stayed 0 throughout. Most likely this company has cost
centres *enabled* on 37 ledgers but never *allocated* on transactions — the
distinction `tally_get_company` already warns about. **Unconfirmed:** the
decisive test was a `CostCentre` master collection, which was not sent after
collection probing was stopped.

**Also learned:** `BILLALLOCATIONS` and `BANKALLOCATIONS` arrive at 985 each from
the *shipped* fetch list already — no nested path needed. Only cost centres
required one.

---

## 9. Smaller items

- **`EndingAt` is fetched but never surfaced.** `buildCompanyListRequest` requests
  it and Tally returns `20260728`, but no tool exposes it. It is needed for the
  correct fiscal-year default (the A1 fix) and to state finding 3's real endpoint.
- **`distinctValues` is silently capped at 25** ([companies.ts:188](../src/tools/companies.ts#L188)).
  `GUID` reports `distinctValues: 25` when the true count is 330. The cap is a
  sound optimisation but reporting the capped number as a bare figure is an
  inaccurate value; it needs a `25+` or a `capped` flag.
- **This company's payload needs heavy sanitising**: 3,077–3,930 illegal
  control-character references removed per request. The sanitiser is working, but
  the volume is far above what earlier companies showed.
- **`TALLY_PREFERRED_FORMAT=json` is confirmed a no-op here.** Requests go out
  with `$$SysName:JSON` and responses come back XML, as documented.

---

## What Phase 0 changes in the plan

1. **Two new severe bugs** ahead of everything else: finding 2 (voucher history)
   and finding 3 (accumulation span and the impossible date arithmetic).
2. **B1 is dead** — the date-format theory is refuted; #8 keeps its caveat machinery.
3. **B2 is dead as written** — `<FILTER>` did not work and cannot widen scope anyway.
4. **The dotted sub-collection route is forbidden.** Replaced by the nested fetch
   path, which is verified safe — with a corrected, one-level-deeper cost-centre path.
5. **Tool #2 (budgets) has no verified route at all.** Report IDs rejected;
   collection type unprobed and now unprobeable under the new safety rule.
6. **Tool #7 improves** — seed from `ISRELATEDPARTY`.
7. **Six report views are ready to consolidate** into the single allowlisted
   `tally_get_report`, including the audit-grade `Negative Ledgers`.
8. **A new prerequisite**: fix the false-green health probe before any further
   live probing, because every probe script's safety guard depends on it.

---

## 10. CORRECTED: `SVCURRENTCOMPANY` matching is tolerant, and a miss returns EMPTY

Measured with **three companies loaded at once** — `AGBV Nutrition GmbH -
(from 1-Jan-24)` (Germany, `?`, books 2023-01-01 → 2026-07-31), `AgEx Pharma LLC
(25-26)` (USA, `$`, 2025-04-01 → 2026-03-31) and `MUDALS TECHNOLOGIES PRIVATE
LIMITED` (India, `?`, 2021-04-01 → 2026-07-28).

**This refutes both halves of the A2 diagnosis** in the plan, which asserted that
Tally "matches exactly, case-sensitively, and on a mismatch answers from the loaded
company with no error".

Trial Balance, same period, varying only the company name:

| `SVCURRENTCOMPANY` sent | Rows |
|---|---|
| `AgEx Pharma LLC (25-26)` | 9 |
| `agex pharma llc (25-26)` | 9 |
| `AGEX PHARMA LLC (25-26)` | 9 |
| `AgEx Pharma LLC (25-26)` + trailing space | 9 |
| `AgEx Pharma LLC (25-26)` + trailing newline | 9 |
| ` AgEx Pharma LLC (25-26)` (leading space) | 9 |
| `AgEx Pharma LLC` (truncated but real prefix) | **0** |
| `No Such Company Xyz` | **0** |

So matching is **case-insensitive** and **whitespace-tolerant**, and an unmatched
name yields an **empty report** — never another company's figures.

**What this changes.** The canonicalisation fix stays, because it is still right for
two smaller reasons: the envelope's `company_id` carries Tally's own spelling, and
`assertCompanyIsLoaded` rejects an unknown name *before* the request. That second
one is now the real hazard: an unmatched name returns empty, and empty reads as
"this company has nothing to report" — the same empty-versus-missing confusion as
finding 2. The wrong-attribution hazard does not exist on this build.

**The user-facing claim has been withdrawn** from CHANGELOG 0.4.0 rather than
quietly softened. It told readers to re-run figures for a bug that was not there.

### Company switching itself works

The three companies return genuinely different trial balances — `AGBV` has no
`Loans (Liability)` row, `MUDALS` carries `Fixed Assets`, byte counts differ — so
sequential per-company fetches are viable, which is what tool #9 needs.

---

## 11. A bug this project introduced, found within minutes by real data

`TALLY_CURRENCY_LABEL` shipped earlier the same day as a single global label, to be
used where Tally could not transport its currency symbol.

**Both the German and the Indian company report their symbol as `?`** — `€` and `₹`
are equally absent from Tally's export codepage. A global `EUR` would therefore have
labelled rupee balances EUR: figures right, label a confident lie, which is the
exact bug class the setting was introduced to remove.

Fixed the same session. The setting now takes `Company Name=EUR;Other=INR`, and a
bare label is **refused whenever more than one company is loaded**, with the
response saying why rather than silently reading "unknown".

The lesson worth keeping: this was invisible against a single-company install and
obvious against three. Multi-company is not only a feature to test — it is a
different correctness regime.

---

## 12. Four report IDs remain shape-unverified, across all three companies

Re-probed `Negative Stock`, `Bills Receivable`, `Bills Payable` and
`Cost Category Summary` against all three companies. **All twelve combinations
returned the same 21-byte empty envelope.**

Notably `Cost Category Summary` is empty on `AgEx Pharma LLC`, which has cost
centres enabled on 25 of its 54 ledgers — so cost centres being switched on is not
sufficient to populate it. Either no cost *categories* are defined (categories and
centres are separate in Tally), or the report needs something else again.

`Negative Ledgers` by contrast returns real content on all three: 4 rows on AgEx,
67 on MUDALS, 34 on AGBV.

These four rows in the coverage register therefore stay unverified. Three companies
was not enough.
