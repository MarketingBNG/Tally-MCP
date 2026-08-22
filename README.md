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
> 20 tools, four prompts and two resources, exercised against three live TallyPrime
> installs and from inside real Claude Desktop. `tally_get_statement` has been
> **reconciled row by row against TallyPrime's own on-screen trial balance** —
> all 9 rows, both columns, and a grand total matching on each side. Inventory
> and sales/purchase tools have since met a company carrying real stock and
> sales, and a second live pass on 2026-08-12 verified voucher types, bank
> reconciliation, statement comparison and bill ageing, finding and fixing two
> defects fixtures alone could not have caught (see
> [known-limitations.md](docs/known-limitations.md)).
>
> A third company on 2026-08-14 — German, calendar-year — unblocked the two
> closing-stock reports and exposed two date bugs that only show up outside an
> Indian April–March year: a financial year derived by *assuming* April, and an
> end-date rule that turned out to be **honoured on the 31st of a month and
> ignored on every other day** (nineteen live observations). Both fixed. Two
> paths remain unproven for want of a company that reconciles its bank or tracks
> bills — `reconciled: true` and ageing against real bills.
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

> **One thing on this page is no longer true by default.** "Your accounting data
> never leaves your machine" describes the connector, and still does. It does not
> describe the **daily spreadsheet** below, whose entire purpose is a folder
> Google Drive syncs. This codebase never calls a Google API and holds no
> credential — but if you set that up, client accounting data is in Google Drive.
> Decide that deliberately. See [The daily spreadsheet](#the-daily-spreadsheet).

## The daily spreadsheet

Setup can put a scheduled job on this machine that writes each company's books
to an Excel workbook — one file per company, one tab per part of the books — in
a folder of your choosing. Point that folder at Google Drive and Claude can
answer from the workbook, through the Google Drive connector, with the Tally
connector switched off entirely.

```
TallyPrime  --HTTP-->  Run-Export.bat  -->  <folder>\<Company>\<Company>.xlsx
                                                    |
                                       Google Drive Desktop syncs it
                                                    |
                                        Claude reads it via Drive
```

**What it buys.** TallyPrime does not have to be open when somebody asks a
question. The accountant gets a real spreadsheet rather than retyped figures.
And an ordinary conversation loads the Google connector instead of this server's
23 tools, which cost about **12,000 tokens of every conversation** before any
data moves.

**What it costs, stated plainly.** Reading the workbook still costs tokens —
this moves the data out of Claude's fetch path, it does not compress it. And
Claude's arithmetic over spreadsheet rows replaces this server's tested
procedures: tie-out, ageing, materiality, sampling, late-entry. If a figure has
to go into an audit file, check it against the live connector first.

### Reading it

A `.xlsx` in Drive **opens directly in Google Sheets** with tabs intact. Nothing
needs importing.

> **Do not use File → Save as Google Sheets.** That creates a separate native
> copy the exporter will never touch again. It silently becomes a frozen
> snapshot while looking like the live file — and Claude, pointed at it, would
> answer from stale books without knowing.

**Read the Manifest tab first, and tell Claude to.** The workbook is the
interface now, so everything the tools used to attach to an answer lives there:
the company as Tally spells it, the currency *and how it was established*, the
period, the as-at stamp, a row count per tab, which voucher flags to exclude
before totalling anything, and every warning TallyPrime produced, verbatim. A
`Not in this workbook` tab names what TallyPrime holds that this interface
cannot read, so a silence is never read as a zero.

### What it does on each run

The task wakes on its interval and asks one cheap question: **has anything
changed?** A collection fetching only `AlterId,MasterId` costs about **537KB in
200ms**, against roughly 20MB and 10–20 seconds for a full export. Only when the
answer is yes does it do the real work — plus once a day regardless, so the
as-at stamp always advances and a stale file cannot masquerade as a current one.

It compares the **set** of `(MasterId, AlterId)` pairs, not the maximum. A
maximum cannot see a deletion: remove any record other than the highest and the
maximum is unchanged, so a workbook validated on one would keep serving a
voucher that no longer exists.

> **The prerequisite, which is not optional.** All of that rests on `ALTERID`
> moving on **every** edit, including deletions. That is unproven, and it is a
> question about whether the change check is SOUND — not about the interval.
>
> An earlier version of this section claimed the default was hourly *because* of
> this risk. That was wrong. The interval does not affect it: a deletion that
> goes unnoticed is missed exactly as much at sixty minutes as at one. What
> bounds the damage is the guaranteed daily export, which runs at any interval.
> Hourly bought nothing in safety and cost an hour of freshness, so the default
> is now five minutes.
>
> To settle the real question, somebody has to be at a **licensed** TallyPrime —
> the Educational version cannot make the edits — and run
> `npm run prove:alterid` on a **scratch company**. It asks for one edit at a
> time (alter, add, delete) and reports MOVED or DID NOT MOVE after each. If any
> step fails, record it in `docs/known-limitations.md`: a change check that
> misses an edit produces a workbook that looks current and is wrong, and no
> interval fixes that.

### When it fails

Nobody is watching a scheduled task, so a failure has to be visible without
opening anything:

- **A filename in the folder** — `LAST RUN FAILED - TallyPrime was not open -
  2026-08-19 18-05.txt`, or `LAST RUN OK - ...`.
- **A line in `run-log.txt`** beside it. Minutes that found nothing changed are
  counted rather than logged, so the log stays readable instead of gaining 1,440
  lines a day.
- **A Windows toast, on a CHANGE OF STATE only.** The first failure notifies,
  repeats go quietly to the log, and recovery notifies once. At a one-minute
  cadence, notifying every failure would fire once a minute for as long as
  somebody leaves the workbook open in Excel — which trains people to ignore it.
- **`Check-Tally`** reports the last run's outcome and how old the workbook is,
  so "this spreadsheet is four days old" gets said out loud.

**Nothing appears on screen.** The scheduled task runs
`Run-Export-Hidden.vbs`, which starts the export with its window hidden from the
outset. A `.bat` action would create a console window once a minute, all day, on
a machine somebody is trying to work on — and `-WindowStyle Hidden` does not fix
that, because the window is created and then hidden, which still flashes.

The alternative — running the task whether or not the user is logged on — is
genuinely windowless but was rejected: that session has no desktop, so it cannot
raise the failure toast, and a quiet export is exactly what this design is trying
not to be. So the session stays interactive and the window is hidden instead.
Windows Script Host is deprecated, so its absence is checked rather than assumed;
without it the task falls back to the visible `.bat` and Setup says so, because a
visible window on every run is annoying while an export that never runs is not
something anybody would notice.

Double-click `Run-Export.bat` yourself when you want to watch a run.

**On a laptop, one Task Scheduler default would have broken this silently.**
`schtasks` writes `DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` as
true by default — so unplugging the machine stops the export, resuming only when
somebody happens to plug it back in, with nothing announcing either. The task is
therefore registered from a full XML definition rather than the one-line form,
with both set to false, plus `StartWhenAvailable` (run a start that was missed
while the machine was off or asleep) and a one-hour `ExecutionTimeLimit` —
because `MultipleInstancesPolicy` is `IgnoreNew`, and one hung run would
otherwise block every later run for the default 72 hours.

A failed run never damages good output: the workbook is written under a
temporary name and renamed over the target, which is atomic. If Excel has the
file open the rename fails, the run says so, and this run's data is kept under a
dated name rather than thrown away.

### What it cannot tell you

**Whether Google Drive uploaded it.** The exporter can confirm it wrote the file
to disk; the sync is Drive Desktop's business. If Drive is signed out or paused,
the local file is correct and the cloud copy is stale, and only Drive's own icon
will say so. Since Claude reads the cloud copy, **the as-at stamp on the
Manifest is the reader's only defence** — which is why it is there.

### Changing the folder later

Run `Setup` again. It shows the folder in use and offers to keep it, so changing
one other answer does not mean re-finding a folder somebody chose weeks ago. The
picker also opens *at* the current folder rather than guessing.

If you do change it, the setting moves immediately — the next scheduled run
writes to the new place, nothing needs restarting.

**It offers to move the old spreadsheets across.** Say yes and each company's
workbook, its `Archive\` and its state file are copied to the new folder and then
removed from the old one — so there is only ever one copy of a client's books.
The next scheduled run overwrites the workbook with fresh figures; the archive
copies are left as they are.

Three safeguards, because this is the only part of the installer that deletes
anything:

- **It moves only what the exporter created**, recognised by the state file it
  writes rather than by name. If you picked a folder that also holds payroll
  scans or someone's working papers, those are left exactly where they are and
  the old folder is not removed. It says how many it left alone.
- **Copy, verify, then delete** — in that order. Anything that could not be
  copied is left in place rather than deleted, and named so you can move it by
  hand.
- **It asks first**, and warns that if the old folder is inside Google Drive,
  removing files locally removes them from Drive as well — for everyone it is
  shared with. Say no and it leaves a `THIS FOLDER IS NO LONGER UPDATED` note
  instead, touching nothing.

Why move rather than leave both: an abandoned workbook is **frozen and still
looks current**. If it is still syncing, Claude pointed at it would answer from
books that stopped updating, and the only clue would be an as-at stamp nobody
thought to check.

You can also edit `TALLY_EXPORT_FOLDER` in `.env` directly, but then nothing
moves and nothing warns you. Setup is the safer route.

### Where to put the folder

In a **Shared Drive**, not somebody's My Drive, so the team sees it and it does
not disappear when one person leaves. One folder per company is created
automatically, so a single client's folder can be shared without exposing the
others.

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
| `TALLY_CURRENCY_LABEL` | *(unset)* | Currency label to use **only** where TallyPrime could not transport its own symbol (it substitutes `?` for `₹`, `€` and others before the data leaves). Two forms: a bare `EUR`, which applies only when exactly ONE company is loaded, or `Company Name=EUR;Other Company=INR` per company. The bare form is restricted because a German and an Indian company both report `?`, so a global `EUR` would label rupees EUR. Never overrides a symbol that arrived intact, and the response always says the label came from configuration rather than from Tally |
| `TALLY_CACHE_TTL_MS` | `300000` | Reuse an identical Tally response, and the records parsed from it, for this long. **The biggest lever on audit speed** — see below. `0` disables caching |
| `TALLY_EXPORT_FOLDER` | *(unset)* | Where the scheduled export writes its workbooks. An ordinary **local** folder — nothing here calls a Google API. Put it inside a folder Google Drive Desktop syncs and Drive's own client uploads it. Unset means no export is configured |
| `TALLY_EXPORT_COMPANIES` | *(all open)* | Which companies to export, semicolon-separated. Naming them is what stops a workbook being labelled one company and read from another. A named company TallyPrime does not have open is refused by name, never skipped silently |
| `TALLY_EXPORT_INTERVAL_MINUTES` | `5` | How often the scheduled task wakes. Most wakes cost one ~200ms question and stop there. `1` is the design's own cadence; raise it if TallyPrime is under load |
| `TALLY_EXPORT_FORCE` | `false` | Export even when nothing changed. What `Run-Export.bat --force` sets |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

Invalid configuration fails at startup with a message naming every bad value
at once, rather than failing mysteriously on first use.

### Speed and size: the two settings that matter

> Per-tool token and timing figures, measured against a live install, are in
> **[docs/performance.md](docs/performance.md)**. They cover the 19 tools that
> existed on 2026-08-13; `tally_get_closing_stock` is not yet measured, though its
> live responses were 2.5KB and 264B, so it is among the cheapest calls here.

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

20 tools, registered in [src/server/mcpServer.ts](src/server/mcpServer.ts). Modes
of the same tool (e.g. list vs. get-by-name) are noted in one row rather than
repeated.

| Tool | Purpose |
|---|---|
| `tally_connection_status` | Check reachability; returns a specific fix on failure |
| `tally_list_companies` | The company TallyPrime currently has loaded |
| `tally_get_company` | Company profile — size, groups, fields in use; `includeFeatures` infers which TallyPrime features the data shows in use |
| `tally_get_masters` | Master data behind one `type`: `ledger` (chart of accounts, balances, GSTIN, related-party flag), `group` (the hierarchy, and whether a group is P&L or balance sheet), `voucherType` (the transaction types this company defines, with the built-in each derives from and its numbering series), `stockItem` (inventory masters). Each supports list, search, filter with `conditions`, and — for ledgers and stock items — fetch one by exact `name` |
| `tally_get_ledger_transactions` | Statement of movements on one ledger, with a running balance |
| `tally_get_party_statement` | Every matching ledger for a party name, plus other mentions, in one call |
| `tally_get_statement` | `trial_balance` / `balance_sheet` / `profit_loss` / `cash_flow` / `fund_flow`, optionally compared across two periods — see below |
| `tally_get_vouchers` | Transactions in a period: list, filter by ledger/party/narration/type/amount/field, fetch one by number, or restrict to a trading `family` |
| `tally_summarise_movements` | Totals per ledger, group, month, voucher type or party, summed in exact decimal on the server. Use it whenever the answer is a figure rather than a list — about 16x smaller than reading the transactions |
| `tally_get_inventory_movements` | Stock movements, derived from voucher inventory lines |
| `tally_get_closing_stock` | Closing quantity, rate and value `by: 'item'` or `by: 'godown'`, from TallyPrime's own summary reports. The only location-wise stock path. The rate is rounded — see below |
| `tally_get_outstanding` | Receivables or payables with bill references; `includeAgeing` buckets by bill AGE, not overdue — see below |
| `tally_get_gst` | `summary` (tax ledgers/registration in use) or `transactions` (GST-bearing vouchers), as recorded, never calculated |
| `tally_search` | Cross-entity search over ledgers, vouchers and stock items |
| `tally_get_bank_reconciliation` | Bank instruments with cheque/UTR detail and reconciled status — see below |
| `tally_check_tie_out` | Does the arithmetic hold? Every voucher balances, every ledger rolls forward |
| `tally_calculate_materiality` | Overall / performance / clearly-trivial thresholds, with the basis recorded |
| `tally_test_vouchers` | One audit procedure over a voucher population: `journal_screen`, `benford`, `sample` (reproducible, returns its seed), `duplicates`, `round_numbers`, `cutoff`, `weekend`, `late_entry` (written long after the date it carries — the last save only, never who saved it), `related_party`. Returns **candidates for review, never findings** — see below |
| `tally_get_report` | TallyPrime's own built-in views from a closed, live-verified allowlist: `negative_ledgers`, `negative_stock`, `ratio_analysis`, `sales_register`, `purchase_register`, `journal_register`, `bills_receivable`, `bills_payable`, `cost_category_summary`. Columns keep Tally's own tag names — see below |

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
- **The statements honour the requested END date only when it falls on a 31st.**
  Established live by sweeping nineteen end dates with the cache off: `fromDate`
  always binds; `toDate` binds when its day of the month is the 31st and is
  ignored on any other day, including a real month end like 30 November — the
  observation that rules out "last day of the month" as the rule. When ignored, the
  figures accumulate to the end of the company's own book year. Every response
  carries `coversPeriodRequested`, and where it is false the figures are a
  cumulative position, not the period asked for, with the nearest workable end date
  named. **Period comparison is refused when either side's end date is not
  honoured** — including the asymmetric case, since a bound period minus an
  unbound one yields minus the whole of the earlier period, a wrong figure of
  exactly plausible size. The trap to remember: **30 June and 30 September do not
  bind**, so the two quarter ends most people reach for are the two that silently
  widen. Beyond that, comparison pairs rows by name only where unambiguous, and
  computes no change against a null.
- **The financial year is read from the company, not assumed to be April.** A
  company's year is twelve months from the month and day its own books begin, taken
  from Tally's `STARTINGFROM` and `ENDINGAT`. Assuming April produced a period that
  did not contain a calendar-year company's data at all — and an inverted range in
  a user-facing warning.
- **`tally_get_closing_stock`'s rate is rounded.** Quantity × rate does not equal
  the value Tally reports; on the live company half the item rows disagreed. The
  value is Tally's own figure and is never recomputed. Quantities keep their unit
  as a string ("9500.00 Kg") because a bare stock number is meaningless. It reads
  the summary REPORT while `tally_get_masters` with `type: 'stockItem'` reads the
  MASTERS — two bases for one question, and neither is adjusted to match the other.
- **`includeAgeing`** buckets bills by how long ago they were **raised**, not by
  how overdue they are — Tally does not reliably record credit terms, and this
  server will not assume them. Bill references are netted first, and the schedule
  covers only bills raised inside the requested period, which it says on every
  call. Supply `creditTerms` (per party or per group) and it will additionally
  report what is **genuinely overdue**; without terms for a party there is no
  overdue figure at all, rather than a zero that would read as "nothing overdue".
  `ageingPreset: 'schedule_iii'` switches the buckets to the Schedule III
  disclosure periods, computed as real calendar months back from the as-at date.
  That is the ageing half of the note only: the disputed/undisputed and
  good/doubtful splits are a legal fact and a judgement respectively, neither is
  in TallyPrime, and the tool refuses to invent them.
- **`tally_test_vouchers` returns candidates for review, not findings.** A round
  amount is usually rent and a weekend date is usually nothing; none of the nine
  tests can establish that anything is wrong. Every result carries that sentence,
  plus the size of the population it tested and what was excluded — orders and
  cancelled vouchers never belong in these tests, and a test run over a
  contaminated population still returns a confident-looking answer. Two limits
  worth knowing: the weekend test reads the date **on** the voucher rather than the
  date it was entered (the real out-of-hours test needs the Edit Log, which is not
  reachable), and journals are identified by their type **name** containing
  "journal", because TallyPrime has no manual-journal flag.
- **`late_entry` reads the last save, and nobody's name comes with it.** It answers
  "this entry was written months after the date on its face", which is the cut-off
  question. It cannot tell an entry keyed in late from one keyed in on time and
  altered later, it does not say who did either, and it is not an audit trail — that
  needs TallyPrime's own Edit Log, which is not reachable over this interface. On a
  company that does not record save times the test **refuses to run** rather than
  reporting that nothing was found.
- **`tally_get_report` keeps TallyPrime's column names.** Rows come back as a name
  plus an `amounts` map keyed by Tally's own tags (`DSPCLDRAMTA` and so on) rather
  than relabelled debit/credit — asserting a column meaning that has not been
  verified produces a figure that is right in value and wrong in meaning. Four of
  the nine IDs were accepted by a live TallyPrime but returned nothing on the
  company tested, so their row shape is unproven and every call says so.

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
  verb exists anywhere. This covers the scheduled export too: it sends the same
  builders' requests and writes nothing to Tally.
- **The daily spreadsheet puts data in Google Drive — read that section.** No
  Google API is called from this codebase and no credential is created here, so
  none can leak. But the folder is deliberately one Drive syncs, and that is a
  decision to take on purpose rather than to discover later. See
  [The daily spreadsheet](#the-daily-spreadsheet).
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
gh release create "v$(node -p "require('./package.json').version")"   "release/TallyPrime-for-Claude-$(node -p "require('./package.json').version").zip"   release/SHA256SUMS.txt --notes-from-tag
```

`npm version` runs `verify` first, then stamps the `## <version> — unreleased`
heading in [CHANGELOG.md](CHANGELOG.md) with the released version and today's
date, and includes it in the version commit. The version an install reports
comes from `package.json`, so this keeps the number a user reads back during
support and the notes describing it in the same commit.

> **Attach BOTH assets, every time.** Installed copies update themselves from
> the GitHub release, and they refuse to unpack a download whose SHA-256 they
> cannot verify against `SHA256SUMS.txt`. A release published without that file
> is one no existing install will take — which is the intended failure, since the
> alternative is unverified code running against somebody's books. The packager
> prints both paths and says the same thing.

### How an installed copy updates itself

The install is split so that a new version is a folder rename rather than a
config edit:

```
TallyPrime for Claude/        <- stable; never replaced
  Setup.bat, Check-Tally.bat, Run-Export.bat
  node/node.exe               <- the bundled runtime
  launch.mjs                  <- what Claude Desktop is pointed at
  .env, update-state.json     <- the user's settings and update bookkeeping
  app/                        <- replaced on every update
    package.json, dist/, scripts/, node_modules/
```

- The export task also asks GitHub whether a newer release exists
  ([update.mjs](installer/scripts/lib/update.mjs)). If so it downloads it,
  verifies the checksum, and unpacks it to `app.next/`. **Nothing touches the
  running `app/`**, so a failed or corrupt update is a no-op rather than a
  broken install.
- [launch.mjs](installer/launch.mjs) promotes `app.next/` at the next Desktop
  start — the one moment nothing holds the current version open — keeping the
  old one as `app.previous/`.
- If the promoted version cannot even be imported, the launcher restores the
  previous one and records the bad version so the next check will not fetch it
  again. A later release supersedes the refusal.

Because `.env` lives above `app/`, an update cannot reset the export folder or
the schedule. That matters more than it sounds: a reset would leave the exporter
running with nothing configured, and the workbook would silently stop refreshing
while still looking current.

Self-updating requires this layout, so a copy predating it needs one manual
reinstall. After that, releases arrive on their own.

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
