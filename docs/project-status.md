# Project status

Where the project actually stands, measured against `PROJECT_SPEC.md` rather
than against how finished it feels. Companion to
[known-limitations.md](known-limitations.md), which covers *why* things behave
as they do; this file covers *how much* is done.

**Last updated:** 2026-08-10, verified against a live TallyPrime 7.x install
holding a real operating company (330 ledgers, ~30 vouchers/month).

---

## Summary

| Measure | Status |
|---|---|
| **Built** | ~95% |
| **Verified against real data** | ~85% |
| Tools | 29 registered (13 v1, 16 v2) |
| Prompts / resources | 4 / 2 |
| Tests | 266 passing, 2 skipped, across 16 files |
| `typecheck` / `lint` / `build` | All clean (re-run 2026-08-10) |
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
`tally_list_ledgers`, `tally_search_ledgers`, `tally_get_ledger`,
`tally_get_ledger_transactions`, `tally_list_vouchers`, `tally_search_vouchers`,
`tally_get_voucher`, `tally_get_trial_balance`, `tally_get_balance_sheet`,
`tally_get_profit_loss`

**Not built: `tally_get_day_book`** — deliberately. On a real install the
`DayBook` report ignores the date range it is given and reports Tally's own
current period: 3 vouchers for a five-year range where `Voucher Register`
returned 30 for one month inside it. A date filter that is silently ignored is
worse than one that fails, so the report is not exposed.
`tally_list_vouchers` covers the same ground correctly.

### v2 — 16 of 16

`tally_get_company_features`, `tally_get_sales`, `tally_search_sales`,
`tally_get_purchases`, `tally_search_purchases`, `tally_list_stock_items`,
`tally_search_stock_items`, `tally_get_stock_item`,
`tally_get_inventory_movements`, `tally_get_receivables`,
`tally_get_payables`, `tally_get_gst_summary`, `tally_get_gst_transactions`,
`tally_search`, plus `tally_get_cash_flow` and `tally_get_fund_flow`.

The last two are registered and **always** return
`TALLY_UNSUPPORTED_OPERATION` with an explanation and a redirection. Both
require a classification that is a judgement about the business, and this
server holds no business rules. Registering them rather than omitting them
means the limitation is discoverable instead of leaving Claude guessing at a
tool that does not exist.

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
| 2 | Unit + integration tests pass against the mock | ✅ 266 passing, 2 skipped |
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
- All 29 tools listed and callable over real MCP stdio

## Unproven: built but not observed

Both are complete, tested against fixtures, and designed to degrade honestly —
but neither has met real data, and that is a difference worth stating.

| Area | Why unproven | Risk |
|---|---|---|
| **Inventory tools** | The verification company holds **zero stock items** — the response is CMPINFO counters with no `<DATA>` section | Response shape for a populated inventory has never been seen. Mitigated by promoting only `name`/`parent` and returning everything else through generic field extraction, so the output is whatever Tally sends rather than a guessed mapping |
| **Sales / purchase tools** | The sampled month contained only Payment, Journal and Receipt vouchers | Family resolution is tested against fixtures including a custom "Tax Invoice" type; retrieval against real sales vouchers is not |

Both resolve the first time the server is pointed at a company that keeps stock
or records sales. Neither is a code gap.

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

1. **Point the server at a company with inventory and sales** — the only way to
   convert the two unproven areas into verified ones. Needs access to a
   different Tally company, not a change to the server.
2. **Decide what happens to `samples/`** — it holds real accounting data on
   disk. Gitignored, but still there.
3. **Publish decisions** — the package is `0.1.0` with a `bin` entry and a
   `files` allowlist, so it is shaped for npm, but nothing has been published
   and no release process exists. Only worth doing if the server is meant to
   leave this machine.
4. **Revisit the deliberate omissions if Tally's behaviour changes** —
   `tally_get_day_book` and the two flow statements are settled decisions, not
   a backlog; they are recorded here so they stay decisions rather than
   drifting into forgotten gaps.
