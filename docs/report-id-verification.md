# Report ID verification

Which TallyPrime report IDs actually work, established by asking a live install
rather than by reading documentation. Companion to
[known-limitations.md](known-limitations.md), which explains *why* the data
behaves as it does; this file records *what exists* to ask for.

**Probed:** 2026-08-10, against TallyPrime 7.x on `http://127.0.0.1:9000`,
period 2025-04-01..2026-03-31, using `buildReportRequest` (`TYPE=Data`) from
[src/tally/requests.ts](../src/tally/requests.ts). 23 requests, one at a time,
with a health probe before and after each.

---

## Why this file exists

The server exposes ~30 curated tools. A question outside that set has no path
at all — cost centres, godowns, ratios, registers. The intended fix is a single
generic `tally_get_report` tool restricted to an **allowlist** of report IDs,
wrapping the `buildReportRequest` builder that already exists.

That tool is **not built**. It is on hold until a company with more features
enabled is available, because six promising report IDs return nothing on the
company probed here. This file is the verified input for that work, so the
probing does not have to be repeated.

---

## The safety finding, which matters more than the list

[known-limitations.md](known-limitations.md) states that an unresolvable report
ID can terminate TallyPrime, and uses that risk as one of two reasons for not
attempting cash flow. **For named reports, this is not what happens.**

Six deliberately wrong report names each produced a clean error response:

```xml
<LINEERROR>Could not find Report 'Outstandings'!</LINEERROR>
```

TallyPrime kept serving HTTP throughout all 23 requests. No modal dialog, no
exit.

The crash recorded in `known-limitations.md` came from a **collection** name
with no `<COLLECTION>` definition in the request — a different request shape
with a different failure mode. The distinction is the whole point:

- **Named reports** (`TYPE=Data`) reject harmlessly. Safe to probe.
- **Undefined collections** wedge Tally and then close it. Never send one.

The existing caution should be narrowed to collections rather than dropped.
As written it discourages the safe verification this file depends on.

---

## Verified: returns real data

| Report ID | Notes |
|---|---|
| `Trial Balance` | Group-level, parallel arrays. Already used by the server. |
| `Balance Sheet` | Already used by the server. |
| `Profit and Loss` | Already used. Note the spelling — see rejected list. |
| `Voucher Register` | Already used. |
| `Group Summary` | **Byte-identical to `Trial Balance`** (same sha256). A true alias. |
| `Ratio Analysis` | Working capital, cash, bank, ratios. Values arrive pre-formatted with `Dr`/`Cr` suffixes, e.g. `12,34,567.89 Dr` — strings, not numbers. (Illustrative figure, not real data.) |
| `Cash Flow` | Month-by-month inflow / outflow / net. See the caveat below. |
| `Funds Flow` | Same shape as cash flow. |
| `Sales Register` | Returns data. |
| `Purchase Register` | Returns data. |
| `Statistics` | Voucher counts by type. |
| `Day Book` | ~148 KB, far the largest response. Its date-range bug is documented separately in `known-limitations.md`. |

Report IDs *are* honoured — `Balance Sheet` returned different bytes from
`Trial Balance` — so the alias above is genuine, not a silent fallback to some
default report.

## Valid ID, but empty on this company

These returned exactly `<ENVELOPE></ENVELOPE>`. That is **not** a rejection:
the report exists, the company simply records nothing for it.

`Cost Centre Summary`, `Godown Summary`, `Bills Receivable`, `Bills Payable`,
`Stock Summary`, `Ledger Vouchers`

Consistent with the unverified-inventory note in `known-limitations.md`. These
are the six that need a different company before anything can be built on them.

## Rejected: no such report

`Cash Bank Summary`, `Bank Reconciliation Statement`, `Outstandings`,
`Budget Variance`, and `Profit & Loss` — where the working ID is
`Profit and Loss`. The ampersand form fails, which is an easy mistake to
repeat.

---

## The cash flow caveat

`Cash Flow` and `Funds Flow` return usable monthly movement data, so the
"native report path is unverified" half of the reason for not implementing them
no longer holds.

**The other half still does.** Tally returns money moving in and out by month.
It does not classify that movement as operating, investing or financing, and
that classification is what makes a cash flow statement a cash flow statement.
It depends on the business, and this server holds no business rules.

So the data can be returned; it must not be labelled a cash flow statement.
Whether to expose it on those terms is an open decision, not a bug.

---

## What is left

1. **Re-probe the six empty IDs** against a company using cost centres,
   inventory and bill-wise details. That is the blocker.
2. **Build `tally_get_report`** from the verified list. Allowlist only — never
   a freeform report name from the model, because an end user with unsaved work
   should never be exposed to a guessed ID.
3. **Narrow the report-ID caution** in `known-limitations.md` to collections.

## Reproducing this

Any new report or collection ID must be verified the same way rather than
guessed at. The method that made this safe:

- Named reports only, never a bare collection name.
- One request at a time, never concurrent — Tally serves one at a time anyway.
- A cheap health probe between every candidate, aborting the run the moment
  Tally stops answering, so a wedged install is caught before more requests
  pile onto it.
- A short timeout, so a wedged Tally shows up as a fast failure rather than a
  hang.
- Hash every response. Two different IDs returning identical bytes is how the
  `Trial Balance` / `Group Summary` alias was caught; without hashing, both
  would have looked like independent successes.
- Confirm nothing is unsaved in TallyPrime first. The residual risk is lost
  unsaved work, not damaged books.
