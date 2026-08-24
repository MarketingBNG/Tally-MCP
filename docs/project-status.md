# Project status

Where the project actually stands, measured against `PROJECT_SPEC.md` rather
than against how finished it feels. Companion to
[known-limitations.md](known-limitations.md), which covers *why* things behave
as they do, and [performance.md](performance.md), which covers what each tool
costs in tokens and time; this file covers *how much* is done.

**Last updated:** 2026-08-19 (the scheduled spreadsheet export — see
[The spreadsheet export](#the-spreadsheet-export-2026-08-19)). The readings below
come from 2026-08-18, verified against four companies loaded together in one
live TallyPrime — an Indian private limited (472 ledgers), a German GmbH on
calendar-year books, and two US LLCs. Earlier readings came from the first two of
those.

---

## Summary

| Measure | Status |
|---|---|
| **Built** | ~95% |
| **Verified against real data** | ~90% |
| Tools | 23 registered — the newest is `tally_get_report` (see [Inventory reports unblocked](#inventory-reports-unblocked-2026-08-14)). `tally_test_vouchers` carries 8 procedures, the newest being `late_entry` (see [Entry timing](#entry-timing-2026-08-18)) |
| Prompts / resources | 4 / 2 |
| Tests | 1,046 passing, 2 skipped, across 63 files. One skip is the fixture-vs-`samples/` guard, which runs only where `samples/` exists — i.e. precisely on a machine that has pulled real exports |
| `typecheck` / `lint` / `test` / `build` | Enforced by CI on every push (Windows + Linux) |
| Definition of done | **8 of 8** |

Construction is finished. The gap between "built" and "verified" is the honest
part: two tool families are complete and tested against fixtures but have never
met the data they are for — see
[Unproven](#unproven-built-but-not-observed). Closing that gap needs a
different company's data, not more code.

---

## Tools

### v1 — 13 of 14

`tally_connection_status`, `tally_list_companies`, `tally_get_company`,
`tally_get_ledgers`, `tally_get_ledgers`, `tally_get_ledger`,
`tally_get_ledger_transactions`, `tally_get_vouchers`, `tally_get_vouchers`,
`tally_get_vouchers`, `tally_get_statement (statement: 'trial_balance')`, `tally_get_statement (statement: 'balance_sheet')`,
`tally_get_statement (statement: 'profit_loss')`

**Not built: `tally_get_day_book`** — deliberately. On a real install the
`DayBook` report ignores the date range it is given and reports Tally's own
current period: 3 vouchers for a five-year range where the `Voucher Register`
report returned 30 for one month inside it. A date filter that is silently ignored
is worse than one that fails, so the report is not exposed.

The register is not exposed either, for a worse reason found on 2026-08-13: it
returns voucher *headers* with no ledger entries at all. `tally_get_vouchers` reads
a `Voucher` collection, which is the only shape that returns the debit and credit
lines, and applies the date range itself. See
[known-limitations.md](known-limitations.md#the-voucher-register-report-returns-no-ledger-entries-at-all).

### v2 — 16 of 16

`tally_get_company (includeFeatures: true)`, `tally_get_vouchers (family: 'sales')`,
`tally_get_vouchers (family: 'purchases')`, `tally_get_stock_items`,
`tally_get_inventory_movements`, `tally_get_outstanding (side: 'receivable')`,
`tally_get_outstanding (side: 'payable')`, `tally_get_gst (view: 'summary')`, `tally_get_gst (view: 'transactions')`,
`tally_search`, plus `tally_get_statement (statement: 'cash_flow')` and `tally_get_statement (statement: 'fund_flow')`.

Added after the v2 milestone: `tally_get_groups`, `tally_get_groups`,
`tally_get_party_statement`, and `tally_get_ledgers / tally_get_groups / tally_get_stock_items (conditions)` — bringing the total
to 33.

### Added 2026-08-12 — four gaps closed without a probe trip

Chosen because each is buildable from a **verified** retrieval path, so none
required guessing a report ID. See [known-limitations.md](known-limitations.md)
for the reasoning behind each design.

| What | Built on | Note |
|---|---|---|
| `tally_get_voucher_types` | The `VoucherTypes` collection the server already read internally for family resolution | Nothing exposed the list, so a caller could filter on `voucherType` with no way to discover valid values. `numberingSeries` (from the nested `VOUCHERNUMBERSERIES.LIST`, not the misleading top-level scalar — see known-limitations.md) and `isDeemedPositive` added to the normaliser |
| `tally_get_bank_reconciliation` | `BANKALLOCATIONS.LIST` on voucher entries | Not Tally's own Bank Reconciliation report — that export ID is unverified. Status can be reported as unknown; a status filter fails rather than guessing |
| Period comparison on `tally_get_statement` | Two fetches of an existing verified report | Pairs rows by name only when unambiguous; computes no change against a null |
| Opt-in ageing on `tally_get_outstanding` | Bill allocations already collected for the bills field | Ageing by bill AGE, never overdue. Off by default, so the previous contract is unchanged |

Total at that point: **18 registered tools** (the count after the v1/v2
consolidation into merged tools, not the 33 pre-merge tool *modes*). Now **19**,
with `tally_summarise_movements` added on 2026-08-13.

### Live verification of the four, 2026-08-12

Run against a live TallyPrime on 127.0.0.1:9000 holding **the second live
company (a US LLC, FY 25-26)** — a different company from the one used for the v1/v2 verification, and
notably one whose financial year has already passed, so every call had to name
its period. 453 vouchers, 26 voucher types, one bank ledger.

Method, because a live run against someone's open books is not a normal test:
`dist/` was exercised rather than `src/`, since that is what Claude Desktop
launches; every call was awaited in sequence, because Tally's listener serves one
request at a time; the run aborts on the first connection-class failure, since one
malformed request poisons a session; and **no report or collection ID was sent
that was not already verified** — all four features reuse existing builders, which
is what made the run no riskier than any existing tool. 30 tool calls, no abort,
Tally still serving afterwards.

Two passes were needed. The first raised `TALLY_MAX_RESPONSE_BYTES` and
`TALLY_MAX_RECORDS` to see whole answers — which means it could not have caught a
tool that only works with the ceilings raised. Everything was re-run at the
shipped defaults of that date (900,000 bytes / 5,000 records) and passed there
too. The response-byte default was lowered again on 2026-08-13 — see
[performance.md](performance.md) — so "shipped defaults" today means 150,000
bytes; `npm run check:live` re-runs the equivalent check against whatever is
current.

| Check | Result |
|---|---|
| Voucher types | 26 types. **"Export Invoice" and "GWI Invoices" both derive from `Sales`** and contain no "sales" in the name — the exact case the tool exists for, found in the wild |
| Comparison, identical periods on both sides | 9 rows paired, **every change exactly `0`**, nothing mispaired. Note this check is weaker than it looks — it passes trivially if the end date is ignored, which is exactly what turned out to be happening |
| Mid-year statement | Correctly flagged `coversPeriodRequested: false` with `figuresActuallyCover` and a warning |
| Mid-year comparison | Correctly refused with `TALLY_UNSUPPORTED_OPERATION` |
| Comparison vs two independent fetches | `rows` byte-identical to the period fetched alone, `comparison.rows` likewise; all 7 subtractions re-derived; 7 nulls correctly left uncomputed |
| Bank reconciliation | 200+ instruments across cheque, cheque/DD, inter-bank transfer and "others"; signs correct (payment positive, receipt negative) |
| Bank vs the verified voucher tool | Same amount, sign, and reference for the same voucher, via an independent path |
| Ageing | **Produced nothing — see below.** Not a defect |
| Guard rails | Half a comparison range, descending buckets, and a status filter with no evidence all refused with the right codes |
| Defaulted period against a company whose year has passed | Correctly returned zero rows *with* the warning naming the company and its year |
| Family-resolution regression | `buildVoucherTypeListRequest` changed today; family resolution still resolves `["export invoice", "gwi invoices", "sales"]`, and the new tool agrees with it |

**A third defect, found by adversarially reviewing the live run rather than by the
run itself, and it is the serious one.** TallyPrime **ignores the requested end
date** on `Trial Balance`, `Profit and Loss` and `Cash Flow`, accumulating from
`fromDate` to the financial year end instead — a three-month cash flow request
returned nine months, and a first-quarter trial balance returned the whole year.
That makes any mid-year statement a cumulative position rather than the period
asked for, and it made period comparison capable of reporting a fabricated
movement the exact size of the earlier period: a Q2-vs-Q1 comparison would have
shown sales down 211,852.50 when they were flat. Comparison now refuses unless the
period ends at the year end, and every statement response carries
`coversPeriodRequested`. Full account, including why the original trial balance
reconciliation could not have caught it, in
[known-limitations.md](known-limitations.md#the-statements-ignore-the-requested-end-date-and-accumulate-to-the-year-end).

This one also revises an earlier claim on this page: **definition-of-done item 3
verified less than it appeared to.** It reconciled a period ending 28-Jul-26 on a
company with no transactions after that date, so "accumulated to the year end" and
"as at the end date" were the same figures. The reconciliation is still correct
about signs, decimals, empty-vs-zero and the positional pairing — it simply could
not have detected the end-date behaviour.

**Two further defects were found and fixed, both invisible to fixtures:**

1. **The numbering-method scalar was reporting the opposite of the truth.**
   TallyPrime's top-level `NUMBERINGMETHOD` on a voucher type is a legacy field
   reading `None` on all 26 types, while the real method lives in the nested
   `VOUCHERNUMBERSERIES.LIST` — where 25 of 26 were `Automatic / Auto Retain`.
   Now reported as `numberingSeries[]`, and the fixture keeps the misleading
   `None` so a regression fails a test. The corrected field immediately surfaced
   something worth an auditor's attention: **one sales type, `GWI Invoices`, is
   `Automatic (Manual Override)` and is the only one of the 26 that prevents
   duplicate numbers.**
2. **24% of the bank payload was scaffolding.** Eleven cash-denomination counters
   per instrument — 2,200 across 200 cheques and wires, every one zero, including
   the counter for the demonetised ₹2,000 note. Zero-valued ones are now dropped
   and a non-zero one is always kept; the full-year response fell 244 KB → 185 KB.

### Still unproven after the live run

Stated separately because a passing run is easy to over-read.

| Path | Why unproven | Consequence |
|---|---|---|
| `reconciled: true` | **No populated `BANKERSDATE` exists on either available company.** 406 such elements in the raw response, all empty — verified by counting tags in the 22 MB payload. So the field is genuinely in Tally's schema and this company has simply never reconciled | The honest path (status `null`, filters refused) is live-confirmed. The path that reports a cheque as *cleared* has never run on real data |
| Ageing on real bills | This company records **no bill references at all** — 919 `BILLALLOCATIONS.LIST` blocks, zero with a populated `NAME`, no `BILLTYPE` anywhere. Bill-wise accounting is off | The netting, the sign rule and the buckets are fixture-tested only. The empty schedule the live run produced is the company, not the code |
| Cost centres | Zero `CATEGORYALLOCATIONS.LIST` in the whole year | The "richer company" that [next-steps.md](next-steps.md) waits on is **still not available** — this one has no cost centres and no bill-wise either |
| ~~`balance_sheet` and `fund_flow`~~ | **Closed 2026-08-13** — both called live for the first time, full-year and first-quarter each | Both ignore the end date: mid-year rows identical to full-year rows. The guard was exactly right, including for the balance sheet |
| Period comparison producing a *useful* answer | Only the year-end-anchored shape is permitted, and no accountant has yet been asked whether "two cumulative positions" answers the question they meant | The feature is safe but may be answering a narrower question than "this quarter vs last" |

One real bug was found and fixed during this work, recorded because it would have
been invisible in review: the first ageing implementation classified a negative
net as a settlement against an earlier bill. Since Tally encodes debits negative,
that would have reported **every open receivable** as a settlement. Direction is
now taken from the raising allocation's own sign, with a regression test.

`tally_get_statement (statement: 'cash_flow')` and `tally_get_statement (statement: 'fund_flow')` returned
`TALLY_UNSUPPORTED_OPERATION` until 2026-08-12; they now return Tally's own
month-by-month movement (debit, credit, net per month), verified against a
live install. They remain deliberately unclassified — the
operating/investing/financing split is a judgement about the business, and
the tool descriptions say to present the data as monthly movement, never as a
classified statement. See docs/known-limitations.md.

### Performance pass, 2026-08-13

Prompted by a user report that auditing one company used over 20% of a session
and took too long. Measured, fixed, and re-verified live in two rounds; full
detail in [performance.md](performance.md).

**Round 1:** uniform-field folding on vouchers and bank instruments (25
full-detail vouchers 54,255 → 19,577 tokens); response ceiling 900,000 → 150,000
bytes; parsed-record caching (not just the raw HTTP response); cache TTL 20,000ms
→ 300,000ms (a 9-question audit's waiting time 64s → 12s); validation moved
before fetching (a rejected call 1,180ms → 1ms); `data_fetched_at` added to the
envelope, distinct from `as_of_timestamp`, so a cached figure is never mis-dated
now that the TTL is long enough to matter.

**Round 2**, same day: audited every remaining tool for the identical fold rather
than assuming more existed. `tally_get_ledger_transactions`, `tally_search`,
`tally_get_party_statement` and `tally_get_gst` were already lean and needed
nothing. `tally_get_ledgers` and `tally_get_stock_items` under `includeAllFields`
were not, and turned out to be the largest win found: **54 full-detail ledgers
fell from ~37,700 to ~4,600 tokens, 8.2x smaller** — bigger than the voucher
saving, because a ledger's field-to-substance ratio is worse than a voucher's.
Re-verified against live Tally after both rounds; `npm run check:live` still
passes (17 calls, 14/14 assertions).

### Correctness pass, 2026-08-13 — nine wrong-figure bugs

Prompted by a user asking how accurate the data actually was. Answered by
comparing tool output against live TallyPrime rather than against fixtures, which
is the only way any of this could have been found: **every one of these bugs was
green across the whole test suite.** Full detail and evidence in
[known-limitations.md](known-limitations.md).

The root cause, and the reason the rest were invisible:

**Voucher ledger entries were never retrieved at all.** The `Voucher Register`
report returns voucher headers only — 28KB of empty scaffolding per voucher across
246 tags, and zero `ALLLEDGERENTRIES.LIST`. Every voucher parsed with
`entries: []`, so every figure derived from movements was empty or wrong.
`tally_check_tie_out` reported **34 balance exceptions and 0 vouchers checked** on
books that balance to the paisa. Fixed by reading a `Voucher` collection with the
entry lists named explicitly in `FETCH` — `<FETCH>*</FETCH>` is a trap that
returns everything except the entries.

Because those code paths had never executed against real data, they hid more:

| Bug | Effect |
|---|---|
| Party entry counted twice on invoices (`ALLLEDGERENTRIES` and `LEDGERENTRIES` are alternatives, not halves) | 29 of 453 real vouchers failed double entry |
| Every amount labelled `INR` regardless of company | A US company's dollar balances reported as rupees |
| `??` on a legitimately-null running balance | Closing balance silently reported as the **opening** balance |
| Unreadable amounts skipped in party-statement totals | Totals understated, and irreconcilable against `movementCount` |
| Number parser salvaged a figure from anything | `"1000.00 Kgs."` → `100000`, **100× too large**, no warning |
| Amount filter scored unreadable vouchers as 0 | `minAmount` silently dropped them from an audit population |
| Numeric character references never decoded | Narrations showed `&#13;&#10;`; narration search could not match across a line break |
| `matchedLedgerNames` compared case-sensitively | A party countable in its statement *and* as an "other mention" |
| Company GST registration read from `vouchers[0]` only | Reported as absent while every other voucher carried it |

Two things were deliberately **not** treated as bugs after checking live data:
`Stock In Hand` and `Profit & Loss A/c` cannot satisfy a balance roll-forward
because Tally derives those balances rather than posting to them, so they are now
reported as `notCheckable` rather than as exceptions; and the empty
`BILLALLOCATIONS.LIST` structures are genuinely empty on this company (bill-wise
tracking is off on all 54 ledgers), not a retrieval failure.

Verified after the pass: 516 tests pass including 6 new regression tests, `npm run
check:live` passes 17 calls / 14-of-14 assertions, tie-out passes (452 vouchers, 41
accounts, 0 exceptions), and the computed closing balance for the bank ledger now
matches Tally's own reported figure exactly (`-72,707.96`) across 406 movements.

One cost was accepted: the collection ignores `SVFROMDATE`/`SVTODATE`, so the whole
book is fetched and dates are applied locally. The fetch is nonetheless faster than
the register it replaced (8.6MB/2.0s against 21MB/7.8s), but a narrow date range no
longer reduces TallyPrime's work — [performance.md](performance.md) is corrected
accordingly.

### Cross-path reconciliation pass, 2026-08-13 — every tool against every other tool

Prompted by asking how to make accuracy provable rather than asserted. The
existing checks each compared one tool against Tally; this pass compared the
tools against **each other**, on live books, so that a figure had to survive two
or three independent request-and-parse paths to count as verified. All 19 tools
were exercised (the standing `check:live` covers 6), including the first-ever
live calls to `balance_sheet` and `fund_flow`.

15 reconciliations, all passing after the fix below:

- Trial balance nets to zero; tie-out clean (452 vouchers, 41 accounts, 0
  exceptions); every returned voucher's entries sum to zero.
- `tally_summarise_movements` nets to zero on all five dimensions.
- **Closing = opening + movements independently re-derived for all 38 checkable
  ledgers** — masters path vs voucher-entry path, zero mismatches.
- `tally_get_ledger_transactions` computed closing = Tally's reported closing =
  ledger master (`City Bank`, −72,707.96, 406 movements), and the same
  three-way agreement on `tally_get_party_statement` (494,397.50).
- Every `Money` in every response carries the company's own currency.

**One real defect found, fixed the same day:** TallyPrime's own Trial Balance
carries `Stock In Hand` at its **opening** value while the Balance Sheet and the
ledger masters carry **closing** — Current Assets differed by 96,620.00 (20%)
between two tools, each faithfully reporting Tally's own figure.
`tally_get_statement (trial_balance)` now cross-checks each group row against
the ledger masters and warns with both figures, the difference, and the account
whose movement explains it. 4 regression tests, confirmed to fail without the
fix. Full account in
[known-limitations.md](known-limitations.md#the-trial-balance-carries-stock-at-its-opening-value-the-balance-sheet-and-ledger-masters-carry-closing).

Also established: `balance_sheet` and `fund_flow` ignore the end date exactly
as the other three statements do (mid-year rows identical to full-year), so the
guard that assumed as much is now verified rather than conservative.

### Efficiency pass, 2026-08-13

Prompted by asking how to spend fewer tokens per session without losing accuracy.
Three of the seven candidate changes were taken; the rest were declined or deferred
because they trade accuracy or completeness for size, which is the wrong trade for
this project. Measurements in [performance.md](performance.md).

**One fetch instead of two.** The nested structures — bank allocations, bill
allocations, inventory lines, tax breakdowns — arrive in the ordinary curated
request. Verified: the lean 8.6MB response and the 18.3MB `FETCH *` response carry
identical numbers of them (948 / 977 / 466 / 1,032). One flag controlled both "keep
the nested structures" and "keep every scalar field", so four tools were paying 10MB
to reach data they already had. Splitting the flags: receivables 7.7s → **2.6s**,
bank reconciliation 6.2s → **3.0s**, stock movements 5.8s → **2.6s**, and those
tools now share the lean fetch rather than forcing a second one.

**`tally_summarise_movements`.** Totals per ledger, group, month, voucher type or
party, summed in Decimal on the server. Two reasons: "sales by month" cost ~16,939
tokens as a voucher list and costs ~1,061 as a summary, and until now there was NO
way to get a total — the only path was to return the rows and let the model add
them, which §6 rule 1 forbids.

It groups ENTRIES, never vouchers, because a voucher has no single amount and
totalling one would mean choosing which leg counts as the transaction. That has a
useful side effect: an unfiltered summary must net to exactly zero, which is double
entry proven at aggregate level through a different code path from the tie-out. It
does, on all four dimensions.

Two defects were found and fixed while building it, both by cross-checking against
Tally's own master rather than by testing:

- The net was **sign-inverted** — the sales ledger summarised to −412,276.25 where
  TallyPrime reports +412,276.25 for the same ledger. Arithmetically consistent, and
  the opposite of what an accountant sees.
- The `ledger` filter selected whole VOUCHERS, so "sales by month" returned twelve
  months of zero (both legs of each transaction landed in the same bucket). It now
  restricts entries.

**Tool-list trim.** Measured over stdio: 19 tools cost ~18,000 tokens of description
and schema before a single question is asked — more than any individual response. The
evidence inside the descriptions ("verified live", measurements, the proof behind each
rule) moved out to the docs, and the four notices repeated in all 19 tools were
shortened. That took ~3,500 tokens off. Every behavioural RULE was kept verbatim and
15 of them are now asserted present by a check over the built tool list, because
cutting a rule to save tokens trades a token bill for a wrong answer.

**Declined or deferred, with reasons:** summary-first defaults on the heavy tools and
a smaller default `pageSize` were declined — both risk an incomplete answer reading as
a complete one, and a receivables list missing page 2 looks exactly like a full one.
`ALTERID`-based cache validation is deferred until it can be proven that Tally bumps
`ALTERID` on every edit including deletions; if it does not, the server would serve
stale figures confidently, which is worse than today's honest five-minute expiry. A
disk cache is deferred as an architecture decision — it contradicts the "no database"
line and writes a client's books to disk.

### Cross-cutting requirements — complete

Pagination, ISO dates with financial-year defaults, empty-results-are-not-errors,
the `Money` shape, `source` provenance on every record, `warnings` for partial
failure, stable error codes, structured stderr logging, and untrusted-content
notices in tool descriptions.

---

## Definition of done — 8 of 8

| # | Requirement | Status |
|---|---|---|
| 1 | `build`, `typecheck`, `lint` pass | ✅ |
| 2 | Unit + integration tests pass against the mock | ✅ 524 passing, 1 skipped — current count in the Summary table above |
| 3 | Every v1 tool returns non-error against real Tally, **and the trial balance matches Tally's own on-screen figures** | ✅ **reconciled exactly** |
| 4 | Every tool discoverable over MCP, returning schema-valid JSON | ✅ |
| 5 | No write/create/update/delete path anywhere | ✅ enforced by a test scanning `src/` |
| 6 | Claude Desktop config example matches current docs | ✅ verified 2026-08-10 |
| 7 | Installed into real Claude Desktop, ≥3 tools invoked from a live conversation | ✅ verified 2026-08-10 — see [below](#item-7--live-in-claude-desktop) |
| 8 | README documents JSON vs XML paths and any unsupported tools | ✅ |

### Item 7 — live in Claude Desktop

Installed as an MSIX/Store package, so the config lives under the virtualised
path (`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`),
not `%APPDATA%\Claude\` — see the README for detection commands. The server
launches with the full `node.exe` path because packaged apps do not reliably
inherit `PATH`.

`logs/mcp-server-tally.log` shows a clean handshake: `initialize`,
`tools/list`, `prompts/list`, `resources/list`, all answered without error.
From a live conversation the connector answered a company query, a group
listing, and a trial balance; the rendered trial balance carried all 9 groups
with both columns totalling **82,436,683.83** — identical to item 3's
reconciliation, confirming the figures survive the round trip through a real
client.

### Item 3 — the trial balance reconciliation

The spec calls a mismatch here "a v1 blocker, not a note". Compared row by row
for 1-Apr-26 to 28-Jul-26:

| Row | This server | TallyPrime on screen |
|---|---|---|
| Capital Account | −1161289.87 / 100000 | 11,61,289.87 Dr / 1,00,000.00 Cr |
| Loans (Liability) | — / 469001 | — / 4,69,001.00 Cr |
| Current Liabilities | −30029462.74 / 1262074.65 | 3,00,29,462.74 Dr / 12,62,074.65 Cr |
| Fixed Assets | −9033417.68 / — | 90,33,417.68 Dr |
| Current Assets | −8206103.51 / 22340920.42 | 82,06,103.51 Dr / 2,23,40,920.42 Cr |
| Suspense A/c | −507361.53 / — | 5,07,361.53 Dr |
| Sales Accounts | — / 44573583.08 | — / 4,45,73,583.08 Cr |
| Indirect Expenses | −33499048.5 / 0.36 | 3,34,99,048.50 Dr / 0.36 Cr |
| Profit & Loss A/c | — / 13691104.32 | — / 1,36,91,104.32 Cr |
| **Grand total** | **82,436,683.83** each side | **8,24,36,683.83** each side |

All 9 rows matched on both columns, nothing missing in either direction, and
the columns net to exactly 0.00.

This is the strongest single check in the project: the positional pairing of
Tally's parallel arrays, decimal handling, the empty-vs-zero rule and the sign
convention all had to be right simultaneously to produce it.

**Magnitudes are identical; only the sign differs.** Tally's screen shows a
debit as positive in a Debit column; the XML reports it negative. Tool
descriptions and prompts both say so explicitly, because quoting the minus sign
as a negative balance would contradict the user's screen while being
arithmetically faithful.

---

## Verified against real data

- Trial balance, balance sheet, P&L — parsed and reconciled
- 330 ledgers, including full-field retrieval (100 fields on a single ledger)
- 30 vouchers in a month, all balancing to zero, 182 fields on one voucher
- Nested structures — real cheque detail recovered from `BANKALLOCATIONS.LIST`
- 73 payables, 1 receivable, 15 GST tax ledgers
- Company scoping guard, refusing a company Tally does not have open
- All tools listed and callable over real MCP stdio

## Inventory reports unblocked, 2026-08-14

A third company — a German company on calendar-year books from
2023-01-01 — was loaded specifically to re-probe the six report IDs that were
confirmed valid but returned nothing (next-steps item 2). **Two of six opened
up.**

| Report ID | Verdict | Size |
|---|---|---|
| `Stock Summary` | **data** — 10 stock items | 2,512B |
| `Godown Summary` | **data** — 1 godown | 264B |
| `Cost Centre Summary` | empty | 23B |
| `Bills Receivable` | empty | 23B |
| `Bills Payable` | empty | 23B |
| `Ledger Vouchers` | empty | 23B |

The four empty ones returned **byte-identical** bodies (hash `2240a70758a0`),
which is Tally saying "valid report, this company records nothing for it". So
cost centres and bill-wise billing are unused on three companies running.
`Ledger Vouchers` is a different case: nothing scoped it to a ledger, so its
emptiness is probably about the request rather than the company.

**Shipped from it: `tally_get_closing_stock`** (`by: 'item' | 'godown'`), the
20th tool and the only location-wise stock path in the server. Two traps found
and disclosed rather than smoothed over:

- `closingQuantity` is Tally's own string with its unit ("9500.00 Kg"). `toMoney`
  refuses these deliberately — the old salvage path returned figures 100x too large.
- `closingRate` is **rounded**, so quantity × rate ≠ value. On the live company
  **5 of 10 item rows** disagreed. The tool description forbids recomputing the
  value, and the live check asserts the disagreement is real rather than assumed.

**Also fixed on the same company: the April-only financial year.** See
[known-limitations.md](known-limitations.md#and-the-financial-year-is-not-always-april-to-march--fixed-2026-08-14).
Deriving a calendar-year company's year by assuming April produced an inverted
range in a user-facing warning (`figuresActuallyCover: {from: 2024-01-01, to:
2023-03-31}`). Now derived from the company's own `STARTINGFROM` and `ENDINGAT`
via `bookYearFor`.

**And the end-date rule was corrected.** `SVTODATE` is not always ignored — it
binds when its day of the month is the 31st. Nineteen live observations. The guard
shipped on 2026-08-12 was refusing periods Tally answers exactly.

## Entry timing, 2026-08-18

The Edit Log question is **closed** and a narrower capability shipped in its place.
Full evidence in [probe-findings-2026-08-18.md](probe-findings-2026-08-18.md).

**Not reachable, and now settled rather than assumed:** eleven Edit Log report names
refused against a control that was refused identically, on two companies; and
`EnteredBy`/`AlteredBy` served but empty on every voucher of all three companies with
data. **Who** altered an entry cannot be obtained over this interface, so CARO Rule
11(g) cannot be supported. That is a limitation, not a backlog item.

**Reachable, and new:** `UpdatedDateTime` is a real per-voucher last-written timestamp —
384/384 and 284/284 populated on two companies, with 223 and 229 distinct stamps, which
is what rules out a single bulk migration event. Lag from voucher date to last write ran
1–119 days (median 51) and 8–103 days (median 42). The third company returns all-zero
placeholders on every voucher.

Shipped as `tally_test_vouchers` test `late_entry`, which flags entries written long
after the date they carry or after the period closed, and **fails with
`TALLY_UNSUPPORTED_OPERATION` on an unstamped company** rather than returning an empty
list that would read as "no late entries". Verified live the same day: 193 candidates of
284 vouchers at a 30-day threshold on one company, 275 of 384 on another, a clean
refusal on the third.

Also confirmed populated per voucher, previously known only on masters: `Audited`,
`IsDeleted`, `IsDeletedVchRetained`, `IsSecurityOnWhenEntered`, `PersistedView`,
`AsOriginal`. `Audited` and `IsSecurityOnWhenEntered` read `No` on every voucher of all
three companies, so they are readable with no variation to test against.

---

## The spreadsheet export, 2026-08-19

A scheduled task now writes each company's books to an `.xlsx` in a folder
Google Drive syncs, so Claude can answer from the workbook with the connector
switched off. `PROJECT_SPEC.md`'s "no background jobs" line is amended in the
same change rather than left contradicted — see the amendment there for what is
and is not overruled.

**Built:** `src/export/` (fetch, shaping, workbook, fingerprint, folder naming,
orchestration), `installer/scripts/export.mjs`, `installer/Run-Export.bat`,
Setup's export questions and `schtasks` registration, and the doctor's report on
the workbook's age.

**Refactors, no behaviour change:** `executeStatement` out of `reports.ts`,
`executeOutstanding` out of `outstanding.ts`, `executeClosingStock` out of
`closingStock.ts` — the same extraction `executeVoucherTest` had, so the export
reuses each tool's own fetch path rather than growing a second way to get the
same figure. The existing tool tests are the regression check and all pass.

**Verified live** against an Indian test company on 2026-08-19:

| Check | Result |
|---|---|
| Full export | **35 tabs, 23,468 rows, 100s** (was 24 tabs / 4,913 rows / 8.1s before prior years and the report views were added) |
| Trial balance debits + credits | 0.00 |
| Voucher entries debits + credits | 0.00 |
| Vouchers / entries | **2,738 / 6,716 across five book years** (2022-03-31 to 2026-07-28). Was 284 / 985 for the current year alone |
| Voucher fields varying vs folded | 36 columns, 241 relocated to `Tally defaults` |
| Change check, nothing altered | 0.77s, no file written, no log line |
| Workbook open / unreplaceable | Named the reason, kept the data, wrote `LAST RUN FAILED - ...` |
| Repeat failure, then recovery | One state change each way — no repeat notification |
| Tally unreachable | Diagnosed as "TallyPrime was not open" in plain words |
| Export folder missing | Diagnosed by name rather than as an OS error |

**Two defects found by inspecting the registered task, not by it failing:**
`schtasks /SC MINUTE` defaults `DisallowStartIfOnBatteries` and
`StopIfGoingOnBatteries` to **true**, so on a laptop — the normal case for this
audience — the export would stop the moment the machine was unplugged, silently.
The task is now registered from a full XML definition with both false, plus
`StartWhenAvailable` and a one-hour `ExecutionTimeLimit` (with `IgnoreNew`, one
hung run would otherwise block every later run for 72 hours). Verified on the
live registration: `MultipleInstancesPolicy` is `IgnoreNew` as the docs claim,
and the repetition carries no `Duration`, so it repeats indefinitely.

Also confirmed while doing it: `schtasks /Create /XML` **requires UTF-16 with a
BOM**. A UTF-8 file is refused with "The task XML is malformed. (1,40)::ERROR:
unable to switch the encoding".

**A third defect, and the only one that would have broken every install:**
`dotenv` reads `.env` from the WORKING DIRECTORY, and Task Scheduler runs an
action with the working directory set to `C:\Windows\System32`. So the task
fired on the minute, exited 1, and reported "No export folder has been chosen
yet" — every minute, forever, on a correctly configured install. No unit test
could see it, because tests never run from another directory. `export.mjs` now
loads the file by absolute path before importing the config module (`dotenv`
runs at import time), `Run-Export.bat` sets its own working directory as a second
guard, and four tests pin the behaviour.

**Verified running unattended**, 2026-08-19 17:11-17:15: the registered task
fired on the minute, found nothing changed twice in a row, and — when a second
company (a US test company) was opened in TallyPrime mid-session — picked it up on
the next minute and exported it as a first run, without anyone touching Setup.

**One real bug caught by the tests rather than in the field:** the fingerprint
request is byte-identical every run, so the client's five-minute response cache
served it from memory and the change check could not see a change for up to five
minutes. It now passes `bypassCache`, and a test that deletes a voucher pins it.

### Not done, and it gates the cadence

**The `ALTERID` prerequisite is still unproven.** Item 6a in
[next-steps.md](next-steps.md): `ALTERID` must move on every edit, including
deletions, and proving that needs somebody at a TallyPrime screen —
`node scripts/probe-alterid.mjs` on a scratch company, then alter / add / delete,
comparing after each. **All three must report MOVED.** If any does not, set
`TALLY_EXPORT_INTERVAL_MINUTES=60` and record it in
[known-limitations.md](known-limitations.md). Until it is run, the every-minute
cadence is built and defaulted but not validated.

Also outstanding, and needing a person rather than code: the end-to-end Google
Drive check (does the workbook appear in Drive, open in Sheets with numbers as
numbers), the same-question-both-ways comparison against the live connector, the
scheduled task running on the minute without overlapping, and the toast
behaviour over ten minutes with the workbook left open.

---

## Unproven: built but not observed

Complete, tested against fixtures, and designed to degrade honestly — but not yet
met with real data, which is a difference worth stating.

| Area | Why unproven | Risk |
|---|---|---|
| **Cost centre / bill-wise areas** | Three companies running record neither. Bill ageing has never run against real bill references, and the bank tool's `reconciled: true` branch has never been reached | Both degrade honestly today: ageing states its basis and coverage bound, and the bank tool refuses a status filter rather than guessing when no bank date exists anywhere |
| **Sales / purchase tools** | The sampled month contained only Payment, Journal and Receipt vouchers | Family resolution is tested against fixtures including a custom "Tax Invoice" type; retrieval against real sales vouchers is not |

Both resolve the first time the server is pointed at a company that uses bill-wise
billing, reconciles its bank, or records sales. Neither is a code gap.

**Inventory came off this list on 2026-08-14** — stock items, stock movements and
both closing-stock reports have now been read from a company that maintains
inventory across a godown.

---

## Data handling

`samples/` holds unredacted exports from a real operating company and is
gitignored. `tests/fixtures/` is committed and must contain only invented
values.

This was got wrong once: the first fixtures replaced the names but kept the
amounts, putting the company's actual turnover and expense totals — plus its
company GUID and a real NEFT reference — into a repository intended to be
public. All were replaced with obviously-synthetic values, and
`tests/fixtures/noRealData.test.ts` now fails the build if any fixture amount,
GUID or reference also appears in `samples/`. It skips when `samples/` is
absent, so it runs precisely where the mistake is possible.

---

## What is left

Nothing on this list is a code gap. In rough order of value:

1. **Point the server at a company that uses bill-wise billing, reconciles its
   bank, and records sales** — the only way to convert the remaining unproven
   areas into verified ones. Needs access to a different Tally company, not a
   change to the server. Inventory was closed this way on 2026-08-14; the same
   move closes the rest.
2. **Decide what happens to `samples/`** — it holds real accounting data on
   disk. Gitignored, but still there.
3. **Get it onto somebody else's machine.** Superseded the old "publish
   decisions" entry, which said no release process existed — one does now:
   `installer/package.ps1` assembles a zip with a bundled Node runtime, and
   `Setup.bat` writes the Claude Desktop config. What has never happened is an
   install by anyone outside this machine, or a run where Claude Desktop itself
   launches the server and answers a question. npm publishing stays deliberately
   undone: the audience is accountants, so the zip is the shipping route.
4. **Prove `ALTERID` moves on every edit** — the probe is written and a baseline
   reading was taken on 2026-08-18, but the procedure it exists for (alter, add,
   delete a voucher, comparing after each) needs a human with a scratch company
   in TallyPrime. It gates a 10x cache improvement, and it must not be taken on
   faith: if a deletion leaves `ALTERID` unmoved, a validated cache would serve
   stale figures confidently. See
   [next-steps.md](next-steps.md#6a-prove-alterid---probe-built-2026-08-13-needs-a-human-with-tally-open).
5. **Revisit the deliberate omissions if Tally's behaviour changes** —
   `tally_get_day_book` and the two flow statements are settled decisions, not
   a backlog; they are recorded here so they stay decisions rather than
   drifting into forgotten gaps.
