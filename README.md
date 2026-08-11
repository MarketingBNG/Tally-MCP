# tally-mcp

A read-only [MCP](https://modelcontextprotocol.io) server that lets Claude
Desktop read accounting data directly out of TallyPrime running on the same
machine, so you can audit and analyse it in plain language.

The server fetches, filters and normalises Tally data. **Claude does the
reasoning.** There is no audit engine here and no hardcoded notion of what
counts as suspicious — that judgement depends on your business and your
question, and it stays with you.

> **Status: v1 and v2 feature-complete — all 8 done-criteria met.**
> 29 tools, four prompts and two resources, exercised against a live TallyPrime
> install and from inside real Claude Desktop. `tally_get_trial_balance` has
> been **reconciled row by row against TallyPrime's own on-screen trial
> balance** — all 9 rows, both columns, and a grand total matching on each side.
> What remains is verification, not construction: the inventory and
> sales/purchase tools are built and fixture-tested but have not yet met a
> company that carries stock or records sales.
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
| `TALLY_MAX_RECORDS` | `5000` | Refuse queries larger than this |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

Invalid configuration fails at startup with a message naming every bad value
at once, rather than failing mysteriously on first use.

## Tools

### Available now

| Tool | Purpose |
|---|---|
| `tally_connection_status` | Check reachability; returns a specific fix on failure |
| `tally_list_companies` | The company TallyPrime currently has loaded |
| `tally_get_company` | Company profile — size, groups, and which fields it actually uses |
| `tally_list_ledgers` | Chart of accounts with opening/closing balances |
| `tally_search_ledgers` | Find ledgers by name or parent group |
| `tally_get_ledger` | One ledger by exact name |
| `tally_get_ledger_transactions` | Statement of movements on one ledger, with a running balance |
| `tally_get_trial_balance` | Closing debit/credit per group |
| `tally_get_balance_sheet` | Financial position at a date |
| `tally_get_profit_loss` | Income and expenditure for a period |
| `tally_list_vouchers` | Transactions in a period, with ledger entries |
| `tally_search_vouchers` | Filter by ledger, party, narration, type, amount, or any field value |
| `tally_get_voucher` | One voucher in full, including nested inventory, bank and tax detail |
| `tally_get_company_features` | Which TallyPrime features this company's data shows in use |
| `tally_get_sales` / `tally_search_sales` | Sales-family vouchers, resolved by base voucher type |
| `tally_get_purchases` / `tally_search_purchases` | Purchase-family vouchers |
| `tally_list_stock_items` / `tally_search_stock_items` / `tally_get_stock_item` | Inventory masters |
| `tally_get_inventory_movements` | Stock movements, from voucher inventory lines |
| `tally_get_receivables` / `tally_get_payables` | Party balances with bill references |
| `tally_get_gst_summary` / `tally_get_gst_transactions` | GST as recorded, never calculated |
| `tally_search` | Cross-entity search over ledgers, vouchers and stock items |
| `tally_get_cash_flow` / `tally_get_fund_flow` | Registered, always `TALLY_UNSUPPORTED_OPERATION` — see below |

All 29 are exposed over MCP and exercised against a live TallyPrime install.

### Two tools that deliberately refuse

`tally_get_cash_flow` and `tally_get_fund_flow` always fail with
`TALLY_UNSUPPORTED_OPERATION` and explain why, rather than being omitted — an
absent tool leaves Claude guessing, a refusing one redirects.

Both need a classification (operating/investing/financing; sources/applications
of funds) that is a judgement about the business, and this server holds no
business rules. Producing one from an assumed mapping would present an invented
classification as fact. The error points at
`tally_get_ledger_transactions` and `tally_get_balance_sheet`, which return the
underlying data so the statement can be assembled with its basis stated.

### Voucher families, not voucher names

`tally_get_sales` resolves which voucher types count as sales from Tally's own
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
(`tally_get_ledger`, `tally_get_voucher`) since those are usually
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
current period instead. `tally_list_vouchers` covers the same ground correctly
via `Voucher Register`. See [docs/known-limitations.md](docs/known-limitations.md).

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

Confirmed against a live TallyPrime 7.x install on 2026-08-10.

| Data | Path | Notes |
|---|---|---|
| Companies, ledgers | XML collection | Nested records under `<DATA>` |
| Trial balance, balance sheet, P&L | XML report | Parallel sibling arrays, paired positionally |
| Vouchers | XML `Voucher Register` | Date-scoped; the day book ignores its date range |
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
npm run dev        # watch mode
npm test           # unit + integration tests
npm run typecheck
npm run lint
npm run mock-tally # standalone mock Tally server
```

Integration tests need a build first — they spawn the real binary and speak
MCP to it over stdio.

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
