# Probe findings — 2026-08-18: the Edit Log, and what a voucher carries instead

Run with [scripts/probe-editlog.mjs](../scripts/probe-editlog.mjs) against live
TallyPrime on `http://127.0.0.1:9000`, four companies loaded. Read-only
(`TALLYREQUEST=Export`) throughout, with a health probe between every report
candidate. Tally answered normally before and after — 16ms at the end.

This closes the item [probe-findings-2026-08-14.md](probe-findings-2026-08-14.md)
finding 5 left explicitly open: _"Untested: whether a Voucher collection carries the
same fields populated."_

---

## 1. There is still no Edit Log report ID — now with a control, on a second company

Eleven candidate names (`Edit Log`, `Edit Log Summary`, `Edit Log Report`,
`Voucher Edit Log`, `Edit Log for Vouchers`, `List of Alterations`,
`Alteration Register`, `Alteration Summary`, `Audit Trail`, `Voucher Audit Trail`,
`Edit Log Vouchers`) were each refused:

```xml
<LINEERROR>Could not find Report 'Edit Log'!</LINEERROR>
```

The deliberately-invented control name was refused identically, which is what makes
the eleven verdicts mean anything: the probe demonstrably distinguishes a working
report from a rejected one. Re-run on `AgEx Pharma LLC (25-26)` and on
`MUDALS TECHNOLOGIES PRIVATE LIMITED` with the same result, so this is not a
one-company artifact.

**No report path exists.** Restated rather than newly discovered — the value here is
the control and the second company.

## 2. Voucher-level `EnteredBy` and `AlteredBy` are served, and EMPTY

The fields an audit trail is actually made of _are_ served on the `Voucher`
collection. They carry nothing:

| Field       | AGBV Nutrition GmbH | AgEx Pharma LLC | MUDALS     |
| ----------- | ------------------- | --------------- | ---------- |
| `EnteredBy` | 0 / 384             | 0 / 5           | 0 / 284    |
| `AlteredBy` | 0 / 384             | 0 / 5           | 0 / 284    |
| `CreatedBy` | not served          | not served      | not served |

Same pattern as the `List of Accounts` audit containers in finding 5: Tally emits its
field superset whether or not it holds data. **Who** changed a voucher is not
available on any of the three companies with vouchers. None of them has Edit Log
switched on ([coverage.md](coverage.md)), so this is consistent with the feature being
off rather than with the field being unreadable — but it cannot be told apart from
here, and an empty `ALTEREDBY` must never be reported as "nobody altered it".

## 3. `UpdatedDateTime` IS a real per-voucher last-touched timestamp — on two of three companies

This is the genuine find, and the one thing here worth building on.

| Company             | vouchers | real timestamps              | distinct stamps | distinct days | stamped after the voucher date |
| ------------------- | -------- | ---------------------------- | --------------- | ------------- | ------------------------------ |
| AGBV Nutrition GmbH | 384      | 384                          | 223             | 5             | 382 / 384                      |
| MUDALS TECHNOLOGIES | 284      | 284                          | 229             | 11            | 284 / 284                      |
| AgEx Pharma LLC     | 5        | **0** — all-zero placeholder | —               | —             | 0                              |

Format is `YYYYMMDDHHMMSSmmm` (second resolution, 17 digits), and the placeholder is
all zeros, so the two are trivially separable.

**It is per-voucher, not a bulk migration stamp.** That was the obvious way for this
to be worthless, and the distinct-stamp counts rule it out: 223 distinct stamps across
384 vouchers clustered into 5 calendar days is the signature of a handful of real
keying sessions, not one import event copied onto every record. A single distinct
stamp would have meant the opposite.

**Where the lag is large.** On AGBV the gap between a voucher's date and when it was
last touched runs 1 to 119 days, median 51. On MUDALS, 8 to 103 days, median 42.
Entries dated inside the year and last written months later is exactly the cut-off
signal, and [testVouchers.ts](../src/tools/testVouchers.ts) currently declines two
tests for want of it.

**What it is NOT.** One timestamp, of the _last_ write. It cannot say whether that
write was the creation or a later alteration, cannot say who made it, holds no
before/after values, and disappears entirely on a company where it reads as zeros.
It is a _flag for enquiry_, not audit-trail evidence, and it cannot support CARO
Rule 11(g) — which needs the trail itself, preserved and untampered.

## 4. Also populated, and previously only known on masters

`GUID`, `MasterId`, `AlterId`, `Audited`, `IsCancelled`, `IsDeleted`,
`IsDeletedVchRetained`, `IsSecurityOnWhenEntered`, `PersistedView`, `AsOriginal` and
`VoucherRetainKey` all come back populated on every voucher on all three companies.
Finding 5 had these on masters only. `IsSecurityOnWhenEntered` was `No` on every
voucher of all three, and `Audited` likewise `No` — so both are readable but carry no
variation to test against on the books available here.

## 5. Two method notes, both of which produced a wrong verdict before being caught

- **A tag census over a whole `<VOUCHER …>` block reports every field as absent.** The
  outer element matches first and lazily swallows its own children, so the pass ends
  after one match. Strip the wrapper, or extract per named field. The first run of
  this probe reported `Date` as `NOT SERVED` on 384 vouchers because of it.
- **`CMPINFO` contains `<VOUCHER>0</VOUCHER>`.** A block match that does not strip
  `CMPINFO` counts it, reporting one voucher on a company that returned none.

## 6. Incidental: the period request is still not binding on vouchers

`MUDALS` returned the same 284 vouchers for `2021-04-01..2022-03-31` as for
`2025-04-01..2026-03-31`. Independent corroboration of finding 2 / the current-FY-only
limitation, from a different direction.

---

## Verdict on building an Edit Log tool

**Not buildable as an Edit Log.** There is no report path, no collection path that is
safe to look for, and the `who` fields are empty. Nothing here would let an auditor
see that an entry was altered after the fact, which was the whole point.

**One narrower thing IS buildable**, and honestly so: a late-entry / cut-off enquiry
built on `UpdatedDateTime`, reporting vouchers whose last write postdates the voucher
date by more than a chosen threshold. It must:

1. Refuse to run when the timestamps read as all-zero placeholders, rather than
   reporting "no late entries" — the AgEx case, and the exact false-assurance failure
   pattern this repo has been bitten by twice.
2. State on every result that this is the LAST write, of unknown authorship, and that
   a voucher created late and one altered late are indistinguishable.
3. Never be presented as an audit trail, an Edit Log, or CARO Rule 11(g) evidence.

**BUILT 2026-08-18**, as `tally_test_vouchers` test `late_entry` — a test inside the
existing tool rather than a tool of its own, so it shares one population definition
with `cutoff` and the rest. All three conditions above are implemented and covered by
`tests/tools/lateEntry.test.ts`: the unstamped case throws
`TALLY_UNSUPPORTED_OPERATION`, the last-write caveat is repeated on every candidate
row as well as in the warnings, and `lagDistribution` is returned over the whole
stamped population rather than over the flagged rows.

Verified against all three live companies on the day it was written: 193 candidates of
284 vouchers at a 30-day threshold on MUDALS, 275 of 384 on AGBV, and a clean refusal
on AgEx Pharma LLC. The candidate counts being that high is the point of returning the
distribution — at these companies' median lag of 42 and 50 days, a 30-day threshold is
below normal practice and the threshold is what should move.
