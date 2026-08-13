# Next steps

What to do when work resumes. Paused 2026-08-10 by choice, not blocked by a
bug — the code is clean, tested and working.

The goal driving all of this: **a user types any prompt, and the bridge can
answer it.** Every item below is ranked by how much it moves that, not by how
interesting it is.

Reference for step 1: [report-id-verification.md](report-id-verification.md).

---

## Waiting on

**A TallyPrime company that uses more features** — cost centres, inventory,
bill-wise details. Six report IDs are confirmed valid but return nothing on the
company probed so far, so there is no way to know what their data looks like.
This is the only real blocker, and no amount of code fixes it.

**Still true after 2026-08-12.** A second company was probed live — a US LLC on
a 25-26 financial year, 453 vouchers — and it does not close the gap. Counted directly in its
raw voucher register for the full year: **zero** cost centre allocations, **zero**
populated bill references (919 allocation blocks, all empty scaffolding), and
**zero** populated bank reconciliation dates. It does carry 43 inventory entries
and real bank instrument detail, which is what made the bank tool verifiable.

So three things now wait on the same missing company rather than on code: cost
centres, bill ageing against real bills, and the `reconciled: true` branch of the
bank tool. Worth asking whoever can supply a set of books that uses bill-wise
billing and reconciles its bank — one company would close all three.

---

## 1. Build `tally_get_report` — the escape hatch — PARKED

**Parked 2026-08-12: revisit only when the richer company in "Waiting on" is
available.** The design below stands, but the six highest-value report IDs all
return empty on the company available today, so building it now would ship a
tool that cannot be verified end-to-end. Until that data exists, this is not
planned work.

**The problem it solves:** the server answers ~30 fixed questions. Ask about
cost centres, ratios or registers and there is no path at all.

**What to build:** one tool that pulls a named Tally report, restricted to an
allowlist of verified IDs. Most of the plumbing exists —
`buildReportRequest` in [../src/tally/requests.ts](../src/tally/requests.ts)
already does the wire work.

**Non-negotiable:** the report name is **allowlist-only**, never freeform text
from the model. A guessed ID is safe on a report but the habit is not worth
forming, and an end user with unsaved books should never be exposed to it.

**Start from:** the 12 verified IDs. `Ratio Analysis`, `Sales Register`,
`Purchase Register` and `Statistics` are the highest-value ones not already
covered by an existing tool.

**Two shapes to handle:**
- `Ratio Analysis` returns pre-formatted strings with `Dr`/`Cr` suffixes, not
  numbers. Do not parse these into figures and lose the sign convention.
- `<ENVELOPE></ENVELOPE>` means "report exists, this company records nothing".
  It must not be reported as an error or as zero — say the company does not use
  the feature.

**Honest expectation:** this takes the server from roughly 30 answerable
questions to roughly 38. A real improvement, not open-ended coverage.

### Built 2026-08-12 instead — the four gaps that needed no probe

Four things a working accountant asks for were buildable from verified paths, so
they were done while step 1 stays parked: `tally_get_voucher_types`,
`tally_get_bank_reconciliation`, period comparison on `tally_get_statement`, and
opt-in bill ageing on `tally_get_outstanding`. See
[project-status.md](project-status.md#added-2026-08-12--four-gaps-closed-without-a-probe-trip).

What is still blocked on the probe trip below, and deliberately not attempted:
**cost centres** (branch/project P&L, the single largest remaining gap),
**sales/purchase registers** (month-wise totals instead of fetching every
voucher), **ratio analysis**, and the **audit trail** of altered and deleted
vouchers. All four need a report ID, and a wrong ID closes TallyPrime.

## 1b. Establish whether the statement END date can be made to bind — TRIED, CLOSED 2026-08-13

Found 2026-08-12: `Trial Balance`, `Profit and Loss` and `Cash Flow` honour
`SVFROMDATE` and **ignore `SVTODATE`**, accumulating to the financial year end.
See [known-limitations.md](known-limitations.md#the-statements-ignore-the-requested-end-date-and-accumulate-to-the-year-end).

**Six candidates tried live, none worked.** Ran
[scripts/probe-statement-period.ts](../scripts/probe-statement-period.ts) against
the verified `Cash Flow` report ID with `TALLY_PROBE_CONFIRM=yes`: baseline
reproduced the bug (9 rows for a 3-month request), and `SVCURRENTDATE`,
`SVISPERIODICREPORT`, `SVVIEWNAME Monthly`, a duplicated `SVTODATE`, and
replacing `SVFROMDATE`/`SVTODATE` with `SVPERIODFROM`/`SVPERIODTO` all either
changed nothing or made it worse (the last returned 12 rows — Tally didn't
recognise those names and fell back further). TallyPrime answered throughout;
no crash, no wedge, exactly as the safety case predicted since unknown static
variables are documented to be ignored rather than rejected.

**Not a missing request setting.** Full account in
[known-limitations.md](known-limitations.md#the-statements-ignore-the-requested-end-date-and-accumulate-to-the-year-end).
The mitigation already shipped (refuse mid-year comparison, flag mid-year
statements as a cumulative position) is the answer, not a placeholder. Closed —
do not re-run without a new, specific, documented candidate to try, since this
run already covers the space of reasonable guesses.

## 2. Re-probe the six empty report IDs

Once the richer company is available: `Cost Centre Summary`, `Godown Summary`,
`Bills Receivable`, `Bills Payable`, `Stock Summary`, `Ledger Vouchers`.

Follow the method in the reproducing section of
[report-id-verification.md](report-id-verification.md) — health probe between
every candidate, hash every response, nothing unsaved in Tally first.

Same trip closes the two long-standing unverified areas — inventory and
sales — recorded in [project-status.md](project-status.md).

## 3. Ship it so an accountant can install it — BUILT and self-piloted 2026-08-12

Built as specified below. Everything the user touches lives in
[../installer/](../installer/) — `Setup.bat`, `Check-Tally.bat`, the `scripts/`
behind them, `READ ME FIRST.txt`, and `package.ps1`, which assembles the zip with
a bundled Node runtime. Release notes are in [../CHANGELOG.md](../CHANGELOG.md).

Note the deliberate flattening: `installer/` is a repo convenience, but
`package.ps1` copies its contents to the ROOT of the shipped folder, because
finding and double-clicking `Setup.bat` is the entire user interface. The scripts
locate the server by walking up to the nearest `package.json`
(`installer/scripts/lib/paths.mjs`) rather than counting directories, so they run
correctly from both layouts — including in place during development, which is
how the bugs below were caught.

Build a release with:

```
powershell -ExecutionPolicy Bypass -File installer\package.ps1
```

Verified against the live install on 2026-08-11: the assembled folder runs from a
path containing spaces, finds the open company, and reports its version.

**Full end-to-end run 2026-08-12.** Built the 0.1.0 zip, extracted it, ran
`Setup.bat` and `Check-Tally.bat` from `Documents\...`, and spoke raw MCP over
stdio to the shipped `dist/index.js` exactly as Claude Desktop launches it —
handshake, `tools/list` (14 tools), and a live `tally_connection_status` against
TallyPrime on 9000. Setup refused a temp-folder install, preserved an unrelated
connector and an unrelated top-level setting, replaced a stale `tally` path, and
wrote its backup.

Run the config-writing part against a throwaway profile rather than your own:
setup.mjs and doctor.mjs both resolve the config from `%APPDATA%`, so setting
that to a scratch folder gives a real run with nothing of yours at risk.

What is still NOT done is the part no local run can cover: **nobody outside this
machine has installed it**, and no run has gone through Claude Desktop actually
launching the server and answering a question. The stdio check above proves the
server works when launched that way; it does not prove Desktop reads the config
as expected.

That run found one real bug, now fixed: the doctor reported "pointed at a
different copy" and then concluded "All good", because the verdict looked only
at whether Tally was reachable and ignored the wiring and temp-location checks.
It now collects every problem and reports them together. Note the verdict logic
still has no test — it lives inline in `main()` in `doctor.mjs`, unlike the
`lib/` helpers beside it, which all have one. Extracting the wiring check into
`lib/` is the obvious fix if that code is touched again.

One trap found while building the doctor, recorded because it will catch the next
person: the connection probe's response puts company records under `<DATA>`,
while `<DESC><CMPINFO>` carries a `<COMPANY>0</COMPANY>` element that is a COUNT,
and real tags carry attributes (`<NAME TYPE="String">`). Reading the whole body,
or matching a bare `<NAME>`, yields a confident "no company is open" against a
Tally that has one open. Covered by tests/setup/probeExtract.test.ts. Do not
hand-copy Tally request XML into scripts either — `installer/scripts/lib/probe.mjs`
imports the server's own builder for that reason.

### The original plan, for reference

**The audience is accountants, not developers.** That decides the shape of this
entirely. An accountant will not open a terminal, will not install Node, and
will not hand-edit a JSON config file. Any one of those loses them.

Today [../.mcp.json](../.mcp.json) hardcodes an absolute path into a Desktop
folder and points at `dist/`, so it works on one machine, after a build, in one
directory. For anyone else it silently fails to connect.

### Recommended: portable folder, not an installer

Ship a **zip they unzip anywhere**, containing the bundled Node runtime and the
server, plus one `setup.bat` (or a small setup executable) they run once.

Why portable first:

- **No admin rights required.** Many accountants are on locked-down office
  machines and simply cannot run an installer. This is often the deciding
  factor, not a convenience.
- **Nothing to uninstall** — delete the folder.
- **Far less work to ship** — no installer toolchain, no code signing.
- **Easy to pilot.** Zip it to one friendly accountant and watch where they get
  stuck before investing in packaging.

The two real downsides, and the fix for both: the folder path ends up inside the
Claude Desktop config, so moving or renaming the folder breaks the bridge
silently — the same failure mode as today's hardcoded Desktop path — and there
is no Start Menu entry to re-run diagnostics from. **Have `setup.bat` rewrite
the config with its own current location every time it runs**, so "move the
folder" is repaired by running setup again, and tell users that in one line.

Graduate to an `.exe` / `.msi` installer only if real users struggle with the
unzip step. The config-writing logic is identical either way, so nothing is
wasted by starting portable.

Note what packaging does *not* buy: an MCP server is launched by Claude Desktop,
never by double-clicking, so neither an `.exe` nor a portable folder removes the
need for the setup step below.

### What setup has to do, in order of how much each prevents a failed install

1. **Write the Claude Desktop config automatically.** Locate
   `claude_desktop_config.json`, add this server, preserve any servers already
   configured. This matters most — hand-pasting JSON is where non-technical
   installs die.
2. **Handle TallyPrime's HTTP port.** The server needs Tally listening on port
   9000, which is a setting inside TallyPrime (Gateway → F1 → Advanced Config).
   Most accountants have never opened it. Expect this to be the single largest
   source of support questions; enable it during setup if possible, and explain
   it plainly if not.
3. **`doctor` as a window, not a command.** "TallyPrime is not running", "no
   company is open" — in plain language, with the fix, not an error code.

**What no packaging can hide:** TallyPrime must be open, with the right company
loaded, because Tally serves one company at a time. That belongs on a one-page
"before you start" sheet rather than being engineered around.

## 4. Narrow the report-ID caution in the docs — DONE 2026-08-12

[known-limitations.md](known-limitations.md) now says what was verified: named
report IDs reject cleanly; the danger belongs to undefined *collections*.

---

## 5. Performance pass — DONE 2026-08-13, two levers deliberately left

Prompted by a user report that an audit used over 20% of a session and took too
long. Fixed and measured: uniform-field folding, a lower response ceiling, a
5-minute parsed-record cache, and validating before fetching. Full account,
including what it cost and bought, in [performance.md](performance.md).

Two things were identified but **not** done, both because they trade something
away rather than being free:

- ~~**Shrink the 21MB voucher-register fetch itself**~~ — **done 2026-08-13, for a
  different reason than performance.** The custom `COLLECTION` over vouchers turned
  out to be not an optimisation but a necessity: the `Voucher Register` report
  returns no ledger entries at all, so it could not answer the questions built on
  it. The collection was reached with the probe discipline this file demands — one
  request at a time against a live install, only documented collection types — and
  the fetch fell to 8.6MB / ~2.0s (18.3MB with full field detail). The trade-off
  went the other way from the one anticipated: a collection ignores the date range,
  so the whole book is fetched and dates are applied locally.
- **A local read-only cache** (SQLite or similar) so aggregate questions across
  periods do not each cost a fresh fetch. **This got stronger, not weaker**: because
  the collection ignores `SVFROMDATE`/`SVTODATE`, a narrow date range no longer
  reduces the fetch, so the per-question floor is now the whole book every time the
  cache lapses. Still contradicts `PROJECT_SPEC.md`'s "no database" line and adds
  staleness on top of the cache TTL already accepted. A deliberate architecture
  decision, not a tidy-up.

## 6. Efficiency pass — DONE 2026-08-13, four items deferred with reasons

Prompted by asking how to spend fewer tokens per session without losing accuracy.
Three changes taken, four declined or deferred. Detail in
[project-status.md](project-status.md#efficiency-pass-2026-08-13) and
[performance.md](performance.md).

**Done:** the nested-structure fetch split (receivables 7.7s → 2.6s, bank rec 6.2s →
3.0s, stock movements 5.8s → 2.6s); `tally_summarise_movements` for server-side
Decimal totals (~16x smaller than reading the rows); and a tool-list trim of ~3,500
tokens with all 15 behavioural rules asserted still present.

**Still open, in the order I would take them:**

### 6a. Prove `ALTERID` - probe BUILT 2026-08-13, needs a human with Tally open

The highest-value performance idea left, and the one that must not be taken on faith.
Tally stamps `ALTERID` on every record. If a cheap request for the maximum `ALTERID`
can prove nothing has changed, a 2.6s / 8.6MB refetch becomes a ~30ms check, and the
five-minute staleness trade-off disappears — the cache becomes correct by validation
rather than by expiry, so the TTL could be hours.

**Measured and ready:** a collection over `Voucher` fetching only `AlterId,MasterId`
costs **537.6KB in 199-274ms** against 8.6MB / ~2,000ms for the full fetch - 16x
smaller, 10x faster. The shape is in `src/tally/requests.ts` as
`buildVoucherAlterIdRequest`, so the Export-only guarantee covers it; no tool calls it.

**What is left is not code.** It is only safe if `ALTERID` changes on EVERY edit,
including deletions - otherwise the server serves stale figures confidently, which is
worse than today's honest expiry. Run `node scripts/probe-alterid.mjs` for a baseline,
then ALTER a voucher, then ADD one, then DELETE one, running
`node scripts/probe-alterid.mjs --compare` after each. All three must report MOVED. If
any reports UNCHANGED, write that into known-limitations.md and abandon the idea rather
than working around it. Use a scratch company: deleting a voucher is a real change to
real books.

### 6b. A local read-only cache across sessions - needs a decision, not code

Now stronger than when it was first declined: because the collection ignores the date
range, the per-question floor is the whole book every time the cache lapses, and a
Claude Desktop restart discards everything. Still contradicts the "no database" line in
`PROJECT_SPEC.md`, and it writes a client's books to disk — a privacy decision, not an
optimisation. Wants 6a first, since `ALTERID` is what would make a persisted cache
safe to trust.

### 6c. Curated scalar fields instead of `FETCH *` - EXAMINED 2026-08-13, declined

Four tools still pay the 18.3MB full fetch for scalar fields: GST transactions,
`tally_search`, party statement, and voucher detail with `includeAllFields`.

Examined and **declined**, because of what those four actually do with the fields.
`fieldMatch` and `tally_search` search the VALUE of every field precisely because the
field NAME differs between companies - that is the documented reason they exist. GST
detection works the same way, matching name fragments (GST / HSN / PLACEOFSUPPLY)
rather than a fixed list. A curated list would have to enumerate field names nobody can
know in advance, and omitting one would silently drop data a company does populate:
the exact failure `includeAllFields` exists to prevent, traded for ~10MB.

Reconsider only with a per-company field census showing the curated list is complete
for that company - which is itself a full-field fetch, so the saving would apply from
the second call onward at best.

### 6d. Summary-first responses and a smaller default `pageSize` — DECLINED, revisit only with evidence

Both were declined on accuracy grounds rather than effort: they risk an incomplete
answer reading as a complete one, and a receivables list missing page 2 looks exactly
like a full one. `tally_summarise_movements` now covers the legitimate half of the
idea — a caller who wants a total can ask for one — without making omission the
default. Revisit only if a real session is found where the row-level response was the
thing that exhausted the context.

---

## Decisions to make, not tasks

**Cash flow and fund flow — DECIDED and shipped 2026-08-12.** Both tools now
return Tally's own month-by-month movement (debit, credit, net per month),
labelled explicitly as movement and never as a classified statement. The
operating/investing/financing split remains a judgement for the accountant, as
the tool descriptions say. See [../src/tools/flowReports.ts](../src/tools/flowReports.ts).

**Write support.** "Post this entry" will never work while the server is
read-only. That is a defensible design choice, but if "any prompt" is meant
literally then read-only is the ceiling, and this becomes a much larger project
than anything above.

---

## Not on the list, on purpose

- **Multi-company** — Tally serves one open company. A hard limit, not a gap.
- **`tally_get_day_book`** — a settled decision; the report ignores its date
  range. `tally_get_vouchers` covers the ground correctly.
- **Thresholds and audit rules** — deliberately absent. What counts as
  suspicious belongs to the user and Claude, not to a constant in this server.
