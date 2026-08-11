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

---

## 1. Build `tally_get_report` — the escape hatch

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

## 2. Re-probe the six empty report IDs

Once the richer company is available: `Cost Centre Summary`, `Godown Summary`,
`Bills Receivable`, `Bills Payable`, `Stock Summary`, `Ledger Vouchers`.

Follow the method in the reproducing section of
[report-id-verification.md](report-id-verification.md) — health probe between
every candidate, hash every response, nothing unsaved in Tally first.

Same trip closes the two long-standing unverified areas — inventory and
sales — recorded in [project-status.md](project-status.md).

## 3. Ship it so an accountant can install it

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

## 4. Narrow the report-ID caution in the docs

[known-limitations.md](known-limitations.md) says an unresolvable report ID can
terminate TallyPrime. Verified false for named reports — they reject cleanly.
True and important for undefined collections.

Worth fixing because, as written, it discourages exactly the verification
step 2 depends on.

---

## Decisions to make, not tasks

**Cash flow and fund flow.** Tally returns real month-by-month movement, so the
"unverified path" objection is gone. The other objection stands: Tally supplies
no operating / investing / financing split, and that split is what makes a cash
flow statement. Either return the movement data labelled honestly as monthly
movement, or keep refusing. Pick one deliberately.

**Write support.** "Post this entry" will never work while the server is
read-only. That is a defensible design choice, but if "any prompt" is meant
literally then read-only is the ceiling, and this becomes a much larger project
than anything above.

**Caching.** No caching today, so masters are refetched every turn against a
single-threaded Tally. A short TTL would make multi-step investigations
noticeably faster. Worth doing only if it starts to feel slow.

---

## Not on the list, on purpose

- **Multi-company** — Tally serves one open company. A hard limit, not a gap.
- **`tally_get_day_book`** — a settled decision; the report ignores its date
  range. `tally_list_vouchers` covers the ground correctly.
- **Thresholds and audit rules** — deliberately absent. What counts as
  suspicious belongs to the user and Claude, not to a constant in this server.
