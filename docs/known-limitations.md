# Known limitations

A living record of what this server cannot do, and why. Kept honest
deliberately: a tool that quietly returns partial data is worse than one that
says it cannot help.

> For **how much is done** rather than why it behaves as it does, see
> [project-status.md](project-status.md).

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

| Component | Why |
|---|---|
| Inventory tools | The verification company holds zero stock items, so a populated inventory response has never been seen |
| Sales / purchase retrieval | The sampled month contained only Payment, Journal and Receipt vouchers |

Both are fixture-tested and designed to degrade honestly; they resolve the
first time the server meets a company that keeps stock or records sales.

### Deliberately not built

| Component | Why |
|---|---|
| `tally_get_day_book` | Will not be built as specified; see "the day book ignores the requested date range" below |
| `tally_get_cash_flow`, `tally_get_fund_flow` | Registered but deliberately unimplemented — see below |

### Deliberately unimplemented: cash flow and fund flow

Both are registered and always return `TALLY_UNSUPPORTED_OPERATION` with an
explanation and a redirection, following the fallback policy: a silently absent
tool leaves Claude guessing at something that does not exist.

Two independent reasons:

- **The classification is a judgement.** A cash flow statement is not a list of
  bank movements; it is those movements classified as operating, investing or
  financing. That depends on the business, and this server holds no business
  rules. Fund flow needs the same call about sources versus applications.
- **The native report path is unverified**, and probing it is dangerous for the
  reason documented above — an unresolvable report ID can terminate TallyPrime.

The underlying movement data is available via `tally_get_ledger_transactions`
and `tally_get_balance_sheet`, and the error says so.

### Inventory tools are unverified against real stock

The stock item request uses the same collection form proven safe for ledgers
and returns HTTP 200, but the only company available for verification holds
**zero stock items** — the response is CMPINFO counters with no `<DATA>`
section at all.

Rather than invent a field mapping and present it as verified, the stock item
normaliser promotes only `name` and `parent` and returns everything else
through the generic field extraction. The output is therefore whatever Tally
sends, correct regardless of shape, at the cost of the caller reading Tally's
own field names. Every inventory tool description states this.

`tally_get_inventory_movements` is derived from the inventory allocations nested
on vouchers rather than a stock movement report, for the same report-ID safety
reason. Quantities are returned exactly as Tally recorded them, unit included
("100 nos"), and never summed or unit-converted — conversion needs the item's
conversion factors, and getting that silently wrong would be worse than not
doing it.

### Receivables and payables compute no ageing

Ageing needs a due date per bill, and that depends on credit terms which may be
recorded per party, per bill, or not at all. Where Tally reports a bill's due
date it is passed through; where it does not, the field is simply absent.
Deriving one from an invoice date plus an assumed credit period would produce an
authoritative-looking bucket that is invented.

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

Together these took `tally_get_gst_transactions` from returning **all 30**
vouchers in a real month to **5** — the ones that actually carry
transaction-level GST detail.

Fields whose value is an explicit negative ("Not Applicable", "No", "0") are
also not treated as GST content, since Tally populates them on transactions
that have no GST at all.

### Feature detection observes data, not settings

`tally_get_company_features` infers each flag from evidence in the data,
because TallyPrime does not expose its F11 feature switches over this
interface. Each flag therefore carries the evidence behind it, and a feature
that is enabled but unused reads as not in use.

This needed correcting too: checking only party GSTINs reported `gst: false` for
a company holding 14 GST tax ledgers with duty heads. Three independent signals
are now reported — party GSTINs, party registration types, and GST tax ledgers —
because one narrow signal produced a confidently wrong answer.

### Built, but with a caveat worth knowing

**`tally_get_ledger_transactions` computes its running balance rather than
reading one.** The movements come from `Voucher Register`, filtered to the
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
records, not the machine from the fetch. Narrowing the date range is the only
thing that makes the underlying request smaller.

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

### The day book ignores the requested date range

`DayBook` returned **3 vouchers for a five-year range**, while
`Voucher Register` returned **30 for a single month** of that same range. The
day book appears to ignore `SVFROMDATE`/`SVTODATE` and use Tally's own current
period instead.

Until this is understood, `tally_get_day_book` cannot be trusted to honour its
date parameters, and `Voucher Register` is the reliable path for
date-scoped voucher queries.

### Exploded vouchers are enormous relative to their content

With `EXPLODEFLAG=Yes`, 30 vouchers produced 1.55 MB — roughly 50 KB each,
of which ~95% is empty scaffolding: around 200 empty date and tax elements per
voucher, plus legacy cash-denomination counters for the demonetised ₹2000 note.

`TALLY_MAX_RECORDS` (default 5,000) is therefore the wrong unit for vouchers:
5,000 exploded vouchers would be on the order of 250 MB held in memory. A
record count is not a size bound.

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

- `tally_get_cash_flow`
- `tally_get_fund_flow`
- `tally_get_gst_summary` / `tally_get_gst_transactions` (detail level)

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
