# Changelog

Written in plain English on purpose. Entries here get pasted into emails to
accountants, so they say what changed for the user, not what changed in the code.

The version an install reports comes from `package.json`. To check what someone
is running: they double-click `Check-Tally`, or ask Claude "what version of the
Tally connection are you using?".

Maintainers: the newest section stays headed `## <version> — unreleased` while
work accumulates. `npm version <patch|minor|major>` stamps it with the released
version and date and commits it alongside the bump, so the number and its notes
can never drift apart. See the Releasing section in the README.

## 0.3.0 — 2026-08-13

**Setup now works with Codex as well as Claude Desktop.**

Setup asks which app you use — Claude Desktop, Codex, or both — and writes the
right settings for it. Previously it only knew about Claude Desktop, so putting
this on a machine running Codex meant editing a configuration file by hand on
every laptop.

- Setup lists the apps and marks the ones it can see on that computer. Pressing
  Enter alone picks the sensible option, so nobody has to decide what to type.
- Your other connections are left alone, on both apps. Codex ships one of its
  own, and losing it would show up days later as an unrelated feature quietly
  going missing — so that case is covered by a test rather than by care.
- Re-running Setup updates the existing entry instead of adding a second one.
  That keeps "I moved the folder and it stopped working" fixable by running
  Setup again, which is the only repair that can reasonably be asked of anyone.
- A backup of the previous settings is saved before either file is written.

Both apps must be **fully closed and reopened** afterwards. Codex only reads its
settings when it starts, the same as Claude Desktop.

One limit worth knowing: this connects to TallyPrime on the same computer, so it
works with apps that run on that machine. A browser-based assistant cannot reach
TallyPrime at all, whichever app it is.

## 0.2.0 — 2026-08-13

Every answer now says where it came from and whether it is complete.

**Read this first: corrections to figures**

Testing against a real set of books on 13 Aug 2026 found that some answers were
wrong, not merely incomplete. All of these are now fixed and re-checked against the
same live books. If you relied on this connector before today, these are the things
worth re-running.

- **Transaction detail was missing entirely, and that made several answers wrong.**
  We were asking TallyPrime for transactions using a report that returns only the
  *headings* of each voucher — the date, number and party — and none of the actual
  debit and credit lines. Anything built on those lines was therefore blank or
  wrong: the "do the books tie?" check reported **34 problems on books that
  balance to the paisa**, and reported that it had checked **zero** vouchers while
  doing so. It now reads the lines properly. Same books, same question, today:
  452 vouchers checked, everything ties, no exceptions.
- **Amounts were labelled as rupees even when the books are not in rupees.** On a
  US company keeping accounts in dollars, $494,397.50 was reported as "494397.5
  INR". Nothing was ever converted — the number was right and only the label was
  wrong — but a wrong label is the more dangerous mistake, because it looks
  correct. Every figure now carries the currency your company actually uses.
- **A closing balance could be reported as the opening balance.** If TallyPrime
  returned any single amount on a ledger that we could not read, the ledger
  statement quietly showed the opening balance in the closing balance field. That
  is indistinguishable from an account that genuinely did not move. It now says
  plainly that the closing figure could not be worked out, and why.
- **Stock rates and quantities could come back 100 times too large.** Tally writes
  these with the unit attached ("1000.00 Kgs."), and the way we read numbers turned
  the unit's full stop into the decimal point. Anything we cannot read with
  confidence is now reported as unavailable rather than guessed at.
- **"Show me every transaction over ₹1,00,000" could silently leave some out.**
  A voucher whose amount we could not read was treated as being worth nothing and
  dropped. Those now appear, so a population you believe is complete is complete.
- **Bank narrations showed `&#13;&#10;` where the statement has a line break** —
  and, worse, searching a narration could not find a phrase that spanned the
  break, so the search missed transactions that did contain it.
- Two smaller ones: a party could be counted in its own ledger statement *and*
  listed again as an "other mention" of the same name, which double-counted it if
  you added the two; and the company's GST registration could be reported as
  missing when only the first transaction of the period happened not to carry it.
- **The trial balance and the ledger list could disagree about current assets,
  and neither said so.** On the books tested, "what are current assets?" answered
  **385,764.46** from the trial balance and **482,384.46** from the ledger list —
  a 20% gap, on the same company, for the same year. Both figures come from
  TallyPrime itself: its trial balance carries stock at the value it *opened* the
  year with, while its balance sheet and its ledger list carry the *closing*
  value. The whole difference, 96,620.00, is the year's stock movement. Nothing
  is adjusted — both numbers are Tally's own and either may be the one you want —
  but the trial balance now tells you when it disagrees with the ledgers, by how
  much, and which account explains it. Worth re-running if you have quoted a
  current-assets or total-assets figure from a company that carries stock.

**Faster, smaller, and one new thing you can ask for**

- **"What did we spend on X?" now comes back as a total, not a list.** A new
  question type — totals per ledger, account group, month, voucher type or party.
  The arithmetic is done exactly, on the server, in decimal; nothing is added up by
  guesswork. Ask "sales by month" or "which expense accounts moved most" and you get
  one line per month or per account instead of hundreds of transactions. It is about
  15 times smaller to answer, which means longer conversations before the session
  fills up.
- **Most transaction questions are now roughly twice as fast.** Bank
  reconciliation went from about 6 seconds to 3, receivables from about 8 to 2.5,
  stock movements from about 6 to 2.5. Nothing was traded away to get this: those
  tools had been asking TallyPrime for every field it holds in order to reach
  detail that was already arriving in the smaller request.
- **Questions after the first are now instant more often.** Several tools that used
  to force a second full download of the year now share the first one.

**What changed for you**

- Every answer now carries the company it came from, the time it was produced,
  the exact request sent to TallyPrime, how many rows came back, and — the
  important one — **whether anything was left out**. Before this, different
  tools said "there's more" in different ways, and one of them was easy to
  miss. Now there is a single answer in a single place, on every reply.
- This matters for workpapers. A figure you put in a file can now be traced
  back to the request that produced it and re-run later to prove it.

**Two new things you can ask for**

- **"Do the books tie?"** A single check that every voucher balances and that
  every ledger's closing balance really is its opening balance plus the year's
  movements. Run it before quoting any figure from these books — if it fails,
  the exceptions are listed with the amounts, and nothing else should be
  relied on until they are explained. Note it reports what it *could not*
  check separately from what passed, so the result is never better than the
  evidence behind it.
- **Materiality.** Overall, performance and clearly-trivial thresholds, worked
  out exactly and returned with the basis and the arithmetic written out. You
  supply the benchmark figure and Claude will ask you for it — deciding which
  number is "revenue" for a particular set of books is a judgement, and the
  tool will not make it for you.

**Four more things you can ask for**

- **Bank reconciliation.** "Which cheques haven't cleared yet?" Lists the bank
  entries for a period with their cheque or UTR numbers and whether each one has
  been reconciled in TallyPrime. If nothing in the period has been reconciled,
  it says the status is unknown rather than reporting everything as uncleared —
  those are different answers and only one of them is honest. It lists the items;
  it does not draw up the reconciliation statement, because deciding which side
  an uncleared item falls on is your call.
- **Compare two periods in one question**, on the trial balance, balance sheet,
  P&L or either flow report. You get both periods and the movement per line.
  Where Tally reported nothing for a line in one of the periods, no movement is
  shown — a blank in Tally is not a zero, and treating it as one would invent a
  change. **Read the note below before using this**: it only answers for periods
  ending at your year end, for a reason that turned out to matter a great deal.
- **Ageing of bills, if you ask for it.** Bills bucketed by how long ago they
  were raised — 30/60/90 days by default, or your own bands. Read the wording
  carefully: this is how OLD a bill is, not how overdue, because Tally does not
  reliably record credit terms and we will not assume them. It also tells you
  when the schedule is incomplete, which happens whenever an invoice was raised
  before the period you asked about.
- **Voucher types.** The list of transaction types this company actually uses,
  and how each one numbers its vouchers. Sounds dull; it isn't. Companies rename
  them — one real set of books calls its sales invoices "Export Invoice" and "GWI
  Invoices" — so asking for "sales" by name used to come back empty. It also
  reports whether TallyPrime would refuse a duplicate voucher number on that
  type, which is the first thing to check before reading anything into a repeated
  invoice number.

**Tested against real books**

All four were run against a live company on 12 Aug 2026. That found three things
worth telling you about, and the first one is important.

**TallyPrime ignores the "to" date on the trial balance, P&L and cash flow.**
Ask for April-to-June and it gives you April to the end of your financial year.
We proved it two ways on real books: a three-month cash flow request came back
with nine months in it, and a first-quarter trial balance came back with exactly
the same numbers as the whole year.

What that means for you:

- Those statements now tell you plainly, on every answer, whether the figures
  really cover the dates you asked for. When they don't, Claude will describe them
  as a running total from your start date instead of as that period's figures —
  because that is what they are.
- Comparing two periods is only offered where the dates end at your year end.
  Asking to compare two mid-year quarters is refused rather than answered. It has
  to be: because both sides run to the year end, subtracting them produced a
  figure that looked completely believable and was entirely wrong — on these
  books it would have said sales fell by 211,852.50 in the second quarter when
  sales were flat, because 211,852.50 was the whole of the first quarter.
- Asking about transactions in a date range is unaffected — that reads a different
  Tally report which does honour both dates.

This one is worth knowing about beyond this connector: if you export a mid-year
trial balance out of TallyPrime by any route, check what period you actually got.

The other two:

- The numbering method we first reported was wrong — TallyPrime keeps the real
  setting in a different place, and we were reading a leftover field that says
  "None" no matter what. Fixed, and the corrected version immediately showed
  something useful: on that company only one sales type would refuse a duplicate
  invoice number.
- Bank listings were a quarter larger than they needed to be, because TallyPrime
  attaches cash note-counting fields to every cheque and wire. The empty ones are
  now left out.

Two things we still cannot promise, and would rather say so: we have not yet seen
a company that reconciles its bank inside TallyPrime, so the "already reconciled"
label has never been shown against real data (if nothing is reconciled the tool
says the status is unknown, which is correct); and no company we have access to
uses bill-by-bill tracking, so the ageing schedule has never run on real bills.

**Audits use far less of the conversation now**

Reported: auditing one company used more than a fifth of a chat before much had
been asked. Measured on real books, and most of it was not your data.

TallyPrime attaches every field it supports to every transaction. On a full year,
204 fields came back on each voucher and **only 33 of them actually differed
between vouchers** — the other 171 were the same value on all 453, things like
"deleted: no" and "audited: no". Half of every detailed answer was those same
words repeated for each transaction.

- Those repeated values are now reported **once per answer** instead of on every
  transaction. Nothing is lost — they are moved, not removed, and each answer says
  where they went. A detailed page of 25 transactions dropped from about 54,000
  words-worth to about 19,600: **roughly a third of what it was.**
- A single answer can no longer be enormous. The size limit per answer was set to
  fit Claude Desktop's message limit, which is a different thing from fitting your
  conversation; one answer could take a fifth of the chat by itself. It is now
  about six times smaller, and if a request would exceed it Claude is told exactly
  how many records to ask for instead — we tested that it then works first time.

Practical effect: ask for fewer things at once and you will notice little
difference, but a long audit should now go much further before the chat fills up.
If you deliberately want one very large answer, that limit is still adjustable.

The same check was then run against every other detailed answer this connector
gives. Most were already lean. The full list of accounts, when asked for every
field TallyPrime holds, was not — that one dropped by **eight times**, more than
the transactions did, because an account carries even more of that repeated
filler. Stock item detail improved by a smaller amount, for the same reason.

**And audits are much faster**

Reported: a full audit of one company takes too long. Timed on real books, and
almost all of it was waiting for TallyPrime rather than anything we do.

Asking TallyPrime for one year of transactions produces about **21 MB** and takes
it roughly **7 seconds**. Five different questions read that same batch — bank
items, who owes what, GST, stock movements, and the transaction list itself — and
we were only holding onto it for 20 seconds. That is shorter than it takes to read
an answer and ask the next question, so nearly every question paid the 7 seconds
again, plus a second or so to re-read it.

- We now hold onto it for **five minutes**, and keep it in the form we have
  already read rather than re-reading it each time.
- Timed on a nine-question audit of a full year, with 25 seconds of thinking
  between each question: **64 seconds of waiting became 12 seconds.**
- Individual questions that used to take about a second now take a few
  thousandths — bank items, GST and stock movements especially.
- A request that was going to be rejected for bad input (an out-of-order ageing
  range, say) used to spend a second fetching data before rejecting it. Now it
  answers instantly.

Two things worth knowing:

- If you **edit something in TallyPrime while asking questions about it**, you may
  see the older figures for up to five minutes. This connector cannot change
  anything itself, so it only applies if you are editing by hand mid-audit. Every
  answer now also records when the data was actually read, separately from when the
  answer was written, so a figure copied into a working paper is never mis-dated.
- The remaining wait is TallyPrime's own time and we have deliberately not tried to
  shortcut it: the only way to make that batch smaller is to ask TallyPrime for data
  in a way we have not verified as safe, and an unsafe request can close TallyPrime
  and lose unsaved work.

  **Correction, 13 Aug 2026:** this section previously said that asking about one
  month instead of a year was the reliable way to make things quicker. That is no
  longer true, and it is a consequence of the transaction-detail fix above. The way
  we now have to ask TallyPrime for transactions — the only way that returns the
  debit and credit lines at all — makes it send the whole year whatever dates we
  give it. A one-month question and a full-year question now cost TallyPrime the
  same. The good news is that the new way is *faster overall* (about 2 seconds and
  8.6 MB, against 7.8 seconds and 21 MB before), so the first transaction question
  of a session is quicker than it was even though the date range no longer helps.
  A narrow date range is still worth using — it keeps the answer short and focused
  — it just no longer reduces TallyPrime's work.

**Still to come**

- Refusing to work against the Educational version of TallyPrime. Educational
  can silently corrupt data, so we want to block it outright — but TallyPrime
  does not obviously offer its licence type over this connection, and we will
  not ship a check that reports "not Educational" without really knowing. A
  diagnostic (`npm run probe:reports`) has been written to find a safe way to
  read it; until it does, this connector cannot tell which edition it is
  talking to.
- Reading Tally's edit log — who changed which entry and when. It is required
  evidence in an Indian statutory audit and it drives most of the fraud checks
  in the plan. The same diagnostic looks for it.

## 0.1.0 — unreleased

First release.

**What it does**

- Ask Claude questions about your TallyPrime books in plain English — balances,
  who owes you money, sales, purchases, stock, GST, ledger history.
- Reads only. It cannot create, change or delete anything in TallyPrime.

**Installing**

- Unzip the folder, double-click `Setup` once, restart Claude Desktop.
- Nothing else needs installing — the folder brings everything it needs.
- Moved the folder? Run `Setup` again; that repairs the link.
- `Check-Tally` diagnoses problems in plain language: whether Tally is running,
  whether its connection setting is on, and whether a company is open.
- If you run `Setup` while still inside the zip file, it stops and explains how
  to extract properly, rather than installing to a folder Windows later deletes.

**Known limits**

- TallyPrime must be open, with the company you're asking about loaded. Tally
  serves one company at a time.
- Cash flow and fund flow show month-by-month movement straight from Tally's
  own reports. They are not formal classified statements: splitting movements
  into operating, investing and financing is a judgement about your business,
  so Claude will show you the movement and discuss the classification with you
  rather than guessing it.
- Very large requests come back in pages. Asking for every detail of thousands
  of transactions at once is more than Claude Desktop can accept in one reply,
  so Claude will fetch a smaller page and tell you it did. Asking for a shorter
  date range is the quickest way to get everything in one go.
