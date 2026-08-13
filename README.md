# tally-mcp

[![CI](https://github.com/MarketingBNG/Tally-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/MarketingBNG/Tally-MCP/actions/workflows/ci.yml)

A read-only [MCP](https://modelcontextprotocol.io) server that lets Claude
Desktop read accounting data directly out of TallyPrime running on the same
machine, so you can audit and analyse it in plain language.

The server fetches, filters and normalises Tally data. **Claude does the
reasoning.** There is no audit engine here and no hardcoded notion of what
counts as suspicious — that judgement depends on your business and your
question, and it stays with you.

> **Status: v1 and v2 feature-complete — all 8 done-criteria met.**
> 19 tools, four prompts and two resources, exercised against two live TallyPrime
> installs and from inside real Claude Desktop. `tally_get_statement` has been
> **reconciled row by row against TallyPrime's own on-screen trial balance** —
> all 9 rows, both columns, and a grand total matching on each side. Inventory
> and sales/purchase tools have since met a company carrying real stock and
> sales, and a second live pass on 2026-08-12 verified voucher types, bank
> reconciliation, statement comparison and bill ageing, finding and fixing two
> defects fixtures alone could not have caught (see
> [known-limitations.md](docs/known-limitations.md)). Two paths remain
> unproven for want of a company that reconciles its bank or tracks bills —
> `reconciled: true` and ageing against real bills.
>
> Full breakdown in [docs/project-status.md](docs/project-status.md), including
> what is built but not yet proven against real data. See
> [docs/known-limitations.md](docs/known-limitations.md) for exactly what works
> today and what TallyPrime will not do.

## What it does

```
Claude Desktop  --MCP/stdio-->  tally-mcp  --HTTP-->  TallyPrime (127.0.0.1:9000)
```

- **Local only.** No cloud, no database, no telemetry. Your accounting data
  never leaves your machine.
- **Read-only, structurally.** Every request is `TALLYREQUEST=Export`. There is
  no code path that can create, alter or delete anything in Tally, and a test
  asserts this against the source tree on every run.
- **Stateless.** Claude Desktop launches the process; it holds nothing.

## Requirements

- **TallyPrime** running locally with a company loaded
- **Node.js 20+** (developed against 24)
- **Claude Desktop**

Native JSON data exchange requires **TallyPrime 7.0 or later**. On older
builds everything is retrieved as XML automatically.

## Setup

### 1. Enable Tally's HTTP server

In TallyPrime: **F1 (Help) → Settings → Connectivity → Client/Server
configuration**

| Setting | Value |
|---|---|
| TallyPrime acts as | `Both` (or `Server`) |
| Enable ODBC | not required |
| Port | `9000` |

Load your company. Tally serves data only for the company it currently has
open.

### 2. Install and build

```bash
npm install
npm run build
```

### 3a. Add to Claude Code (no Claude Desktop needed)

Claude Code speaks MCP too, so you can use this without installing Claude
Desktop. Create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "tally": {
      "command": "node",
      "args": ["/absolute/path/to/tally-mcp/dist/index.js"],
      "env": { "TALLY_HOST": "127.0.0.1", "TALLY_PORT": "9000" }
    }
  }
}
```

On Windows, escape the backslashes:
`"C:\\Users\\you\\tally-mcp\\dist\\index.js"`.

Restart Claude Code (or reload the window in the VS Code extension) and approve
the server when prompted. `/mcp` lists connected servers.

This file is gitignored: it holds an absolute path specific to your machine.

### 3b. Add to Claude Desktop

Edit the config file — easiest via **Settings → Developer → Edit Config**,
which creates it if it does not exist:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows (installer build) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Windows (Microsoft Store build) | `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json` |

> **Windows Store builds are the trap.** Claude Desktop installed from the
> Microsoft Store is an MSIX package, and packaged apps get a *virtualised*
> `%APPDATA%` — so `%APPDATA%\Claude` does not exist and the documented path
> silently leads nowhere. Check which you have:
>
> ```powershell
> Get-Process claude | Select-Object -ExpandProperty Path -Unique
> ```
>
> A path under `C:\Program Files\WindowsApps\Claude_...` means the Store build.
> Find the real config with:
>
> ```powershell
> Get-ChildItem $env:LOCALAPPDATA\Packages -Filter claude_desktop_config.json -Recurse
> ```
>
> Using **Settings → Developer → Edit Config** avoids the problem entirely, as
> it opens whichever file is actually in use.

```json
{
  "mcpServers": {
    "tally": {
      "command": "node",
      "args": ["/absolute/path/to/tally-mcp/dist/index.js"],
      "env": {
        "TALLY_HOST": "127.0.0.1",
        "TALLY_PORT": "9000"
      }
    }
  }
}
```

If the file already has other keys (`preferences`, `mcpServers` for other
servers), **add to it rather than replacing it** — the whole file is Claude
Desktop's configuration, not just MCP.

Use an **absolute path** — Claude Desktop does not resolve relative ones. On
Windows, escape backslashes and prefer the **full path to `node.exe`**
(`C:\\Program Files\\nodejs\\node.exe`) rather than bare `node`: a packaged
Store build does not reliably inherit your `PATH`, and a bare `node` fails with
`ENOENT`.

Then **quit Claude Desktop completely and reopen it** — closing the window is
not enough; check the system tray.

> **`.env` does not apply here.** Claude Desktop launches the server with the
> `env` block above, and will not read a `.env` file in the project folder.
> `.env` works when you run the server yourself from a terminal during
> development; in Claude Desktop, the config JSON is the real configuration.

### 4. Check it

Ask Claude: *"Check the Tally connection."* It should call
`tally_connection_status` and report success, or tell you specifically what to
fix.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TALLY_HOST` | `127.0.0.1` | Host running TallyPrime |
| `TALLY_PORT` | `9000` | Port from Tally's connectivity settings |
| `TALLY_PROTOCOL` | `http` | `http` or `https` |
| `TALLY_TIMEOUT_MS` | `30000` | Timeout for ordinary requests |
| `TALLY_REPORT_TIMEOUT_MS` | 4× base | Timeout for large reports |
| `TALLY_PREFERRED_FORMAT` | `json` | `json` or `xml`; JSON needs Tally 7.0+ |
| `TALLY_MAX_RECORDS` | `5000` | Refuse queries returning more records than this |
| `TALLY_MAX_RESPONSE_BYTES` | `150000` | Refuse responses larger than this. Sized by **context** budget (~37,500 tokens), not by the client's 1MB message cap — see below |
| `TALLY_CACHE_TTL_MS` | `300000` | Reuse an identical Tally response, and the records parsed from it, for this long. **The biggest lever on audit speed** — see below. `0` disables caching |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

Invalid configuration fails at startup with a message naming every bad value
at once, rather than failing mysteriously on first use.

### Speed and size: the two settings that matter

> Per-tool token and timing figures for all 19 tools, measured against a live
> install, are in **[docs/performance.md](docs/performance.md)**.

Both defaults were changed on 2026-08-13 after measuring a real audit, and both
are worth understanding before tuning.

**`TALLY_CACHE_TTL_MS` governs how long an audit takes.** One period's voucher
register is **21MB and takes TallyPrime about 7 seconds** — 87% of the wall clock
is Tally's own time, 13% is parsing here. Five separate tools read that same
register: bank reconciliation, outstanding, GST, inventory movements, and the
voucher list. At the old 20-second TTL the cache lapsed while you read the last
answer, so each question paid the 7 seconds again.

Measured on a 9-question audit of a full financial year with 25 seconds of
thinking between questions:

| Cache TTL | Time spent waiting |
|---|---|
| 20,000 (old) | **64s** |
| 300,000 (new) | **12s** — an 81% cut |

Both the raw response and the *parsed records* are cached now; the parse alone was
1.2 seconds per call. The trade-off: an edit made in TallyPrime while a
conversation is running may not be seen for up to five minutes. This server cannot
write, so the only way to hit that is editing the books by hand mid-audit. Every
response carries `data_fetched_at` — when the data was actually read, as distinct
from `as_of_timestamp`, when the answer was produced — so a cached figure is never
mis-dated in a workpaper.

**`TALLY_MAX_RESPONSE_BYTES` governs how much of your conversation one answer
eats.** It was 900,000, chosen as headroom under Claude Desktop's 1MB message cap.
That conflated transport budget with context budget: a 900KB response is roughly
225,000 tokens. Raise it deliberately for a one-off deep dive, but expect one such
call to dominate the conversation.

## Tools

### Available now

19 tools, registered in [src/server/mcpServer.ts](src/server/mcpServer.ts). Modes
of the same tool (e.g. list vs. get-by-name) are noted in one row rather than
repeated.

| Tool | Purpose |
|---|---|
| `tally_connection_status` | Check reachability; returns a specific fix on failure |
| `tally_list_companies` | The company TallyPrime currently has loaded |
| `tally_get_company` | Company profile — size, groups, fields in use; `includeFeatures` infers which TallyPrime features the data shows in use |
| `tally_get_ledgers` | Chart of accounts: list, search, fetch one by exact `name`, or filter with `conditions` — balances, GSTIN |
| `tally_get_groups` | The chart-of-accounts group hierarchy: list, search, or filter |
| `tally_get_voucher_types` | Transaction types this company defines, with the built-in each derives from and its numbering series |
| `tally_get_ledger_transactions` | Statement of movements on one ledger, with a running balance |
| `tally_get_party_statement` | Every matching ledger for a party name, plus other mentions, in one call |
| `tally_get_statement` | `trial_balance` / `balance_sheet` / `profit_loss` / `cash_flow` / `fund_flow`, optionally compared across two periods — see below |
| `tally_get_vouchers` | Transactions in a period: list, filter by ledger/party/narration/type/amount/field, fetch one by number, or restrict to a trading `family` |
| `tally_summarise_movements` | Totals per ledger, group, month, voucher type or party, summed in exact decimal on the server. Use it whenever the answer is a figure rather than a list — about 16x smaller than reading the transactions |
| `tally_get_stock_items` | Inventory masters: list, search, fetch one by name, or filter |
| `tally_get_inventory_movements` | Stock movements, derived from voucher inventory lines |
| `tally_get_outstanding` | Receivables or payables with bill references; `includeAgeing` buckets by bill AGE, not overdue — see below |
| `tally_get_gst` | `summary` (tax ledgers/registration in use) or `transactions` (GST-bearing vouchers), as recorded, never calculated |
| `tally_search` | Cross-entity search over ledgers, vouchers and stock items |
| `tally_get_bank_reconciliation` | Bank instruments with cheque/UTR detail and reconciled status — see below |
| `tally_check_tie_out` | Does the arithmetic hold? Every voucher balances, every ledger rolls forward |
| `tally_calculate_materiality` | Overall / performance / clearly-trivial thresholds, with the basis recorded |

All are exposed over MCP and exercised against a live TallyPrime install. The
four newest — voucher types, bank reconciliation, statement comparison, and
ageing — were verified with 30 sequential calls against a real company on
2026-08-12, at the shipped size and record limits. That run found and fixed two
defects fixtures could not have caught, and left two paths still unproven
(`reconciled: true`, and ageing against real bills, neither of which exists on any
company available so far). Both are recorded in
[docs/project-status.md](docs/project-status.md#live-verification-of-the-four-2026-08-12).
Per-tool token and timing figures for all 18: [docs/performance.md](docs/performance.md).

### Bank reconciliation, comparison and ageing — read the caveats

Three of the newest capabilities produce output that looks more authoritative
than the underlying data supports, so each states its own limits in the response
rather than only in this README:

- **`tally_get_bank_reconciliation`** derives from the bank instrument detail on
  vouchers, not from TallyPrime's own Bank Reconciliation screen (that export ID
  is unverified, and a wrong one can close TallyPrime). Reconciled status comes
  from the bank statement date Tally stamps on an entry. If **no** entry in the
  period carries one, the status is reported as `null` — unknown — and a filter
  on status fails outright, because "nothing has been reconciled" and "this
  company doesn't use the feature" are different answers. It lists instruments;
  it does not draw up a reconciliation statement.
- **The statements ignore the requested END date.** Verified live: TallyPrime
  honours `fromDate` on the trial balance, P&L and cash flow and discards
  `toDate`, accumulating to the financial year end — a three-month cash flow
  request returned nine months. Every response now carries
  `coversPeriodRequested`, and where it is false the figures are a cumulative
  position, not the period asked for. **Period comparison is refused** unless the
  period ends at the year end, because otherwise both sides accumulate to the same
  end and the subtraction yields minus the whole of the earlier period — a wrong
  figure of exactly plausible size. Beyond that, comparison pairs rows by name
  only where unambiguous, and computes no change against a null.
- **`includeAgeing`** buckets bills by how long ago they were **raised**, not by
  how overdue they are — Tally does not reliably record credit terms, and this
  server will not assume them. Bill references are netted first, and the schedule
  covers only bills raised inside the requested period, which it says on every
  call.

Full reasoning for each: [docs/known-limitations.md](docs/known-limitations.md).

### Every answer is wrapped in a provenance envelope

Every data tool returns the same six fields around its own payload, so a figure
can be traced and a partial answer can never pass for a complete one:

```jsonc
{
  "data":             { /* the tool's own payload, unchanged */ },
  "company_id":       "ACME TRADING PRIVATE LIMITED",  // by name; Tally exposes no company GUID
  "as_of_timestamp":  "2026-08-12T16:31:00.000Z",
  "source_query":     ["<ENVELOPE>…</ENVELOPE>"],      // every request sent, replayable
  "row_count":        100,
  "truncated":        true                              // did you get everything that matched?
}
```

`truncated` is the one that matters. Before this envelope, three different
tools signalled a partial result three different ways — a `hasMore` flag, a
thrown error, or a nested `truncated` field — and a consumer reading only one
of them could take a clipped list for the whole population. Now there is a
single field, in the same place, on every reply. It is never guessed: a tool
that cannot know whether it returned everything refuses instead.

Failures carry `company_id`, `as_of_timestamp` and `source_query` too, so a
diagnosis can see what was actually sent. They carry no `row_count` — nothing
was returned, and a `0` there would read as "asked, found nothing" rather than
"failed".

`tally_connection_status` is the one exemption. It answers "did TallyPrime
reply?" and returns no accounting data, so it has no company, no rows and
nothing to truncate.

`source_query` holds the literal XML sent to TallyPrime. Replaying it
reproduces the figures — that is the point, and it is what makes a number in a
workpaper defensible months later.

### Tie-out, and the normalised ledger model underneath it

`tally_check_tie_out` runs two independent checks: that every voucher's debits
equal its credits, and that every ledger's closing balance equals its opening
balance plus the period's movements. It is the first working piece of the
`tie_out_gate` control, and it needs no warehouse — both sides of the
comparison already come out of TallyPrime.

Three things about it are deliberate:

- **No tolerance band.** A one-paisa difference is an exception. Deciding what
  is immaterial is the engagement team's judgement, not this server's — and
  `tally_calculate_materiality` is where that judgement gets recorded.
- **"Not checkable" is reported separately from "passed".** A ledger with no
  opening balance, or a voucher with an unreadable amount, cannot be verified
  either way. Counting those as passes would overstate the assurance.
- **Its default period differs from every other tool's.** The comparison is
  against Tally's period-end closing balance, so given no dates this checks the
  financial year the company's books begin in, rather than the one containing
  today. It says which range it used.

It is also the first audit test written against the **normalised ledger model**
([src/model/ledger.ts](src/model/ledger.ts)) rather than against Tally's own
shapes, reached through the Tally adapter in
[src/model/fromTally.ts](src/model/fromTally.ts). That model is a draft pending
review — see [docs/normalised-ledger-model.md](docs/normalised-ledger-model.md),
which sets out the one open decision (how a debit is represented) and why it
has to be settled before a second accounting system is supported.

### Cash flow and fund flow: movement, not classified statements

`tally_get_statement (statement: 'cash_flow')` and `tally_get_statement (statement: 'fund_flow')` return TallyPrime's own
month-by-month figures — one row per month with Tally's debit, credit and net
columns, sign convention preserved (retrieval verified against a live install).

What they deliberately do NOT do is classify. A formal cash flow statement
splits movements into operating, investing and financing activities; a fund
flow statement decides sources versus applications. Both are judgements about
the business, and this server holds no business rules — so the data is labelled
as monthly movement, and the tool descriptions instruct Claude to present it
that way and to make any classification together with the user, stating the
basis used.

### Voucher families, not voucher names

`tally_get_vouchers (family: 'sales')` resolves which voucher types count as sales from Tally's own
voucher type list, matching on **base type** rather than name. A company that
defines "Tax Invoice" deriving from `Sales` is included; matching the name for
"sales" would have missed it and under-reported the period. The types actually
used are echoed back as `voucherTypesIncluded`.

### Prompts

Four starting points, exposed as MCP prompts: `audit_company`,
`investigate_transactions`, `analyze_period`, `compare_periods`.

They contain **no accounting rules and no thresholds** — nothing defines what
"large" or "suspicious" means. What they do carry is method: which tool to call
first, and the quirks of this data source that would otherwise produce a
confidently wrong answer (null is not zero, debits arrive negative, one company
at a time, fields differ per company).

### Currency

Every amount is labelled with the **loaded company's own base currency**, read from
Tally rather than assumed. Note that Tally reports it as a *symbol* — `$`, `₹`,
`Rs.` — and never as an ISO code, so do not treat the label as a currency code.

Nothing here converts between currencies. A voucher denominated in a currency other
than the company's base is currently labelled with the base currency; amounts are
never wrong, but a multi-currency company would see such an entry mislabelled. See
[docs/known-limitations.md](docs/known-limitations.md).

### Resources

`tally://connection` and `tally://company` — ambient context a client can read
without asking. Both are cheap by design; neither triggers a large fetch.

### Working across companies

TallyPrime serves data for **one company at a time** — whichever is currently
open. Every tool takes an optional `company`, and the rules are:

- **No `company`** — uses whatever Tally has loaded. No extra round trip.
- **`company` matches the loaded one** — proceeds normally.
- **`company` is something else** — fails with `TALLY_COMPANY_NOT_LOADED`,
  naming what *is* loaded so the fix is obvious. The name is checked against
  the loaded company list locally and is never sent into Tally's request path.

To analyse a different company, open it in TallyPrime. The server cannot
switch on your behalf, and says so rather than silently returning the wrong
company's figures.

### Different companies, different fields

Companies enable different TallyPrime features, so they hold different fields.
Rather than assume a fixed shape, the server can return **everything Tally
holds** for a record via `includeAllFields`, under an open `fields` map.

Start with `tally_get_company`. It reports the fields this company actually
uses, split into:

- **`distinguishingFields`** — fields whose values differ between ledgers.
  Where the real data is.
- **`uniformFields`** — the same value on every ledger. Almost always
  TallyPrime defaults, not something the company recorded.

That split matters: on a real 330-ledger company, 115 populated fields resolve
to just **36 distinguishing and 79 defaults**. Ranking by raw usage instead
puts boilerplate like `ABATEMENTPERCENTAGE` (present on all 330, always the
same) at the top and buries the fields that carry information.

`includeAllFields` defaults to **on** for single-record lookups
(`tally_get_ledger`, `tally_get_vouchers`) since those are usually
investigations, and **off** for list calls. On vouchers it costs nothing extra
to retrieve — Tally already sends every field. On ledgers it is roughly 37x
the payload, so it is opt-in.

### Two caveats on v1

**`tally_get_ledger_transactions` computes its running balance.** The
movements are Tally's own data, but the running balance and period closing
balance are calculated here from the opening balance plus those movements —
TallyPrime's per-ledger report ID is not confirmed, and guessing a report ID
can terminate the application (see below). Tally's own closing figure is
returned alongside as `tallyReportedClosingBalance` for comparison; note it is
as at Tally's current period end, not the requested range, so the two agree
only when the range covers the whole period.

**`tally_get_day_book` is deliberately not exposed.** On a real install the
`DayBook` report ignores the date range it is given and reports Tally's own
current period instead. Neither it nor the `Voucher Register` report returns the
debit and credit lines of a voucher, so `tally_get_vouchers` reads a `Voucher`
collection instead and applies the date range itself. See
[docs/known-limitations.md](docs/known-limitations.md).

### Planned for v2

Sales and purchases, inventory, receivables and payables, GST, cash flow and
fund flow, cross-entity search.

## Example prompts

Once v1 lands, questions like these are the intended use. They are examples of
how to *ask*, not rules built into the server:

- *"Audit April purchases for duplicate invoice numbers."*
- *"Find unusually large transactions last quarter."*
- *"Compare April and March expenses and investigate the biggest changes."*
- *"Which receivables are more than 90 days overdue?"*

Note that "unusually large" has no fixed meaning here. Claude decides what that
means from your data and your question, every time.

## How data is retrieved

Confirmed against a live TallyPrime 7.x install on 2026-08-10, voucher path re-confirmed 2026-08-13.

| Data | Path | Notes |
|---|---|---|
| Companies, ledgers | XML collection | Nested records under `<DATA>` |
| Trial balance, balance sheet, P&L | XML report | Parallel sibling arrays, paired positionally |
| Vouchers | XML `Voucher` collection | The only shape that returns ledger entries; ignores the date range, so dates are applied here |
| Everything | XML | JSON was requested and Tally returned XML anyway |

**JSON does not work on this build.** Requesting `$$SysName:JSON` returned
byte-identical XML, so `TALLY_PREFERRED_FORMAT=json` is currently a no-op. The
per-request fallback handles it transparently; XML is the real path.

## Troubleshooting

**Tools do not appear in Claude Desktop**
Check the path in the config is absolute and that `dist/index.js` exists (run
`npm run build`), then restart Claude Desktop completely. To confirm the server
connected, open the **"Add files, connectors, and more"** control at the
bottom-left of the message box, then **Connectors → Manage connectors**, and
look for `tally`.

If it is not there, check the logs:

- macOS: `~/Library/Logs/Claude/mcp.log`
- Windows: `%APPDATA%\Claude\logs\mcp.log`

`mcp-server-tally.log` alongside it holds this server's stderr, which is where
all of its logging goes.

**Windows: `ENOENT` mentioning `${APPDATA}`**
A known Claude Desktop issue rather than a fault in this server. Add the
expanded value to the `env` block:

```json
"env": {
  "APPDATA": "C:\\Users\\<you>\\AppData\\Roaming\\",
  "TALLY_HOST": "127.0.0.1",
  "TALLY_PORT": "9000"
}
```

**`TALLY_NOT_RUNNING`**
Tally is not listening. Confirm it is open with a company loaded and that
Client/Server configuration is set as above. Verify with:

```bash
curl -m 5 http://127.0.0.1:9000
```

**`TALLY_COMPANY_NOT_LOADED`**
The requested company is not the one Tally has open. Load it in Tally.

**`RESULT_LIMIT_EXCEEDED`**
The query would return more records than `TALLY_MAX_RECORDS`. Narrow the date
range or add a filter. Raising the limit is possible but means holding more in
memory — Tally cannot paginate, so the whole set is fetched either way.

**`RESPONSE_TOO_LARGE`**
The data was retrieved, but the page is too big to hand back in one response.
This is a *transport* limit, not a memory one, and the two are easy to confuse:
records can sit well inside `TALLY_MAX_RECORDS` while the serialised JSON
breaches what the client accepts. One voucher with every field runs to about
18 KB, so 100 of them is ~1.7MB against a 1MB ceiling in Claude Desktop.

The error names a `pageSize` that fits, computed from the actual measured size,
so one retry succeeds. Setting `includeAllFields` to `false` shrinks it far more
than paging does. `TALLY_MAX_RESPONSE_BYTES` tunes the ceiling if your client
allows more.

**"Tool result is too large. Maximum size is 1MB." in Claude Desktop**
That message comes from the client, not this server, and means a response got
past the ceiling above — most likely because `TALLY_MAX_RESPONSE_BYTES` has been
raised beyond what the client accepts. Lower it back to `900000`.

**`TALLY_TIMEOUT`**
Large reports can legitimately exceed the base timeout. Raise
`TALLY_REPORT_TIMEOUT_MS`, or narrow the range.

**Garbled text in results**
Report it. Tally's encoding declarations are sometimes wrong, and the client
detects encoding from the bytes for that reason — but a case that slips
through is a bug worth a sample.

## Security and scope

- **Read-only by construction.** Only `Export` requests are built, and
  `tests/tally/requests.test.ts` scans `src/` on every run to assert no write
  verb exists anywhere.
- **No secrets in logs.** Logging is structured, level-gated and redacts
  credential-shaped keys. Full Tally payloads appear only at `debug`.
- **No stack traces cross the MCP boundary.** Errors return a stable code, a
  message and a suggestion. Diagnostics stay in the local log.
- **Retrieved text is data, not instructions.** Narrations, party names and
  ledger names come from your accounting system and could contain anything.
  Tool descriptions state explicitly that Claude must never treat their
  contents as commands.
- **stdout is sacred.** It is the MCP channel; all logging goes to stderr, and
  an integration test asserts stdout stays pure JSON-RPC.
- **No real accounting data in the repository.** `samples/` holds unredacted
  exports and is gitignored. `tests/fixtures/` is committed and must contain
  only invented values — a test enforces this by comparing every fixture
  amount, GUID and reference against `samples/` and failing on any match. It
  skips when `samples/` is absent, so it runs exactly where the mistake can be
  made. See [tests/fixtures/README.md](tests/fixtures/README.md).

## Development

```bash
npm run dev         # watch mode
npm test            # unit + integration tests
npm run typecheck
npm run lint
npm run verify      # typecheck + lint + test, the same four CI runs
npm run check:build # is dist/ older than src/?
npm run mock-tally  # standalone mock Tally server, port 9999
npm run check:live  # acceptance run against a REAL TallyPrime — see below
```

`npm run check:live` exercises `dist/` against whatever company TallyPrime
currently has open, deriving the period from that company's own financial year
rather than from today, and asserting the things a human skims past — that
comparing a period with itself yields zero movement everywhere, that no voucher
type reports the legacy numbering value, that reconciled status is null exactly
when no bank date is reported. It runs at the shipped size and record limits by
default; `-- --raised` lifts them for diagnosis only, and cannot be an acceptance
run because it would hide a tool that works only with the ceilings raised.

It is safe to run against live books: sequential calls only, no report or
collection ID that is not already verified, and it aborts on the first
connection-class failure rather than turning one wedged request into a cascade.
Output goes to `.live-check/` (gitignored — real party names and amounts).

Its last two lines are the point. Two paths cannot be exercised on any company
available so far — `reconciled: true` needs books that reconcile the bank inside
TallyPrime, and the ageing schedule needs bill-wise details — so every run states
whether that gap is still open. When either finally reports EXERCISED, update
[docs/known-limitations.md](docs/known-limitations.md).

Integration tests need a build first — they spawn the real binary and speak
MCP to it over stdio.

**Rebuild after every source change.** Claude Desktop launches `dist/index.js`,
never the TypeScript, so an unbuilt change is invisible to it — the tool list is
simply the one from the last build, with nothing appearing to fail. This has
already cost a day: a tool existed in `src/`, passed its tests, and was absent
from every client. `npm run check:build` answers the question directly, and
`Check-Tally` reports it too when run from a source checkout.

### Releasing

```bash
npm version minor   # or patch / major
git push --follow-tags
powershell -ExecutionPolicy Bypass -File installer\package.ps1
```

`npm version` runs `verify` first, then stamps the `## <version> — unreleased`
heading in [CHANGELOG.md](CHANGELOG.md) with the released version and today's
date, and includes it in the version commit. The version an install reports
comes from `package.json`, so this keeps the number a user reads back during
support and the notes describing it in the same commit.

## Contributing samples

Ground-truth samples for v1 were captured on 2026-08-10, and redacted copies
live in `tests/fixtures/`. Further samples are still welcome — particularly
from a **different Tally version or a company with inventory or GST data**,
since everything currently confirmed comes from a single install.

Run `scripts/fetch-samples.ps1` on the machine running TallyPrime and drop the
output into `samples/` (gitignored — it holds real accounting data). Redact
names and amounts freely; the tag structure is what matters, and messy real
data is more useful than tidy data.

> **Note:** the two deliberately-malformed requests at the end of that script
> were found to terminate TallyPrime rather than return an error. They should
> be removed or run last, and never against books you have unsaved work in.
> See [docs/known-limitations.md](docs/known-limitations.md).

## License

MIT — see [LICENSE](LICENSE).
