# Known limitations

A living record of what this server cannot do, and why. Kept honest
deliberately: a tool that quietly returns partial data is worse than one that
says it cannot help.

> For **how much is done** rather than why it behaves as it does, see
> [project-status.md](project-status.md). For **what each tool costs** in tokens
> and time, measured against a live install, see
> [performance.md](performance.md).

## Status: v1 and v2 built

Both tool sets are complete and every done-criterion is met. What is still
*unverified* — as opposed to unbuilt — is stated explicitly below and in
[project-status.md](project-status.md), rather than implied.

### Working and verified

| Component | Verified how |
|---|---|
| Configuration + startup validation | Unit tests |
| Error codes and payload sanitisation | Unit tests, incl. no-stack-leak assertions |
| Single-flight request queue | Unit tests asserting max concurrency of 1 |
| XML sanitisation (control chars, bare `&`, BOM, encoding mismatch) | Unit tests, asserting a strict parser survives each payload |
| HTTP client: encoding detection, timeouts, error mapping | Unit tests against the mock Tally server |
| Tally request builders (Export-only) | Unit tests, plus a source scan asserting no write verb exists |
| `tally_connection_status` | Unit + stdio integration tests |
| MCP server over stdio | Integration test: real process, real handshake, stdout purity |
| `TallyResponseParser` | Unit tests against redacted real responses |
| Normalization layer (companies, ledgers, trial balance, balance sheet, P&L, vouchers) | Unit tests against redacted real responses, plus a double-entry invariant |

| 13 tools: companies (list/get), ledgers (list/search/get/transactions), trial balance, balance sheet, P&L, vouchers (list/search/get) | Unit tests against a mock serving redacted real responses, plus a live end-to-end run |
| Company scoping guard, full-field retrieval, `source` provenance on every record | Unit tests, plus a live run confirming 100 fields on a ledger and 182 on a voucher |
| Nested structure extraction (inventory, bank, tax allocations) | Unit tests including two-level nesting, plus a live run recovering real cheque detail |
| 4 MCP prompts, 2 MCP resources | Live run confirming they list and render over stdio |

| 16 v2 tools: sales/purchases, inventory, receivables/payables, GST, cross-entity search, company features | Unit tests against real-shape fixtures, plus a live run |

### Built but not yet observed against real data

Nothing outstanding. The two entries formerly listed here — inventory tools and
sales/purchase retrieval — were both confirmed live on 2026-08-12:

| Component | Confirmed |
|---|---|
| Inventory tools | 3 stock items with balances, values and rates; 8 movements derived from voucher inventory lines |
| Sales / purchase retrieval | 24 sales-family and 3 purchase-family vouchers, over a company using custom type names |

The sales case exercised the behaviour the family resolution exists for: the
company's Sales family resolved to `["export invoice", "gwi invoices", "sales"]`.
Two of those three carry no "sales" in their name, so matching on the type name
would have under-reported the period by roughly a third.

### Deliberately not built

| Component | Why |
|---|---|
| `tally_get_day_book` | Will not be built as specified; see "the day book ignores the requested date range" below |
| `tally_get_statement (statement: 'cash_flow')`, `tally_get_statement (statement: 'fund_flow')` | Registered but deliberately unimplemented — see below |

### Cash flow and fund flow return movement, not classified statements

Since 2026-08-12 both tools return real data from TallyPrime's own `Cash Flow`
and `Funds Flow` reports (retrieval paths verified live): one row per month
with Tally's debit, credit and net columns passed through under Tally's own
names and sign convention.

What they deliberately do NOT return is a *classified* statement. A cash flow
statement classifies movements into operating, investing and financing
activities; a fund flow statement decides what counts as a source versus an
application. Both classifications are judgements about the business, this
server holds no business rules, and Tally supplies no such split in these
reports. The tool descriptions instruct Claude to present the data as "monthly
movement" and to make any classification together with the user, stating the
basis.

Verified column semantics, for anyone extending this: on the cash flow report
net = debit + credit; on the funds flow report each month's debit equals the
previous month's credit (opening/closing funds) and net = credit − debit.

### Inventory tools — verified against real stock 2026-08-12

Previously unverified: the only company available held zero stock items, so the
normaliser promoted just `name` and `parent` and passed everything else through
generic field extraction rather than inventing a mapping.

A company with real inventory has since been confirmed live. `baseUnits`,
`openingBalance`, `closingBalance`, `openingValue`, `closingValue` and
`closingRate` are now promoted to named properties; anything else a company
configures (e.g. `CATEGORY`) still arrives in the open `fields` map, since which
extra fields exist is per-company and not knowable ahead of time.

Two things worth knowing about the values:

- Quantities and rates are **strings in Tally's own format**, unit included —
  `"1000.00 Kgs."`, `"20.00/Kgs."`. They are not parsed into numbers, because
  splitting the unit off invites silent unit conversion (see below).
- `openingValue` / `closingValue` arrive **negative** for stock in hand, the
  same sign convention as the trial balance. The sign is preserved, not
  corrected.

`tally_get_inventory_movements` is derived from the inventory allocations nested
on vouchers rather than a stock movement report, for the same report-ID safety
reason. Quantities are returned exactly as Tally recorded them, unit included
("100 nos"), and never summed or unit-converted — conversion needs the item's
conversion factors, and getting that silently wrong would be worse than not
doing it.

### A voucher type's top-level NUMBERINGMETHOD is legacy and reads "None" always

Found by live testing on 2026-08-12, after a fixture-passing implementation had
already shipped the wrong answer.

`<NUMBERINGMETHOD>` on a `VOUCHERTYPE` record reads **`None` on every voucher
type** — all 26 on the company probed — while the method actually in force lives
in the nested `<VOUCHERNUMBERSERIES.LIST>`, one entry per numbering series:

```xml
<VOUCHERTYPE NAME="Sales">
  <NUMBERINGMETHOD>None</NUMBERINGMETHOD>        <!-- legacy, always None -->
  <VOUCHERNUMBERSERIES.LIST>
    <NAME>Default</NAME>
    <NUMBERINGMETHOD>Automatic</NUMBERINGMETHOD>  <!-- the real one -->
    <NUMBERINGSUBMETHOD>Auto Retain</NUMBERINGSUBMETHOD>
    <PREVENTDUPLICATES>No</PREVENTDUPLICATES>
    <PREFIXLIST.LIST><NAME>ACME/INV/</NAME></PREFIXLIST.LIST>
  </VOUCHERNUMBERSERIES.LIST>
</VOUCHERTYPE>
```

25 of the 26 types were `Automatic / Auto Retain`. Reporting the scalar therefore
told the reader that a company numbering every voucher automatically numbers none
of them — a confident answer, uniformly wrong, in a field an auditor would use to
judge whether a repeated voucher number matters.

Two consequences worth carrying forward:

- **The nested list cannot travel on a curated `NATIVEMETHOD` fetch**, so
  `tally_get_voucher_types` asks for every field. That is affordable here — 142 KB
  for 26 types — unlike the 37x cost on ledgers. The curated form is still used by
  voucher-family resolution, which needs only name and parent.
- The fixture deliberately keeps the misleading `None`, so a normaliser that goes
  back to reading the scalar fails a test rather than shipping quietly.

This is the "presence is not usage" trap in its sharpest form: the field was
populated, uniform, and wrong. Any new scalar promoted from a Tally record should
be checked against a full-field response before being trusted.

### Bank reconciliation is derived from vouchers, and its status field can be unknown

`tally_get_bank_reconciliation` reads the `BANKALLOCATIONS.LIST` structure on
voucher entries rather than TallyPrime's own Bank Reconciliation report, for the
same reason `tally_get_inventory_movements` derives from voucher inventory lines:
that report's export ID is unverified, and a wrong ID is not a failed query but a
closed application (see below).

Reconciled status is read from `BANKERSDATE`, the field Tally stamps with the
bank statement date. Unreconciled entries leave it empty and the parser drops
empty elements, so **presence means reconciled and absence means unreconciled —
but only if this Tally reports the field at all.** Absence alone is ambiguous, so
the whole result set is inspected first:

- At least one row carries a bank date → the field is confirmed live, and
  `reconciled: false` on the others is sound.
- No row carries one → `reconciled` is `null` on every row, with a warning, and a
  request that filtered on status fails with `TALLY_UNSUPPORTED_OPERATION`.
  Returning every bank entry in the period as "unreconciled" would assert that
  nothing has been reconciled, on no evidence.

Two consequences: an instrument attached to a voucher outside the requested
period does not appear even if still uncleared, so finding old uncleared cheques
means widening the range; and a company entering bank payments without a
transaction type records no instrument structure at all, which the tool reports as
a finding about how the books are kept rather than as a retrieval failure.

It lists instruments and their status. It does **not** produce a reconciliation
statement — book balance against bank balance — because deciding which side each
uncleared item falls on is an accounting judgement, and this server holds none.

**Live status, 2026-08-12.** The unknown path is confirmed against real data: on
the company probed, the raw response carried 406 `BANKERSDATE` elements and every
single one was empty, so the tool reported `reconciled: null` throughout and
refused both status filters. **The `reconciled: true` path has never run on real
data**, because no populated bank date exists on either company available so far.
It is the one branch of this tool still resting on fixtures.

A second finding from the same run, now handled: TallyPrime stamps eleven cash
denomination counters on every bank instrument regardless of whether cash is
involved. Across 200 cheque and wire instruments that was 2,200 counters, every
one zero, consuming 24% of a response that has a hard size ceiling. Zero-valued
counters are dropped from `instrument`; a non-zero one is always kept, because on
a cash transaction it is real data. Disclosed in the tool description rather than
trimmed silently.

### The statements ignore the requested END date and accumulate to the year end

**The most consequential finding about this server's figures so far, and it
affects a v1 tool that was believed verified.** Found 2026-08-12 by an adversarial
review of a live run, not by the live run itself.

TallyPrime honours `SVFROMDATE` on `Trial Balance`, `Profit and Loss` and
`Cash Flow` and **ignores `SVTODATE`**. The figures accumulate from the start date
to the end of the company's financial year, whatever end date was asked for. Two
independent proofs from the same captured run:

- A `Cash Flow` request carrying
  `<SVFROMDATE>20250701</SVFROMDATE><SVTODATE>20250930</SVTODATE>` returned **nine
  monthly rows, July through March.**
- A `Trial Balance` for 1-Apr-2025 to 30-Jun-2025 returned figures **identical,
  row for row, to the same report for 1-Apr-2025 to 31-Mar-2026.**

Reconstructed from the raw voucher register to be sure: the Sales Accounts group
totalled 502,237.50 for the full year and 290,385.00 from July onward. The
"Q1" request returned 502,237.50 — the whole year — and the "Q2" request returned
290,385.00, which is July-to-March. Both are `fromDate` honoured, `toDate`
discarded.

**Why the original reconciliation did not catch it.** Definition-of-done item 3
compared a trial balance for 1-Apr-26 to 28-Jul-26 against TallyPrime's own
screen, row by row, and it matched exactly. It could not have failed: that company
held no transactions after 28 July, so "accumulated to the year end" and "as at
the end date" are the same figures. The check that existed precisely to catch this
class of error was blind to it for want of a later transaction. It took a second
company, with a full year of data and a mid-year query, to expose it.

**Consequences.**

- Any `tally_get_statement` call whose `toDate` is not the company's financial
  year end returns a **cumulative position from `fromDate`**, not the period
  requested. Every response now carries `coversPeriodRequested`, plus
  `figuresActuallyCover` when it is false, and a warning saying so. The figures
  are real and are still returned — withholding correct data would be worse — but
  they must be quoted as a cumulative position.
- **Period comparison is refused** unless the main period ends at the year end.
  This is the dangerous case: if both sides accumulate to the same year end, the
  subtraction collapses algebraically to *minus the whole of the earlier period*.
  On the company probed, a Q2-vs-Q1 trial balance comparison would have reported
  sales down 211,852.50 — a 42% collapse — when Q1 sales were 211,852.50 and Q2
  were 206,100.00, i.e. flat. A fabricated figure of exactly the right size to be
  believed, with no warning, in answer to the one question the feature exists to
  answer. So it fails with `TALLY_UNSUPPORTED_OPERATION` instead.
- The comparison that *does* work is two cumulative positions with different start
  dates, both run to the year end.
- `tally_get_vouchers` is unaffected, though not because Tally scopes it: the
  voucher collection ignores both dates, so the period is applied client-side over
  the whole book. The range it reports is therefore exactly the range asked for.

**Established 2026-08-13: `Balance Sheet` and `Funds Flow` ignore the end date
too.** Both were called live for the first time — a full-year request and a
first-quarter request each. The mid-year rows came back **identical** to the
full-year rows on both reports, so the conservative guard was exactly right,
including for the balance sheet: a mid-year balance sheet is the year-end
position, not the position at the requested date. All five statements are now
verified to behave the same way, and `coversPeriodRequested` is correct on every
one.

**Tried and closed, 2026-08-13.** Six candidate `STATICVARIABLES` entries were
tested against the already-verified `Cash Flow` report ID using
[scripts/probe-statement-period.ts](../scripts/probe-statement-period.ts) —
`SVCURRENTDATE`, `SVISPERIODICREPORT`, `SVVIEWNAME Monthly`, replacing
`SVFROMDATE`/`SVTODATE` with `SVPERIODFROM`/`SVPERIODTO`, and a duplicated
`SVTODATE`. Baseline reproduced the bug (9 rows for a 3-month request); every
candidate either left it unchanged or made it worse — the `SVPERIODFROM`/
`SVPERIODTO` swap returned **12** rows, meaning Tally didn't recognise those
variables at all and fell back to the full year rather than the `SVFROMDATE`
bound it otherwise honours. TallyPrime answered throughout, confirming unknown
static variables really are ignored rather than rejected, as TDL documents.

**Conclusion: not a missing request setting.** This is not a promising avenue to
keep guessing at — the fix, if one exists, is inside TallyPrime's own report
definition for these three IDs, not in what this server sends. The mitigation
(refuse mid-year comparison, flag mid-year statements as a cumulative position)
stands as the answer rather than a placeholder. Re-running this experiment
without a new, specific, documented candidate would not learn anything the run
above didn't already establish.

### The trial balance carries stock at its OPENING value; the balance sheet and ledger masters carry CLOSING

Found 2026-08-13 by reconciling every tool against every other tool on live
books, rather than each tool against Tally alone — which is the only way it
could have been found, because **every figure involved is TallyPrime's own**.

On the same company, same period, same request date:

| Path | Current Assets |
|---|---|
| `tally_get_statement (trial_balance)` | **−385,764.46** |
| `tally_get_statement (balance_sheet)` | −482,384.46 |
| Sum of `tally_get_ledgers` closing balances under the group | −482,384.46 |

The 96,620.00 difference is exactly the year's movement on `Stock In Hand`
(opening −207,968, closing −304,588). TallyPrime's own Trial Balance report
carries the stock account at its **opening** value while its Balance Sheet and
the ledger masters carry the **closing** value — presumably because stock's
closing figure comes from inventory valuation rather than ledger postings, the
same property that makes it `notCheckable` in `tally_check_tie_out`. Every
other group agreed across all three paths to the cent, and the raw XML confirms
both figures arrive from Tally exactly as reported.

Neither figure is adjusted — §6 rule 1 — and neither is picked as "the right
one". What changed is disclosure: a `trial_balance` response whose group total
disagrees with the sum of the ledger masters under that group now carries a
warning stating both figures, the difference, and (when a single account's
opening-minus-closing accounts for the gap exactly) which account and why. The
check observes rather than assumes: a company whose trial balance agrees —
e.g. accounts not integrated with inventory, or no stock — produces no warning,
and any *future* divergence of this kind is caught by the same arithmetic
without naming stock anywhere.

The cost is one ledger fetch and one group fetch per trial-balance call, both
served from the 5-minute cache in practice. The diagnostic never throws: if the
masters cannot be read the statement is answered as before, silently.

### Statement comparison pairs rows by name, and refuses to guess

`tally_get_statement` takes an optional second period. Rows pair by name and
**only when the name occurs exactly once in both periods**: statements carry
headings and subtotals as ordinary rows, and the two periods need not contain the
same rows at all, so positional pairing would report one account's movement under
another's name — the same failure mode as the parallel-array trap above. Repeated
names go to `unpaired.ambiguous`; names present in one period only go to
`currentOnly`/`comparisonOnly` and are explicitly not zeros.

A change is computed only where both figures are present. A null is Tally
reporting nothing, and subtracting against it would report a movement equal to
the whole of the other period's figure.

The comparison period is never defaulted. Picking "the previous year" silently
would put a period nobody asked for on the other side of every subtraction.

### The default period is today's financial year, which is often the wrong one

When a tool is called with no `fromDate`/`toDate` it defaults to the Indian
financial year containing **today**, matching what TallyPrime's own reports do.

That default is wrong more often than it looks. Accounting firms routinely keep
one TallyPrime company per financial year — "Acme Pharma LLC (25-26)" — and keep
prior-year companies open for finalisation well into the following year. Open a
25-26 company on any date after 1 April 2026 and the default period no longer
overlaps its books, so **every date-defaulted query returns zero rows**.

Observed live 2026-08-12: a company holding 453 vouchers in FY 25-26 reported
nothing at all for the defaulted FY 26-27 period. The response was
indistinguishable from a company with no transactions — an empty `<DATA>`
section with no `<VOUCHER>` elements (captured as
`tests/fixtures/voucher-register-empty.xml`).

Silence is the dangerous outcome here: "no vouchers" reads to a user as *the
data is missing* or *the connection is broken*, not *you asked about the wrong
year*. So `noteEmptyDefaultedPeriod` annotates the case — when the period was
defaulted **and** the whole period came back empty, the response carries a
warning naming the loaded company, the date its books begin, and a concrete
range to retry with.

It is deliberately narrow, and the boundaries matter:

- Caller supplied the dates → **silent**. They chose the period; an empty answer
  for it is a real answer.
- Period has vouchers but a filter matched none → **silent**. That is a normal
  search result, not a period problem.
- Genuinely empty year → still annotated. This is honest: the note says the
  period was defaulted, not that it was wrong.

The default itself is unchanged. Switching it to the company's own year would
mean silently answering about a period nobody asked for, which is the failure
mode this codebase avoids everywhere else. The extra company lookup happens only
on the empty-and-defaulted path, and a failure in it is swallowed — a diagnostic
must never turn a valid empty answer into an error.

### Receivables and payables compute no OVERDUE figure — ageing is by bill age

Overdue analysis needs a due date per bill, and that depends on credit terms
which may be recorded per party, per bill, or not at all. Where Tally reports a
bill's due date it is passed through; where it does not, the field is simply
absent. Deriving one from an invoice date plus an assumed credit period would
produce an authoritative-looking bucket that is invented. That has not changed.

What was added 2026-08-12 is an **opt-in ageing schedule by bill age**:
`includeAgeing` buckets each bill reference by days between the date of the
voucher that raised it and a caller-named date. Both dates are Tally's, so
nothing is assumed — but the distinction has to survive into the output, because
a "60-90 days" bucket reads as overdue to anyone who did not compute it. So the
basis and the coverage bound are returned in the payload on every ageing call,
not only in a warning.

Four things about it are worth knowing before extending it:

- **Direction comes from the raising allocation, not the sign.** Tally encodes a
  debit negative, so an open receivable bill arrives negative and an open payable
  positive. The first implementation classified a negative net as "settled
  against an earlier bill", which would have reported *every open receivable* as
  a settlement. Each reference now takes its direction from its own `New Ref` (or
  `Advance`) allocation, and a net with that same sign is what remains
  outstanding. Covered by a regression test in tests/tools/v3.test.ts.
- **References are netted before bucketing.** Tally records an invoice as
  `New Ref` and each payment as `Agst Ref` on the same reference. Bucketing the
  allocations as they arrive counts a settled invoice at full value and again as
  a payment.
- **Coverage is period-bounded, and this is the part most likely to mislead.**
  Bills come from the vouchers in the requested period, so an invoice raised
  earlier cannot be aged — and an ageing question is usually about exactly those.
  A reference appearing with settlements but no raising allocation is that case,
  and it is counted as `settlementsAgainstEarlierBills` rather than aged from a
  payment date. A non-zero count there is direct evidence the schedule is
  incomplete.
- **Nothing is forced into a bucket.** Undated references, Tally's "On Account"
  allocations, and over-settled references are each counted separately.

**Live status, 2026-08-12: still unproven, and it is worth being blunt about
why.** The company probed records no bill references at all — 919
`BILLALLOCATIONS.LIST` blocks in a year of vouchers, **not one with a populated
`NAME`**, and no `BILLTYPE` value anywhere. Bill-wise accounting is switched off.
So the schedule came back empty for all 9 parties, which is the correct answer for
those books and tells us nothing about the netting, the sign rule or the buckets.
Those remain fixture-tested only. The first company that keeps bill-wise details
will be the first real exercise of this code.

Party groups are also configurable rather than hardcoded. The defaults are
Tally's built-in "Sundry Debtors" / "Sundry Creditors", but a company may file
parties elsewhere, so the groups used are echoed back and a group matching
nothing produces a warning rather than a silent empty result.

### GST field detection is approximate, and needed two corrections

GST fields are identified by name fragments, because which GST fields exist
depends on the company. Tally's field names are concatenated upper-case words
with no separators, which makes substring matching inherently imprecise. Two
false-positive classes were found against real data and both had shipped in the
first implementation:

- **`NUMBERINGSTYLE` contains "GST"** — numberin·**GST**·yle — and Tally sets it
  on every voucher. It is now denylisted. `CESS` was dropped as a hint for the
  same reason (`PROCESS` contains it), which means cess fields not named with
  "GST" are missed — a known, bounded gap preferred over false positives.
- **Company-level GST fields are stamped on every voucher.**
  `CMPGSTREGISTRATIONTYPE`, `CMPGSTSTATE` and `GSTREGISTRATION` describe the
  company, not the transaction. They are reported once as
  `companyGstRegistration` rather than making every bank payment look like a GST
  transaction.

Together these took `tally_get_gst (view: 'transactions')` from returning **all 30**
vouchers in a real month to **5** — the ones that actually carry
transaction-level GST detail.

Fields whose value is an explicit negative ("Not Applicable", "No", "0") are
also not treated as GST content, since Tally populates them on transactions
that have no GST at all.

### Feature detection observes data, not settings

`tally_get_company (includeFeatures: true)` infers each flag from evidence in the data,
because TallyPrime does not expose its F11 feature switches over this
interface. Each flag therefore carries the evidence behind it, and a feature
that is enabled but unused reads as not in use.

This needed correcting too: checking only party GSTINs reported `gst: false` for
a company holding 14 GST tax ledgers with duty heads. Three independent signals
are now reported — party GSTINs, party registration types, and GST tax ledgers —
because one narrow signal produced a confidently wrong answer.

### Built, but with a caveat worth knowing

**`tally_get_ledger_transactions` computes its running balance rather than
reading one.** The movements come from the voucher collection, filtered to the
ledger; the running balance and period closing balance are arithmetic done
here.

TallyPrime has a native per-ledger report, but its export ID is not documented
reliably enough to trust, and guessing wrong does not produce an error — it
raises a modal and can terminate the application (below). Deriving from a
verified report was the safer trade. Tally's own closing balance is returned as
`tallyReportedClosingBalance` for comparison, but it is as at Tally's current
period end rather than the requested range, so the two figures agree only when
the range spans the whole period. They are reported as separate fields for
exactly that reason.

If the native report ID is later confirmed against a real install, it can
replace the derivation without changing the output shape.

## Ground-truth samples: obtained 2026-08-10

Response *shapes* for TallyPrime's export API are not reliably documented in
public sources, so the parser deliberately waited for real ones rather than
encoding the same assumptions in both the fixtures and the code.

Samples were captured on 2026-08-10 from a live TallyPrime 7.x install with a
real company loaded. Redacted copies are in `tests/fixtures/`; the unredacted
originals stay in `samples/`, which is gitignored because it contains real
accounting data.

Waiting was the right call. Three of the findings below would each have
produced a working-looking parser that returned wrong numbers.

### Reports return parallel arrays, not records

The single most consequential finding. Trial balance, balance sheet and P&L do
**not** nest a name with its own amounts. They emit two parallel sibling
arrays directly under `<ENVELOPE>`:

```xml
<DSPACCNAME><DSPDISPNAME>Capital Account</DSPDISPNAME></DSPACCNAME>
<DSPACCINFO>...amounts...</DSPACCINFO>
<DSPACCNAME><DSPDISPNAME>Loans (Liability)</DSPDISPNAME></DSPACCNAME>
<DSPACCINFO>...amounts...</DSPACCINFO>
```

Nothing links a row's name to its figures except document order. A parser
built on a normal (non-order-preserving) XML mapping loses the association
entirely and reports one account's balance under another account's name — with
no error raised. `TallyResponseParser` preserves document order throughout and
pairs rows positionally for this reason.

Rows where a name has no following amount block do occur (headings and
subtotals). They are kept with null figures rather than dropped, because
dropping them shifts every subsequent row.

### Empty is not zero

`<DSPCLDRAMTA></DSPCLDRAMTA>` and `<CLOSINGBALANCE TYPE="Amount"></CLOSINGBALANCE>`
appear in real data alongside genuine `0.00` values, sometimes in the same
record. The parser reports empty as `null` and zero as zero. Collapsing them
would invent a balance the books never recorded.

This shows up routinely in statements over a short period. A P&L for a single
month with no trading activity returns every column empty except the groups
that moved — confirmed against the live install for July 2026, where only
Indirect Expenses carried a figure. Those nulls are Tally's own answer, not a
parse failure, and should be read as "Tally reported nothing here".

### Tally's sign convention

Debit columns arrive **negative** in the trial balance, and P&L expenses
arrive negative. This is preserved exactly, never corrected.

**Verified against TallyPrime's own on-screen trial balance** (1-Apr-26 to
28-Jul-26), row by row:

| Row | Tool | Tally screen |
|---|---|---|
| Capital Account | −1161289.87 / 100000 | 11,61,289.87 Dr / 1,00,000.00 Cr |
| Current Liabilities | −30029462.74 / 1262074.65 | 3,00,29,462.74 Dr / 12,62,074.65 Cr |
| Indirect Expenses | −33499048.5 / 0.36 | 3,34,99,048.50 Dr / 0.36 Cr |
| **Grand total** | **82,436,683.83** each side | **8,24,36,683.83** each side |

All 9 rows matched on both columns, with no row missing in either direction.
The columns also net to exactly 0.00.

**The magnitudes are identical; only the sign differs.** Tally's screen puts a
debit in a Debit column as a positive number, while the XML export reports it
negative. So a debit of `-1161289.87` from this server is the same figure the
user sees as `11,61,289.87` under Debit — not a negative balance. Tool
descriptions and the MCP prompts both say this explicitly, because reporting
the minus sign as though the balance were negative would contradict the
user's screen while being arithmetically faithful.

All 30 vouchers in the sampled month also sum to zero.

### Other confirmed shapes

- The P&L value block is `<PLAMT>`, but its main column inside is
  `<BSMAINAMT>` — Tally reuses the balance sheet tag rather than defining a
  P&L-specific one.
- The balance sheet wraps its name node one level deeper, in `<BSNAME>`.
- Every collection response opens with a `<CMPINFO>` block of record counters
  whose tags collide with the record tags themselves: `<LEDGER>0</LEDGER>`,
  `<VOUCHER>0</VOUCHER>`. A document-wide search finds a phantom empty record
  and shifts every index, so normalisation scopes to `<DATA>`.
- `&#4;` genuinely appears inside text (`<GSTCLASS>&#4; Not Applicable</GSTCLASS>`).
  The existing sanitiser handles it: 246 such references in a single
  month's voucher register.

## Constraints that will not go away

These are properties of TallyPrime, not gaps in this server.

### One request at a time

Tally's HTTP listener effectively serves a single request at a time.
Concurrent requests block, time out, or return truncated bodies. All outbound
traffic is therefore serialised through one queue.

**Consequence:** when Claude issues several tool calls in parallel, they
execute sequentially against Tally. Throughput is bounded by Tally, not by
this server.

### No server-side pagination

Tally returns the full result set for a query; it cannot return "page 2".
Pagination here is client-side slicing over a complete fetch.

**Consequence:** a small `pageSize` does not make a broad query cheap. Queries
whose result set exceeds `TALLY_MAX_RECORDS` (default 5,000) are refused with
`RESULT_LIMIT_EXCEEDED` rather than returned.

Note the limit is necessarily enforced **after** the fetch. Tally reports no
size in advance and cannot be asked for a count, so there is nothing to check
against beforehand — the guard protects the caller from an unusable wall of
records, not the machine from the fetch.

Narrowing the date range makes a **report** request smaller, but NOT a voucher one:
a collection ignores `SVFROMDATE`/`SVTODATE`, so the whole book arrives whatever
range is asked for, and the range is applied here. See "The `Voucher Register`
report returns no ledger entries at all" below.

### An audit is slow because one large voucher fetch is read by nine tools

Measured 2026-08-13, on the same live company.

Measured on the `Voucher Register` report, which was the request path at the time.
The path has since changed (see below) and the fetch is now 8.6MB / ~2.0s lean, or
18.3MB / ~5.0s with full field detail — but the SHAPE of the finding is unchanged and
is the point: the fetch dominates, so the only useful lever is how often it happens.

| Where the time goes on one voucher fetch | |
|---|---|
| TallyPrime producing the 21MB response (453 vouchers) | **7.8s — 87%** |
| Sanitising, parsing and normalising it here | 1.2s — 13% |

So there is no local optimisation that matters much: **the fetch itself is the
cost**, and Tally cannot filter or paginate server-side. What can be reduced is
how *often* it happens. Five tools read the same register — bank reconciliation,
outstanding, GST, inventory movements and the voucher list — and until now each
one re-parsed it even when the HTTP response came from cache.

Two changes:

- **The parsed records are cached, not just the raw response.** A repeat register
  request already cost 0ms on the wire, but 1,205ms to turn back into records
  every time. Keyed per client and per (company, period, allFields), so two
  servers or two tests in one process cannot see each other's data. Measured
  effect: bank reconciliation 1,179ms → **7ms**, GST 1,198ms → **26ms**, inventory
  movements 1,186ms → **2ms**.
- **`TALLY_CACHE_TTL_MS` raised from 20,000 to 300,000.** Twenty seconds is
  shorter than a person thinks for, so the cache lapsed between questions and each
  lapse cost the full 7.8s again. On a 9-question audit with 25s of thinking
  between questions: **64s of waiting became 12s, an 81% cut.**

Two consequences recorded deliberately:

- **Staleness is now possible for up to five minutes.** The server cannot write,
  so the only way to hit it is editing the books by hand mid-conversation. It is a
  chosen trade rather than an oversight, and it is why the envelope gained
  `data_fetched_at`: with a five-minute TTL, `as_of_timestamp` alone would date a
  figure by when the sentence was written rather than when the data was read,
  which in a workpaper is a false provenance claim. `data_fetched_at` reports the
  OLDEST contribution, since an answer is only as fresh as the stalest thing in it.
- **Input validation must not cost a fetch.** Rejecting a descending
  `ageingBuckets` list took **1,180ms**, because the ledger and voucher fetches
  happened before the check. Validation now runs first and the same rejection takes
  **1ms**. Worth checking for elsewhere: any guard placed after a fetch is a guard
  that charges 21MB for saying no.

**The lever that was pulled, and what it cost.** TallyPrime sent roughly 46KB per
voucher on the report path, the great majority of it empty scaffolding the parser
discarded. A custom `COLLECTION` over vouchers is now the request path — not as an
optimisation but because the report returns no ledger entries at all (see below), so
there was no correct alternative. It was reached by deliberate probing against a live
install rather than by guessing, since a malformed collection definition has been
observed to raise a modal and terminate TallyPrime with unsaved work (see below).

It made the fetch smaller and faster — 8.6MB / ~2.0s against 21MB / ~7.8s — but it
also **removed the date lever entirely**: a collection ignores the date range, so a
one-month question now costs exactly what a full-year question costs. Measured: April
alone (13 vouchers) returned all 453, byte for byte the same response.

### Half a full-detail payload was the same constants repeated

Measured 2026-08-13, after a user reported that auditing one company consumed
more than 20% of a model's context.

Where it was going, on a real company's financial year:

| Part of a full-detail voucher payload | Share |
|---|---|
| Fields holding an **identical value on every voucher** | **50.0%** |
| Entry-level field maps | 25.8% |
| Nested structures — inventory, bank, tax, the actual substance | 3.0% |
| Identity, ledger entries, amounts | 5.8% |

204 voucher-level fields were populated and **only 33 varied**. The other 171 —
`ISDELETED: "No"`, `AUDITED: "No"`, `USEFORSERVICETAX: "No"`,
`ISBOENOTAPPLICABLE: "No"` — held one value on all 453 vouchers. A page of 25
full-detail vouchers cost about **54,000 tokens**, half of it those constants sent
25 times over.

This is the "presence is not usage" finding again, in the place where the volume
actually is. `tally_get_company` had already split `distinguishingFields` from
`uniformFields` on ledgers for exactly this reason; nothing applied the same idea
to voucher payloads.

**What changed.** `foldUniformFields` ([../src/utils/uniformFields.ts](../src/utils/uniformFields.ts))
relocates any field identical across every record in a page to a single
response-level `uniformFields` (and `uniformEntryFields` for ledger entries,
which are a separate population). Applied to vouchers and to bank instruments.
Measured against the same live company: **25 full-detail vouchers fell from
~54,000 to ~19,600 tokens, 2.8x smaller.** Bank instruments fell ~17% and
inventory movements ~23% (30,318 to 23,461) — less, because their bulk is
genuinely varying data: long wire-transfer narrations, per-payment references, and
per-line quantities and rates.

**Extended to ledgers and stock items, 2026-08-13.** Full-field ledger requests
were already known to carry this problem — "companies do not share a field set"
below measured 115 fields populated on a 330-ledger company with only 36 varying
— but the fix had only been wired into vouchers, bank instruments and inventory
movements. Applying it to `tally_get_ledgers` and `tally_get_stock_items` turned
out to be the single largest win measured: **54 full-detail ledgers fell from
~37,700 to ~4,600 tokens, 8.2x smaller** — bigger than the voucher saving,
because a ledger's field-to-substance ratio is worse than a voucher's.

Full per-tool token and timing figures: [performance.md](performance.md).

Three rules keep it honest, each with a test:

- **A field is folded only when every record carries it with the same value.**
  Absent from even one record and it stays put: that absence is Tally reporting
  nothing there, and hoisting the field would assert a value the record never had.
- **Nothing folds below two records**, since with one record every field is
  trivially uniform and folding would empty it.
- **Folding is a relocation, not a filter.** Every value is still in the response,
  and each response carries a note saying where to look and warning that a
  constant is usually a TallyPrime default rather than company data. Silently
  dropping them would be a much worse change than the bloat.

The trade-off, stated plainly: a reader looking for one field now checks two
places. The note exists so that "not on the record" is never mistaken for "not
reported".

### The MCP client caps response size, and records are the wrong unit

Claude Desktop rejects a tool result over **1MB** — "Tool result is too large" —
and discards it. Claude never sees the data, so the user gets a failure with
nothing in it to act on, which is the least useful way for this to fail.

`TALLY_MAX_RECORDS` cannot prevent it, because it counts the wrong thing. A
single voucher carrying every field serialises to roughly **18 KB**, so:

| pageSize | Serialised | Records used, against a 5,000 ceiling |
|---|---|---|
| 25 | 0.43 MB | 0.5% |
| 50 | 0.85 MB | 1% |
| 100 (was the default) | **1.70 MB** | 2% |
| 500 | 8.52 MB | 10% |

So the default page of full-field vouchers was ~70% over the client's limit
while using 2% of the record ceiling. Two things address it:

- **A byte ceiling**, `TALLY_MAX_RESPONSE_BYTES`, checked in `runTool` — the one
  point every response passes through, so no tool can forget it. Breaching it
  returns `RESPONSE_TOO_LARGE` with a `pageSize` computed from the measured size,
  so a retry succeeds rather than starting a search. Verified live: a 400-row bank
  page was refused with "retry with pageSize 154 or lower", and 154 worked.

  **The default is 150,000, not 900,000 — changed 2026-08-13.** The original
  figure was headroom under Claude Desktop's 1MB message cap, which conflated two
  different budgets. The transport limit governs whether one message can be
  delivered; the **context** limit governs how many such messages fit in a
  conversation. At 900,000 a single legal response ran to roughly 225,000 tokens
  and could consume a fifth of a large context window on its own. 150,000 is about
  37,500 tokens: a substantial page, but no longer one that dominates the
  conversation it belongs to. Raise it deliberately for a one-off deep dive.
- **A smaller default page for field-heavy requests** (25 instead of 100), so
  the obvious request succeeds outright. An explicit `pageSize` is still
  honoured — a caller who names one gets a measured answer, not a silent
  substitution.

Responses are also serialised compactly rather than pretty-printed. Indentation
cost 15% on dense records and over 50% on field-heavy ones, spent entirely on
whitespace a model does not read.

### One company at a time

Tally's interface is built around "the currently loaded company", not clean
per-request scoping. It serves exactly one company, so this server cannot
switch between them or answer a question spanning several.

`company` is optional on every tool. When supplied, it is checked against the
loaded company list **before** any data request, and a mismatch fails with
`TALLY_COMPANY_NOT_LOADED` naming what is actually loaded.

The check is deliberately local rather than delegated to Tally. Sending
unverified names into Tally's request path is adjacent to the behaviour that
has already been observed to terminate the application, and a local check also
produces a better error — it can say what *is* open, which Tally cannot.

**Consequence:** analysing a different company requires opening it in
TallyPrime. Cross-company comparison is not possible in a single call, and no
amount of work on this server would change that.

### Companies do not share a field set

Which fields a record carries depends on what that company has enabled — GST,
payroll, inventory, cost centres, banking. There is no fixed schema to code
against.

This is handled by returning every populated field as an open map rather than
mapping a fixed list. The mechanism falls out of Tally's own behaviour: it
emits the full superset of elements on every record and leaves inapplicable
ones empty, so **discarding empty elements yields exactly the fields that
company uses.** The ~200 blank elements per voucher, initially just bloat,
turn out to be the feature.

Two caveats found against real data:

- **Presence is not usage.** Tally stamps many fields with a default on every
  record. On a 330-ledger company, 115 fields were populated but only 36
  varied between ledgers; the other 79 held one constant value. Reporting raw
  presence makes product defaults look like the company's most-used data, so
  `tally_get_company` splits the two.
- **Full ledger detail is expensive.** `<FETCH>*</FETCH>` returned 5.5 MB
  versus 148 KB for the curated field set — roughly 37x. It is opt-in for list
  calls. On vouchers there is no such tradeoff, since the full field set
  arrives either way.

### Malformed XML is normal

Real Tally exports contain raw control characters in narrations and party
names, encoding declarations that do not match the bytes sent, and unescaped
ampersands. These are repaired before parsing, and the repairs are reported in
each response's `warnings` so a malformed export stays visible rather than
being silently patched over.

### A malformed request can terminate TallyPrime

**The most dangerous behaviour found so far, and it has no error code.**

During sample collection, a request naming a collection it had not defined in
its own TDL block (`<ID>Ledgers</ID>` with no `<COLLECTION>` definition) did
not produce an error response. TallyPrime raised a **modal dialog on the
desktop** — `Error in TDL. 'Collection:Ledgers' Could not find description!` —
and stopped serving HTTP entirely. The request never returned. When the dialog
was dismissed, TallyPrime **exited**, taking the user's open books with it.

Consequences that shape the design:

- There is no response to parse. The client sees a timeout, then connection
  failures on every subsequent request. `TALLY_TIMEOUT` is reported for what is
  actually a wedged or dead Tally.
- One bad request poisons the whole session, including requests that would
  otherwise have succeeded.
- This cannot be handled at runtime. By the time anything is observable, the
  user's Tally is already blocked or gone.

The only real mitigation is never to send such a request. `requests.ts` always
emits a full `<COLLECTION>` definition alongside the collection name it
references, and report IDs are limited to ones confirmed against a real
install. Any new report or collection must be verified the same way rather than
guessed at — a wrong ID here is not a failed query, it is a closed application.

### The TallyPrime version and licence type cannot be read

Build Specification v1.0 §6 rule 8 requires this server to **refuse the
Educational version of TallyPrime outright**, on the grounds that it silently
corrupts data on import. That check is **not implemented**, because nothing in
the verified request surface exposes the licence.

What `tally_connection_status` reports is *this server's* version, from
`package.json`. It reports nothing about TallyPrime itself — not the release,
not the edition, not the serial. The name of the field (`serverVersion`) is
accurate, but it is easy to read as Tally's version and it is not.

Two options were considered and rejected:

- **Guess a report ID and ship it.** A licence check that reports "not
  Educational" on evidence it never had is worse than no check: it converts an
  admitted gap into a false assurance, in exactly the place a false assurance
  does the most damage. This is §6 rule 10.
- **Send a custom TDL block to call `$$LicenseInfo`.** This is a third request
  shape, unlike anything in `requests.ts`, and unverified. Given the section
  above — a malformed request can close TallyPrime and take the user's unsaved
  work with it — inventing a new request shape and putting it in the connection
  path, which runs whenever anyone is troubleshooting, is the worst possible
  place to experiment.

What exists instead is `npm run probe:reports`
([scripts/probe-reports.ts](../scripts/probe-reports.ts)), a one-off diagnostic
that tries candidate report IDs against a live install using the safe method in
[report-id-verification.md](report-id-verification.md) — named reports only,
one at a time, a health probe between each, controls at both ends, and an abort
the moment Tally stops answering. It refuses to run without explicit
acknowledgement that unsaved work is at risk.

**Until a candidate is confirmed, this connector cannot tell which edition of
TallyPrime it is talking to, and §6 rule 8 is unmet.** That should be stated
plainly to anyone relying on the rule rather than left to be assumed.

### The day book ignores the requested date range

`DayBook` returned **3 vouchers for a five-year range**, while
`Voucher Register` returned **30 for a single month** of that same range. The
day book appears to ignore `SVFROMDATE`/`SVTODATE` and use Tally's own current
period instead.

Until this is understood, `tally_get_day_book` cannot be trusted to honour its
date parameters.

`Voucher Register` is no longer used either, for a worse reason — see below.

### The `Voucher Register` report returns no ledger entries at all

Verified live 2026-08-13 against TallyPrime, 453 vouchers. The report returns
voucher **headers only**: ~28 KB per voucher across 246 distinct tags, almost
all empty, and **zero** `ALLLEDGERENTRIES.LIST`, `LEDGERNAME` or `AMOUNT`
elements. `EXPLODEFLAG=Yes` does not change this.

Every voucher therefore parsed with `entries: []`, which silently zeroed every
figure derived from movements. `tally_check_tie_out` reported 34 balance
exceptions and **0 vouchers checked** against books that in fact balance to the
paisa — the failure mode a control is supposed to catch, produced by the control
itself.

**The fix, and the trap inside it.** Entries come back only from a `Collection`
over `Voucher` that names the entry lists explicitly in `FETCH`
(`AllLedgerEntries`, `AllInventoryEntries`). `<FETCH>*</FETCH>` is NOT
sufficient and is actively misleading: it returns 10.9 MB of every scalar Tally
holds and still omits the entries, so the most complete-looking request
available is exactly as useless as the report. Measured on the same company: `*`
gave 0 entries, the explicit list gave 907 ledger entries and 466 inventory
entries.

**The cost.** A collection ignores `SVFROMDATE`/`SVTODATE`. Asked for April 2025
alone (13 vouchers) it returned all 453 spanning the full year. So the whole book
is fetched and dates are filtered client-side, and no parameter on a voucher tool
makes the Tally-side query cheaper. Accepted, because the alternative shapes
return no entries and therefore no correct answer.

### Invoice vouchers carry the party entry twice, in two different lists

`ALLLEDGERENTRIES.LIST` and `LEDGERENTRIES.LIST` are **alternatives, not
halves**. An invoice carries both, with `LEDGERENTRIES.LIST` repeating the party
entry `ALLLEDGERENTRIES.LIST` already holds — verified live on `ACME/INV/01`,
which has 2 of the former and 1 of the latter for a 2-line sale.

Reading both and concatenating counted the party twice and reported 29 of 453
vouchers as failing double entry on books that balance. `ALLLEDGERENTRIES.LIST`
therefore wins wherever present, and `LEDGERENTRIES.LIST` is only a fallback for
voucher types that carry solely the latter.

### Two ledgers can never satisfy a balance roll-forward

`Stock In Hand` and `Profit & Loss A/c` have closing balances TallyPrime
**derives** rather than posts, so opening plus movements cannot reconcile to them
by construction. Verified live: `Stock In Hand` closed at 304,588 against an
opening of 207,968 with **zero** ledger postings in the year — its value comes
from inventory valuation. `Profit & Loss A/c` is reported as nil at both ends
while its real figure accumulates from the revenue and expense accounts.

`tally_check_tie_out` reports both as `notCheckable` rather than as exceptions. A
blocking control that cries wolf gets ignored, and "this test does not apply
here" is a different statement from "these books are out".

### The currency label is the company's own, and is a symbol rather than a code

Every monetary figure used to be labelled `INR`, because `DEFAULT_CURRENCY` was
hard-coded and nothing ever overrode it. Found live 2026-08-13 on a **US company**
keeping books in dollars: `$494,397.50` came back as
`{"amount":"494397.5","currency":"INR"}`.

Nothing was converted — the arithmetic was right and only the label lied — which
is the more dangerous failure, because a plausible label is believed. §6 rule 1
says this server does not invent figures; inventing the unit a figure is
denominated in is the same offence.

The base currency now comes from `CurrencyName` on the company collection and is
threaded to every place a `Money` is built. Two things to know:

- **It is a SYMBOL, not an ISO code.** Tally returns `$`, or `₹` / `Rs.` on an
  Indian company — never `USD`. Do not treat it as a currency code, and do not
  assume two companies with different symbols use different currencies.
- **`BaseCurrencySymbol` and `BaseCurrencyFormalName` are not served** on this
  collection. Tally silently omitted them rather than erroring, so an unsupported
  native method here fails open: a missing field means "not served", never "not
  set".

`readMoney` takes the currency as a REQUIRED parameter so the compiler, not a
reviewer, guarantees no construction site falls back to the default silently. When
Tally reports no currency the default still applies, without a warning — on an
Indian company INR is correct, and a warning on every figure would be noise.

**Not yet handled: per-transaction foreign currency.** Tally supports a voucher
denominated in a currency other than the company's base, and this server does not
read that field — such an entry is labelled with the base currency. No conversion
is attempted anywhere, so amounts are never wrong, but a multi-currency company
would see a foreign-currency entry mislabelled. Unverified against real
multi-currency data.

### Foreign currency per transaction is not distinguished - and now says so

Probed live 2026-08-13 and the answer is definite: **TallyPrime sends no
per-transaction currency over this interface.** Searching the full `FETCH *` voucher
response for any element matching CURRENC / FOREX / EXCHANGE / RATEOFEXCH returned
only `CURRENCY` (the CMPINFO counter, value `0`), `EXCHANGEACTIVITYID` (`0`) and
`ISVCHEXCHANGED` (`No`). No voucher and no ledger entry carries a currency name.

So a transaction recorded in a currency other than the company's base cannot be told
apart from a base-currency one, and every figure is labelled with the base currency.
Nothing is ever converted, so no amount is wrong - but on a multi-currency company a
LABEL could be.

Guessing at a field name to "handle" this is precisely what this project does not do.
What it does instead is **detect the risk and disclose it**: the `Currency` collection
lists what a company defines (verified live - 1.7KB, and this company defines exactly
one, `$` / "Dollar" / 2 decimal places), and where MORE THAN ONE currency is defined
every affected response carries a warning naming them and stating that a
foreign-currency transaction may be mislabelled. On a single-currency company there is
no warning, because there would be nothing to warn about and a warning on every figure
trains the reader to ignore warnings.

`IsBaseCurrency` is requested on that collection and silently omitted by Tally - the
same fail-open behaviour as `BaseCurrencySymbol` on the company collection. The base
currency therefore comes from the company's own `CurrencyName`.

**Still unverified:** the warning path itself has never met a genuinely
multi-currency company. It is unit-tested against a two-currency response; if such a
company turns up, check that the caveat appears and that the figures are what Tally
shows.

### `ALTERID` as a cache validator - measured, NOT adopted

The largest remaining speed-up, deliberately left unbuilt until it can be proven.

If the maximum `ALTERID` reliably increases on every edit, a small request can prove
a cached parse is still valid. Measured live 2026-08-13, a collection over `Voucher`
fetching only `AlterId,MasterId`: **537.6KB in 199-274ms**, against 8.6MB in ~2,000ms
for the full fetch - roughly 16x smaller and 10x faster. On this company the maximum
`ALTERID` is 989 across 453 vouchers, each distinct. So the mechanism is cheap and the
data is there.

It is not wired in because **the saving is worthless if the assumption is wrong**. If
`ALTERID` fails to move on any kind of edit - a DELETION being the obvious candidate,
since a deleted voucher may simply stop being returned - then a validated cache would
serve stale figures and report them as current. That is strictly worse than the honest
five-minute expiry in place today: an accountant would see a balance that has since
changed, with nothing indicating it.

Proving it requires someone to alter, add and delete a voucher in a real company,
which no automated test can do. `scripts/probe-alterid.mjs` does the measuring and
reports MOVED or UNCHANGED for each; all three must MOVE before any of this is built.
The request shape lives in `src/tally/requests.ts` as `buildVoucherAlterIdRequest` so
the Export-only guarantee covers it, and no tool calls it.

### A summary grouped by month nets to nil in every month

Not a defect, and it caught me out while building `tally_summarise_movements`, so it
is written down.

The tool groups ledger ENTRIES, because a voucher has no single amount — its entries
net to zero by construction, so totalling vouchers would mean choosing which leg
counts as "the transaction", which is the reader's judgement. Grouping entries has a
valuable consequence: an unfiltered summary must net to **exactly zero** across all
groups, which is double entry proven at aggregate level through a different code path
from `tally_check_tie_out`. It is reported as `allGroupsNetToZero`.

The flip side is that a bare `groupBy: 'month'` gives twelve months of zero, because
both legs of each transaction fall in the same month. That looks like a finding and is
actually arithmetic. To total ONE side, restrict the entries: `ledger: "Sales"` with
`groupBy: "month"`.

The first implementation restricted whole VOUCHERS instead of entries, which produced
exactly those twelve zeroes for "sales by month". Both behaviours are now stated in the
tool description, and the entry-level restriction is what `ledger` does.

**Sign, for the avoidance of doubt:** `net` is credit − debit, so a DEBIT net is
negative — the same convention TallyPrime uses for a ledger's closing balance. Verified
against the master: the sales ledger summarises to 412,276.25 and Tally reports the
same ledger's closing balance as 412,276.25. The first implementation negated it, which
was arithmetically consistent and the opposite of what the accountant sees.

### Tally emits numeric character references, and they must be decoded

`fast-xml-parser` decodes named entities (`&amp;`, `&quot;`) but leaves numeric
ones (`&#13;`, `&#10;`) alone, and Tally uses numeric ones heavily in free text.
Before this was handled, a real bank narration reached the reader as:

```
...AR 24906415108227233530943&#13;&#10;RECURRING CKCD 5968...
```

Two consequences, the second worse than the first: the accountant read six literal
escape characters where the statement has a line break, and narration SEARCH could
not match any phrase spanning that break — so a search silently missed vouchers
that do contain the phrase. Decoding happens in `textOf`, the single place all
text is read, and references to characters XML forbids are dropped rather than
decoded (the sanitiser has already removed 603 of them on one real company).

### Exploded vouchers are enormous relative to their content

With `EXPLODEFLAG=Yes`, 30 vouchers produced 1.55 MB — roughly 50 KB each,
of which ~95% is empty scaffolding: around 200 empty date and tax elements per
voucher, plus legacy cash-denomination counters for the demonetised ₹2000 note.

`TALLY_MAX_RECORDS` (default 5,000) is therefore the wrong unit for vouchers:
5,000 exploded vouchers would be on the order of 250 MB held in memory. A
record count is not a size bound — the same observation that later showed up as
oversized *responses*, and the reason `TALLY_MAX_RESPONSE_BYTES` exists
alongside it. See "The MCP client caps response size" above.

A five-year exploded voucher request also timed out at 120 s where a one-month
request completed in seconds, so date range — not record count — is the
practical lever.

### JSON is unavailable in practice

Native JSON data exchange became a default product feature in TallyPrime 7.0
(released 19 December 2025).

**Tested against the live 7.x install on 2026-08-10: it does not work.**
Requesting `<SVEXPORTFORMAT>$$SysName:JSON</SVEXPORTFORMAT>` returned XML —
byte-for-byte identical to the XML request's response, same 2,733 bytes.

`TALLY_PREFERRED_FORMAT=json` is consequently a no-op on this build. The
per-request XML fallback works as designed, so nothing breaks, but nothing is
gained either. XML is the real retrieval path.

## Expected `TALLY_UNSUPPORTED_OPERATION` candidates

Not yet confirmed, but flagged during research as likely to lack a reliable
export path:

- `tally_get_statement (statement: 'cash_flow')`
- `tally_get_statement (statement: 'fund_flow')`
- `tally_get_gst (view: 'summary')` / `tally_get_gst (view: 'transactions')` (detail level)

Per the fallback policy, these will be registered and will return
`TALLY_UNSUPPORTED_OPERATION` with an explanation if no reliable path exists,
rather than being silently omitted. This section will be updated with the
actual outcome once each is attempted against real Tally.

## Out of scope by design

This server returns data. It does not decide what is suspicious.

There is no audit engine, no fraud-detection rule, and no hardcoded threshold
anywhere in the codebase. What counts as unusual depends on the business, the
period and the question being asked — that judgement belongs to Claude and the
user, informed by data, not to a constant compiled into a tool.
