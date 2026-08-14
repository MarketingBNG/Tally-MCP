# Performance: what each tool costs

Measured, not estimated. Every figure here comes from a live TallyPrime install
holding **the second live company (a US LLC, FY 25-26)** — 453 vouchers over a full financial year, 26
voucher types, 54 ledgers, one bank ledger — on 2026-08-13, against `dist/`
(the artefact Claude Desktop launches).

> **Re-measured 2026-08-13 (later the same day)** after the voucher retrieval path
> changed. The old path used Tally's `Voucher Register` report, which returned
> voucher headers with **no ledger entries at all** — so most figures derived from
> it were empty or wrong (see
> [known-limitations.md](known-limitations.md#the-voucher-register-report-returns-no-ledger-entries-at-all)).
> The correct path is a `Voucher` collection, and it is both **more complete and
> cheaper**: 8.6MB / ~2.0s where the register was 21MB / ~7.8s. One consequence
> reverses this file's old advice — see [Making it faster](#making-it-faster).

Re-measure with `npm run check:live` for correctness, or the method in
[Reproducing](#reproducing) for these numbers specifically.

Token figures are the serialised response divided by 4, which is a consistent
approximation rather than a tokeniser count. Use them for comparison between
calls, not as a billing prediction.

> Why this file exists: a user reported that auditing one company consumed more
> than 20% of a session and took too long. Both turned out to be measurable and
> largely fixable, and the fixes are only defensible if the numbers behind them
> are written down.

---

## The one thing to understand

**There are two speeds, and the boundary is whether a tool reads the vouchers.**

| | Cost |
|---|---|
| Masters and statements — ledgers, groups, voucher types, trial balance, P&L, balance sheet, cash flow, stock masters, GST setup | **10–60ms**, 200–4,000 tokens |
| Anything reading vouchers | **~3 seconds on the first call** (~8s for full detail), then **1–30ms** for the next five minutes |

The voucher fetch is **8.6MB and about 2.0 seconds** of TallyPrime's own time, or
**18.3MB / ~5.0s** when full field detail is requested. Almost all of the wall
clock is TallyPrime's, so no local optimisation changes the first call much. What
matters is that the first voucher question of a session pays it and the next
fifteen do not.

Nine tools read the vouchers: vouchers, bank reconciliation, outstanding, GST
transactions, inventory movements, ledger transactions, party statement, search,
and tie-out.

**The fetch is the whole book, every time.** A collection ignores
`SVFROMDATE`/`SVTODATE`: asked for April alone (13 vouchers) TallyPrime returned all
453 spanning the year, byte for byte the same response. Dates are therefore applied
here, after the fetch. That is why the date range no longer makes the underlying
query cheaper, and it is the one place where this path is worse than the register it
replaced — accepted, because the register returned no entries and so could not
answer the question at all.

---

## Re-measured after the one-fetch change, 2026-08-13

The nested structures (bank allocations, bill allocations, inventory lines, tax
breakdowns) turn out to arrive in the ORDINARY curated request. Verified: the lean
8.6MB response and the 18.3MB `FETCH *` response contain identical numbers of them
— 948 bank allocations, 977 bill allocations, 466 inventory lines, 1,032 rate
details. The 10MB difference is scalar fields only.

Four tools were paying that 10MB to reach data they already had, because one flag
controlled both "keep the nested structures" and "keep every scalar field". Splitting
them:

| Tool | Before | After |
|---|---|---|
| `tally_get_outstanding` | 7.7s | **2.6s** |
| `tally_get_bank_reconciliation` | 6.2s | **3.0s** |
| `tally_get_outstanding` `includeAgeing` | 6.1s | **2.6s** |
| `tally_get_inventory_movements` | 5.8s | **2.6s** |

They also now share one Tally fetch with the lean tools instead of forcing a second
one: in a single session, a tie-out followed by a bank reconciliation costs 2.5s then
0.4s, where the second call used to pay ~5s of its own.

The parsed-record cache bound rose from 3 to 6 entries as a direct consequence —
there are now three parse shapes per period rather than two, and three entries would
thrash inside one period.

### Token cost of the tool list itself

Measured over stdio, which is what a client actually receives: **19 tools, 72,065
characters, ~18,000 tokens** — paid on every session before a single question is
asked, and larger than any individual response. Descriptions are 41,763 characters of
that and schemas 28,559.

Trimming the evidence out of the descriptions (the measurements and "verified live"
proofs, which belong in this file and in known-limitations.md) and shortening the four
shared notices repeated in all 19 tools took roughly 3,500 tokens off. The behavioural
RULES were kept verbatim and are asserted present by a check over the built tool list —
cutting a rule to save tokens would trade a token bill for a wrong answer.

## Per-tool reference

`Cold` means caching disabled, so the tool pays for its own fetch — the first
question of a session, or any question after the cache lapses. `Cached` means the
same period is already loaded, which is every subsequent question about it within
`TALLY_CACHE_TTL_MS` (default 5 minutes).

| Tool | Typical question | Tokens | Cold | Cached |
|---|---|---|---|---|
| `tally_connection_status` | is Tally reachable | ~35 | 41ms | 0ms |
| `tally_list_companies` | which company is open | ~268 | 21ms | 1ms |
| `tally_get_company` | orient on a new company | ~1,288 | 293ms | 48ms |
| `tally_get_company` `includeFeatures` | which features are in use | ~1,670 | 313ms | 53ms |
| `tally_get_voucher_types` | what transaction types exist | ~1,573 | 95ms | 8ms |
| `tally_get_groups` | chart of accounts hierarchy | ~1,647 | 60ms | 2ms |
| `tally_get_ledgers` | accounts with balances | ~3,953 | 89ms | 4ms |
| `tally_get_statement` `trial_balance` | trial balance | ~534 | 88ms | 0ms |
| `tally_get_statement` `balance_sheet` | balance sheet | ~451 | 81ms | 0ms |
| `tally_get_statement` `profit_loss` | profit and loss | ~492 | 74ms | 1ms |
| `tally_get_statement` `cash_flow` | monthly cash movement | ~754 | 78ms | 1ms |
| `tally_get_stock_items` | inventory masters | ~964 | 46ms | 2ms |
| `tally_get_closing_stock` `by:'item'` | closing stock per item | ~1,326 | 121ms | 1ms |
| `tally_get_closing_stock` `by:'godown'` | stock per location | ~765 | 80ms | 1ms |
| `tally_get_gst` `summary` | GST setup | ~409 | 257ms | 44ms |
| `tally_calculate_materiality` | thresholds | ~207 | 13ms | 1ms |
| **↓ these read vouchers — lean fetch, 8.6MB, shared cache entry ↓** | | | | |
| `tally_summarise_movements` (by voucherType) | totals per type | ~543 | 2.4s | 2ms |
| `tally_check_tie_out` | do the books tie | ~3,151 | 2.4s | 5ms |
| `tally_get_vouchers` (100, lean) | list transactions | ~16,939 | 2.3s | 0ms |
| `tally_get_ledger_transactions` | one ledger statement | ~10,829 | 2.6s | 3ms |
| `tally_summarise_movements` (by ledger) | totals per account | ~2,139 | 2.4s | 2ms |
| **↓ these need the nested structures — same 8.6MB fetch, separate parse ↓** | | | | |
| `tally_get_outstanding` | who owes us | ~866 | 2.6s | 2ms |
| `tally_get_outstanding` `includeAgeing` | who owes us, aged | ~995 | 2.6s | 2ms |
| `tally_get_inventory_movements` (50) | stock movements | ~17,706 | 2.6s | 1ms |
| `tally_get_bank_reconciliation` (100) | bank items and status | ~20,575 | 3.0s | 2ms |
| **↓ these still need every scalar field — full fetch, 18.3MB ↓** | | | | |
| `tally_get_party_statement` | one party, everything | ~1,830 | 5.6s | 14ms |
| `tally_search` | cross-entity search | ~2,621 | 5.8s | 13ms |
| `tally_get_vouchers` (25, full detail) | investigate transactions | ~18,777 | 6.0s | 4ms |
| `tally_get_gst` `transactions` | GST transactions | ~1,193 | 6.2s | 37ms |
| `tally_get_ledgers` `includeAllFields`, all 54 | full-detail ledger listing | ~4,760 | 242ms | 49ms |
| `tally_get_stock_items` `includeAllFields`, all 3 | full-detail stock listing | ~1,390 | 62ms | 1ms |

**`tally_get_closing_stock` (added 2026-08-14) is a masters-speed call** — it reads
a report rather than the vouchers, so it never touches the 8.6MB fetch. Measured
2026-08-14 on a company with 10 stock items in 1 godown.

**A caveat on those two rows, because it generalises.** 10 item rows cost ~1,326
tokens and 1 godown row costs ~765, which is about 62 tokens per row on roughly
**700 tokens of fixed envelope** — and most of that fixed part is *warnings*. This
company's currency symbol cannot be transported by TallyPrime, so every response
carries the explanation of that plus the multi-currency caveat. That is the
deliberate cost of not passing `"currency": "?"` off as a currency, but it means
**warning text, not row data, dominates a small response**. Worth knowing before
reading a low row count as a low cost, and worth revisiting if a company ever
accumulates enough simultaneous caveats to crowd out the answer.

**`tally_summarise_movements` is the cheapest way to answer a "how much" question.**
Totals by month cost ~1,061 tokens against ~16,939 for the voucher list that would
otherwise have to be read and added up — 16x smaller, and the arithmetic is exact
Decimal rather than the model summing rows.

**The tier split is worth reading.** Tools that only need ledger
entries pay the lean 8.6MB fetch (~2.4s); tools that need the structures nested
*inside* an entry — bank instruments, bill allocations, GST breakdowns, inventory
lines — pay the full 18.3MB fetch (~5.6–7.7s). They are separate cache entries, so a
session that asks both pays both once.

**A realistic 9-question audit** of a full financial year — orient, trial balance,
ledgers, tie-out, list vouchers, one party, receivables, one ledger statement, bank
reconciliation: **~60,000 tokens, and about 9 seconds of waiting** (one lean fetch
plus one full fetch; everything else is cache hits and masters).

Running literally all 27 calls above: **~116,000 tokens, 59s cold**, under a second
once both fetches are cached.

### Fixed overhead

**~12,037 tokens of tool descriptions**, sent on every request before any data.
Largest contributors: `tally_get_statement` (~2,123, inflated by the end-date
warning), `tally_get_bank_reconciliation` (~1,030), `tally_get_outstanding`
(~1,002), `tally_get_vouchers` (~899).

### Ceilings

| Setting | Default | Meaning |
|---|---|---|
| `TALLY_MAX_RESPONSE_BYTES` | 150,000 | ~37,500 tokens maximum per call. Breaching it returns `RESPONSE_TOO_LARGE` naming a `pageSize` that fits |
| `TALLY_MAX_RECORDS` | 5,000 | Record ceiling. Counts the wrong thing for size — see [known-limitations.md](known-limitations.md) |
| `TALLY_CACHE_TTL_MS` | 300,000 | How long a response and its parsed records are reused |

---

## What was changed, and what it bought

All four changes are measured against the same company.

### Uniform-field folding — token cost

TallyPrime stamps every field it supports onto every record. On this company's
full year, **204 voucher-level fields were populated and only 33 varied**; the
other 171 held one identical value on all 453 vouchers (`ISDELETED: "No"`,
`AUDITED: "No"`, `USEFORSERVICETAX: "No"`). Half of every full-detail payload was
those constants repeated.

Fields identical across every record in a page are now reported once as
`uniformFields` (and `uniformEntryFields` for ledger entries) rather than on each
record. It is a **relocation, not a filter** — see
[known-limitations.md](known-limitations.md#half-a-full-detail-payload-was-the-same-constants-repeated)
for the three rules that keep it honest.

| Call | Before | After | |
|---|---|---|---|
| 25 vouchers, full detail | 54,255 | **19,577** | 2.8× smaller |
| Bank reconciliation, 100 | 24,322 | **20,083** | −17% |
| Inventory movements, 50 | 30,318 | **23,461** | −23% |
| All ledgers, full detail (54) | 37,687 | **4,608** | **8.2× smaller** |
| All stock items, full detail (3) | 1,550 | 1,227 | −21% |

Ledgers were the largest hidden cost of the four — bigger than a full-detail
voucher page — because full-field ledger requests are already documented
elsewhere in this codebase as carrying "115 fields populated, only 36 varying"
(see [known-limitations.md](known-limitations.md#companies-do-not-share-a-field-set)),
but folding had only been applied to vouchers, bank instruments and inventory
movements. Applied here 2026-08-13.

Bank and inventory gain less because their bulk is genuinely varying data — long
wire-transfer narrations, per-payment references, per-line quantities and rates.

### Response ceiling — token cost

Was 900,000 bytes, chosen as headroom under Claude Desktop's 1MB *message* cap.
That conflated transport budget with context budget: a 900KB response is roughly
**225,000 tokens**, so one legal call could consume a fifth of a large window.
Now 150,000 (~37,500 tokens).

The recovery path is verified live: a 400-row bank page was refused with *"retry
with pageSize 154 or lower"*, and 154 returned 154 instruments.

### Parsed-record caching — time

`TallyClient` already cached the raw HTTP response, so a repeat register request
cost 0ms on the wire. It did **not** cache the result of turning 21MB of XML into
records, which measured **1,205ms every single time**. On one audit the register
was parsed five times over for five different questions.

| Tool | Before (warm) | After (warm) |
|---|---|---|
| `tally_get_bank_reconciliation` | 1,179ms | **7ms** |
| `tally_get_gst` transactions | 1,198ms | **26ms** |
| `tally_get_inventory_movements` | 1,186ms | **2ms** |

Keyed per client and per (company, period, allFields), holding at most three
entries — one was not enough, because alternating between two periods evicted
each to load the other.

### Cache TTL — time

Raised from 20,000ms to 300,000ms. Twenty seconds is shorter than a person thinks
for, so the cache lapsed between questions and each lapse paid the full ~8s again.

| 9-question audit, 25s thinking between questions | Waiting |
|---|---|
| 20s TTL | **64s** |
| 5m TTL | **12s** — an 81% cut |

The trade-off, chosen rather than stumbled into: an edit made in TallyPrime
*while* a conversation is running may not be seen for up to five minutes. The
server cannot write, so the only way to hit it is editing the books by hand
mid-audit. This is why the envelope carries `data_fetched_at` separately from
`as_of_timestamp` — with a five-minute TTL, dating a figure by when the sentence
was written rather than when the data was read would be a false provenance claim
in a workpaper.

### Validation before fetching — time

Rejecting a descending `ageingBuckets` list took **1,180ms**, because the ledger
and voucher fetches ran before the check. It now takes **1ms**. Worth checking
elsewhere: a guard placed after a fetch charges 21MB for saying no.

---

## Documented changes

Two rounds of changes, both preserved here since the numbers above depend on them.

**Round 1 — 2026-08-13, initial optimisation pass.** Reported: auditing one
company used over 20% of a session and took too long.

- Uniform-field folding on vouchers and bank instruments.
- Response ceiling 900,000 → 150,000 bytes.
- Parsed-record caching (not just the raw HTTP response).
- Cache TTL 20,000ms → 300,000ms.
- Validation moved before fetching.
- Added `data_fetched_at` to the envelope, distinct from `as_of_timestamp`, so a
  cached figure is never mis-dated once the TTL is long enough to matter.

**Round 2 — 2026-08-13, same day, checking for the same pattern elsewhere.**
Prompted by "can we reduce it more without trade-offs" — audited every tool for
the identical fold, applying it only where a genuine zero-cost win existed:

| Tool | Already lean? | Action |
|---|---|---|
| `tally_get_ledger_transactions` | Yes — movements have no field map | none needed |
| `tally_search` | Yes — projects to lean summaries before returning | none needed |
| `tally_get_party_statement` | Yes — reuses the same lean movements | none needed |
| `tally_get_gst` | Yes — already filters to GST-specific fields, already folds the one company-wide constant by hand | none needed |
| `tally_get_ledgers` (`includeAllFields`) | **No — unfolded** | folded: **8.2x smaller** |
| `tally_get_stock_items` (`includeAllFields`) | **No — unfolded** | folded: **−21%** |
| `tally_get_inventory_movements` | Already folded in round 1 | unchanged |

Nothing here required accepting new risk. Where a tool already projected to a
lean shape, no work was possible or needed; where it carried the same "populated
but constant" defect as the round-1 tools, the same lossless technique closed it.

## Practical guidance

**Narrowing the date range no longer makes the fetch smaller.** This reverses the
advice this file used to give, and the reason is worth understanding rather than
just noting.

The old voucher path was Tally's `Voucher Register` report, whose date range Tally
honours — so a month cost a fraction of a year. That path also returned **no ledger
entries at all**, which made most of what these tools compute empty or wrong. The
correct path is a `Voucher` collection, and a collection **ignores**
`SVFROMDATE`/`SVTODATE`. Measured on the same company:

| Request | Payload | Tally time |
|---|---|---|
| Full financial year (453 vouchers), lean | 8.6MB | ~2.0s |
| One month (13 vouchers), lean | 8.6MB | ~1.4s |
| Full financial year, full field detail | 18.3MB | ~5.0s |

The one-month request returns the whole year — byte for byte the same response — and
the dates are applied here afterwards. So a narrow range still reduces the tokens
returned to the model, but not the work TallyPrime does.

Net, this is still faster than what it replaced (8.6MB/2.0s against 21MB/7.8s) and
it actually contains the entries, so nothing was traded away except the date lever.

**Prefer the lean tools when the question allows.** The real lever now is which
fetch a tool needs: `tally_check_tie_out`, `tally_get_vouchers` (without
`includeAllFields`) and `tally_get_ledger_transactions` pay ~2.4s; anything needing
bank instruments, bill allocations, GST breakdowns or inventory lines pays ~6s.

**Ask masters questions first, freely.** Chart of accounts, groups, voucher types,
statements and stock masters are all under 350ms and under 4,000 tokens. Nothing
is saved by batching them.

**Group voucher questions together.** The first one pays ~9s; the rest are
effectively free for five minutes. Interleaving a long pause between two voucher
questions can cost a second fetch.

**Leave `includeAllFields` off unless investigating a specific record.** Full
detail is still 2.8× a lean page even after folding.

---

## Reproducing

The per-tool table came from a scratch script rather than a committed one, because
it calls each tool with hand-picked representative arguments and would rot as
signatures change. The method:

1. Build first — the measurement imports `dist/`, not `src/`, so it reflects what
   ships.
2. Register every tool against a fake `McpServer` that captures handlers, exactly
   as `tests/tools/harness.ts` does.
3. Build two registries: one with `TALLY_CACHE_TTL_MS=0` for cold figures, one at
   the shipped TTL, primed by running each call once before timing it.
4. Call each tool **sequentially**. TallyPrime serves one request at a time;
   concurrency produces blocked, timed-out or truncated responses and meaningless
   timings.
5. Token estimate: `Buffer.byteLength(responseText, 'utf-8') / 4`.

For correctness rather than cost, `npm run check:live` is committed and asserts
the behaviour that matters. See [project-status.md](project-status.md#live-verification-of-the-four-2026-08-12).

**Safety, since this talks to live books:** send no report or collection ID that
is not already verified, abort on the first connection-class failure, and never
run measurements concurrently. A malformed request can raise a modal and terminate
TallyPrime with unsaved work — see
[known-limitations.md](known-limitations.md#a-malformed-request-can-terminate-tallyprime).
