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

**That tool is now built** — `tally_get_report`, in
[../src/tools/genericReport.ts](../src/tools/genericReport.ts), with a closed enum
of nine IDs. This file is the record of how those IDs were established, and it is
still the input for adding any more: an ID that has not been through a run like
this one does not go in the enum.

Two things on this page have since been overtaken, both on 2026-08-14:
- The probe run was repeated with more candidates and found **six further working
  IDs**, including `Negative Ledgers`, `Ratio Analysis` and the three registers.
  See [probe-findings-2026-08-14.md](probe-findings-2026-08-14.md) finding 6.
- The safety finding below is **too narrow**. It concluded that a bad report ID is
  refused harmlessly, which is correct and still holds. What it did not know is that
  an unrecognised **collection `<TYPE>`** behaves completely differently: it parks
  TallyPrime behind a modal "incorrect object type" dialog that blocks the HTTP
  interface until a human dismisses it. That cost two restarts to learn. Report IDs
  are the safe class; collection types are not, and the two must never be reasoned
  across.

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

The failure recorded in `known-limitations.md` came from a **collection** name — a
different request shape with a different failure mode. The distinction is the whole
point, and it has since been sharpened twice:

- **Named reports** (`TYPE=Data` with an `<ID>`) reject harmlessly. Safe to probe.
  Re-confirmed 2026-08-14 across 25 candidates with controls at both ends.
- **Collections with an unrecognised `<TYPE>`** must never be sent. Not "sent
  carefully with a short timeout" — not sent.

**Two corrections to what this section originally said**, both measured 2026-08-14:

1. **It is not the missing definition that is dangerous, it is the TYPE.** This page
   blamed "a collection name with no `<COLLECTION>` definition". A collection with a
   complete, well-formed inline definition is **equally** dangerous if its TYPE is
   unrecognised. `<TYPE>Voucher.AllLedgerEntries</TYPE>` — a perfectly reasonable-
   looking dotted sub-collection name used by `tally-database-loader` in a different
   context — did it, as did a deliberately invalid `<TYPE>NoSuchTypeXyz</TYPE>`.
2. **It does not "wedge Tally and then close it".** TallyPrime raises a **modal
   "incorrect object type" dialog** and keeps running. While that dialog is open it
   accepts HTTP connections and serves nothing at all, until a human at the machine
   clicks OK. Nothing is corrupted and no books are altered — every request sent was
   `Export`.

   That is *better* than a crash and *worse* for unattended use: one bad request
   blocks every subsequent request, with no signal visible from the client side
   beyond timeouts. It also produced a false green from the health probe, which was
   cached and reported `connected: true, responseTimeMs: 0` while real requests timed
   out. Two TallyPrime restarts to establish, and the health probe now bypasses its
   cache because of it.

The caution in `known-limitations.md` should therefore be narrowed to collections and
**strengthened** for them, rather than dropped. As written it both discouraged the
safe verification this file depends on and understated the one real hazard.

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

### Added by the 2026-08-14 run

All six returned real content and are in the `tally_get_report` allowlist.

| Report ID | Notes |
|---|---|
| `Negative Ledgers` | The audit-grade one: a ledger holding a balance on the side it should not. Returns content on all three companies since probed — 4 rows, 67 rows, 34 rows. Negative cash is impossible in reality, so this is a classic first check |
| `Sales Register` | |
| `Purchase Register` | |
| `Journal Register` | The highest-risk population in a ledger |
| `List of Accounts` | 7.5 MB chart of accounts. Its audit-trail containers are **empty scaffolding** — see the Edit Log note in New-Improvements.md before reading anything into them |
| `Stock Summary` / `Godown Summary` | Verified separately; drive `tally_get_closing_stock` |

### Accepted but never seen with data

TallyPrime **accepts** these four — they are valid IDs, not rejections — but every
attempt returned the identical 21-byte empty envelope, including a re-probe against
all three loaded companies (twelve combinations, zero rows). So their **row shape has
never been observed**. They are in the allowlist because the ID is proven, and the
tool says "ROW SHAPE UNVERIFIED" on every call.

| Report ID | Why it is probably empty |
|---|---|
| `Negative Stock` | Plausibly a real "nothing to report" — but indistinguishable from no inventory |
| `Bills Receivable` | None of the three companies uses bill-wise tracking |
| `Bills Payable` | Same |
| `Cost Category Summary` | Empty even on a company with cost centres enabled on 25 of 54 ledgers, so cost centres being on is **not** sufficient to populate it. Either no cost *categories* are defined — categories and centres are separate in Tally — or the report needs something else again |

### Rejected — no report route exists

| Report ID | Consequence |
|---|---|
| `Cost Centre Break-up` | Cost centres have no report route at all |
| `Budgets`, `Budget Variance` | The budget-variance tool has no report route |
| All Edit Log names | The audit trail is unreachable; CARO Rule 11(g) cannot be supported |
| All licence / version names | The Educational-mode check remains impossible |
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
