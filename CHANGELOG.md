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

## 0.3.1 — 2026-08-14
**Read this first: three answers could be wrong, and one of them looked complete.**

Testing against a live Indian company on 14 Aug 2026 found these. All are fixed.
If you have quoted a figure from this connector, these are the ones worth re-running.

- **Only the current financial year of transactions was ever readable, and nothing
  said so.** Ask about last year and TallyPrime quietly hands back *this* year's
  transactions instead. On the books tested — five years of them — a question about
  2023-24 returned 285 transactions from 2026-27, and every "is this complete?"
  signal on the answer said yes. Worse, once the dates were filtered the answer came
  back **empty**, which reads as "there were no transactions that year" when the real
  meaning is "that year could not be read". Those are opposite statements. The
  connector now says plainly when the period it read is not the period you asked
  for, and refuses to let an empty answer be described as "nothing happened".
  The underlying limit is TallyPrime's and is not fixed yet — but it can no longer
  be mistaken for an answer.
- **A statement asked for one year could quietly cover four.** Where TallyPrime
  ignores your end date, the figures run to the end of the *last* year your books
  contain — not to the end of the year you asked about. On the company tested,
  every request, from any start date, ran to 31 March 2027: a request for 2023-24
  came back as four years of accumulated figures. The warning also stated the
  period as ending *before* it began, which is nonsense on its face. Both fixed,
  and the real end date is now named.
- **Company names: a change we made, and a warning we have since withdrawn.**
  The connector now sends the spelling TallyPrime itself uses, rather than yours,
  and it checks the name against the loaded companies before asking anything.

  An earlier draft of this entry said that asking for "acme ltd" could return
  another company's figures under your spelling. **That was wrong, and it is
  withdrawn.** Tested afterwards with three companies open at once, TallyPrime
  matched the name whatever the capitalisation and ignored stray spaces and line
  breaks; a name it did not recognise returned an *empty* report rather than
  somebody else's numbers. No figure you have been given was mis-attributed, and
  there is nothing here you need to re-run.

  The change is still worth having, for a smaller and real reason: a name
  TallyPrime does not recognise comes back **empty**, and an empty answer reads as
  "this company has nothing to report" — so the name is now rejected outright
  instead of quietly producing a blank.
- **A default period could belong to no year of your books.** With no dates given,
  the connector assumed an Indian April-to-March year. A company on a
  January-to-December year — most books outside India, including the US company
  this was first built against — got a window straddling two of its own years, so
  every total silently mixed half of one year with half of the next. The period now
  comes from your own book dates.
- **Stock movements counted things that never moved.** Sales and purchase *orders*
  carry stock lines for goods still sitting where they were, and cancelled entries
  were not excluded at all. Both are now left out, and the count of each is
  reported rather than silently dropped. Delivery and receipt notes *are* kept —
  the goods did move — but you are now told when they are present, because the
  invoice raised against a note covers the same goods and a period holding both
  shows the quantity twice. Whether to net those off is your judgement, not ours.
- **"Is Tally responding?" could answer yes while Tally was answering nothing.**
  The check was cheap enough to be served from memory, so it reported success for
  up to five minutes after TallyPrime had stopped replying. It now always asks
  TallyPrime itself.
- Smaller one: where the connector counts how many different values a field takes,
  it stops counting at 25 for speed. It was reporting that as though it were the
  real total — so a field with 330 different values was described as having 25. It
  now says "at least 25".

**One thing we learned the hard way, recorded so it does not happen to you.**
A malformed request does not close TallyPrime — it puts a **"incorrect object
type"** dialog on screen, and until somebody clicks it, TallyPrime accepts
connections and answers nothing at all. It looks running and is not. This cost two
restarts while testing. Nothing was damaged and no books were altered, but if
TallyPrime ever seems to hang while you are asking questions, **look at the Tally
window for a dialog** before restarting anything.

**Fixed: with more than one company open, figures could be labelled with the
wrong company's name.**

The most important fix in this release, and it only becomes possible when you have
a second company open in TallyPrime.

Asking about one company would fetch that company's figures correctly — and then
label them with a different company's name. On the install this was found on,
AgEx Pharma's accounts came back headed "AGBV Nutrition GmbH". The numbers were
right and the name on them was wrong, and nothing flagged it.

The same mistake was in four places: the company name on every answer, the
currency label, the period used when you don't give dates, and the "which company
is this?" description. All four assumed TallyPrime only ever has one company open,
so they simply took the first one in the list. That is true for most installs and
was true for every test we had — which is exactly why it survived.

Now the company is taken from the request that was actually sent to Tally. If
several companies are open and you did not say which one you meant, the answer
says **so** — the company reads "not determined" and figures are not given a
currency — rather than guessing. Name the company and everything is labelled
properly again.

**If you have been working with one company open, nothing you have been told was
affected.** With one company there was nothing to confuse it with.

**New: see a statement across several periods at once.**

Ask for a trial balance, balance sheet or P&L over up to twelve periods and every
line is tracked through the series, with the movement from one period to the next.
Previously this was one call per period and the arithmetic by hand.

Two things it deliberately will not do:

- **A row missing from a period comes back empty, not zero.** This matters more
  here than anywhere else, because a row of figures gets read as a shape — and a
  blank read as zero looks like something fell to nothing, when TallyPrime simply
  did not report that line. Each row says which periods it actually appeared in.
- **If any period ends on a date TallyPrime will not honour, the whole trend is
  refused** rather than answered. Tally only respects a statement end date that
  falls on the 31st of a month. For a single statement we answer anyway and say
  loudly what the figures really cover — but in a trend every period would quietly
  run to the same endpoint, so the "movements" would be differences between
  overlapping totals rather than real period-to-period change. That is a wrong
  number of entirely believable size, in the output most likely to be quoted
  without its footnotes. The error names each offending date and the nearest one
  that works.

Verified against real books: three periods on the US company returned 172,702.50,
211,852.50 and 417,952.50 — genuinely different figures, not the same total three
times.

**Fewer tools, and they answer more.**

Four separate tools for looking up ledgers, account groups, voucher types and stock
items are now one — `tally_get_masters`, with a `type` to say which you want. They
always took the same options and worked the same way, so having four of them cost
Claude attention for nothing. Nothing was dropped: every caution the four
descriptions carried is still there, including the two that matter most — that a
negative ledger balance means a *debit* balance, and that a repeated voucher number
is only worth a second look if that voucher type was set to prevent duplicates in
the first place.

**New: the audit tests an accountant would actually run.**

One tool, `tally_test_vouchers`, picks the transactions you want and then runs one
of eight procedures over them:

- **Journal screening** — manual journals that are large, exactly round, carry no
  narration, or are dated a weekend. Journals are what somebody typed by hand
  rather than what a process produced, which is why they are the first place to
  look.
- **Benford's Law** — whether the leading digits of your amounts fall the way real
  amounts usually do.
- **Sampling** — a sample you can draw again. It hands back the seed, so the same
  sample can be reproduced for a file months later.
- **Duplicates** — same party, same amount, same day.
- **Round numbers**, **cut-off** (entries near the start or end of the period), and
  **weekend-dated** entries.
- **Related parties** — and TallyPrime turns out to have its own related-party
  marking, which we had previously concluded it did not. It is now read and used as
  a starting point, with your own list added on top.

**Every one of these produces things to look at, not things that are wrong.** A
round number is usually rent. A weekend date is usually nothing. The tool says so on
every single answer rather than once in the small print, because that sentence is
the one most likely to get dropped when an answer is summarised. It also tells you
how many transactions it examined and what it left out — orders and cancelled
entries never belong in these tests, and a test run over the wrong set of
transactions gives a confident answer to a question nobody asked.

Two limits stated plainly in the output, because both are easy to miss:
- The **weekend** test reads the date *on* the voucher, not the date it was typed
  in. An entry dated Sunday but keyed in on Monday is unremarkable. The real
  "posted out of hours" test needs TallyPrime's Edit Log, which this connector
  cannot yet read.
- **Journals are found by their type name containing "journal"**, because
  TallyPrime has no "this is a manual journal" flag. A company calling its
  adjustment type something else is not covered — so an empty result is a fact
  about the type names, not about the company.

**New: TallyPrime's own exception reports.**

`tally_get_report` opens up nine built-in views, including **Negative Ledgers** —
negative cash is impossible in real life, so it is one of the classic first checks.
The list is closed on purpose: every report on it was tried against a real
TallyPrime. Four of them were accepted by Tally but had nothing to show on the
company we tested, so their layout has never actually been seen, and those say so
every time they are used.

The columns come back under TallyPrime's own names rather than being relabelled
"debit" and "credit". That is deliberate: guessing which column is which would give
you a figure that is right in value and wrong in meaning, which is far harder to
notice than an obvious error.

**New: Schedule III ageing, and genuinely overdue balances.**

Receivables and payables can now be aged into the **Schedule III** disclosure
periods — under 6 months, 6 months to a year, 1-2 years, 2-3 years, over 3 years —
worked out as real calendar months rather than a fixed number of days, so a bill
sitting a few days either side of the six-month mark lands in the right bucket of
the published note.

It is half of the note, and it says so. Schedule III also wants each bucket split
into disputed and undisputed, and good and doubtful. Whether a debt is disputed is a
legal fact and whether it is doubtful is a judgement — neither is in TallyPrime, and
filling them in with "all undisputed, all good" would be inventing the part of the
disclosure that carries the actual opinion.

Separately: **tell it your credit terms and it will tell you what is genuinely
overdue**, per party or per group. Until now this connector would only tell you how
*old* a bill was, which is not the same thing. Where you have not supplied terms for
a party, there is simply no overdue figure — not a zero, because a zero would read
as "nothing overdue", and that cannot be said without knowing when the bills were
due.

**Currency: you can now just tell it.**

Following on from the note below about euro figures coming back labelled `unknown` —
set `TALLY_CURRENCY_LABEL` in the configuration and your figures carry the right
label. It is used *only* where TallyPrime could not send its own symbol, so it can
never relabel figures whose currency came through fine, and the answer always says
the label came from the configuration rather than from Tally. Those are different
kinds of fact and should not look the same.

**Fixed: accented names in your books were being mangled.**

This is the important one. Any name containing an accented character — `Allgäuer
Ölmühle GmbH`, `AOK Baden-Württemberg`, `Bättre Hälsa AB`, `Verkäufe` — was
arriving with those characters replaced by question-mark boxes. On the company this
was found on, **twenty supplier and account names** were affected, and nothing
warned about it.

It mattered more than it looks. Claude looks parties up *by name*, so a mangled
name meant "no such supplier" for a supplier that is right there in your books.
Anyone whose books are entirely in plain English was never affected; anyone with
German, Swedish, Italian, Polish or French names in their ledgers was.

Now fixed and covered by a test that carries the exact data that broke it.

**Currencies: your figures are no longer labelled with a question mark.**

TallyPrime cannot send certain symbols — the euro is one — over this connection. It
replaces them with `?` before the data leaves TallyPrime, and no setting on our side
can change that (we tried ten). Previously every figure from a euro company came
back labelled `"?"`.

Now such figures are labelled **`unknown`**, with a note saying the amounts are
exact and only the label is missing, and naming the country. Deliberately *not*
guessed at: a German company can perfectly well keep its books in dollars — the one
this was found on defines both — so Claude is told to ask rather than assume. **The
numbers were never wrong and are never converted.** Only the label was.

**Stock reports, and two date bugs that gave wrong answers on companies outside
India.**

New: **ask about closing stock by item, or by warehouse.** "What stock is on hand
and what is it worth?" and "what is sitting in each location?" now have answers.
The second one was previously impossible — there was no way to get location-wise
stock at all.

Two things it will tell you rather than hide:

- Quantities come back with their unit ("9500.00 Kg"), because a stock number
  without its unit is meaningless.
- **The rate shown is rounded**, so quantity × rate does not equal the value. On a
  real company, half the items disagreed. Claude is told to quote Tally's own
  value and never to multiply it back, so you will not be handed a total that is
  quietly a few hundred out.

Fixed: **companies whose financial year is not April to March.** Anyone on a
January–December year — European companies, most non-Indian books — was affected.
Asking for a quarter's figures could produce a warning claiming the figures
covered a period *ending before it started*, and the "here is the period to try
instead" suggestion pointed at a year containing none of the company's data. The
year is now read from the company's own start and end dates instead of being
assumed.

Fixed: **comparing two periods was refused more often than it needed to be.**
TallyPrime turns out to honour an end date when it falls on the 31st of a month
and to ignore it on any other day — established by testing nineteen different end
dates against a live company. Previously the connection assumed the end date never
worked, so it declined comparisons it could actually have answered. Now:

- Periods ending on a 31st are answered normally and reported as covering exactly
  what you asked for.
- Periods ending on any other day are still answered, still flagged as running
  past the date you asked for, and now the message tells you **which nearby date
  would work** instead of only saying no.
- The one trap to know: **30 June and 30 September do not work** — the two quarter
  ends most people reach for. Ask to 31 March, 31 May, 31 July, 31 August,
  31 October or 31 December and you get exactly that period.

Nothing about how figures are read or reported changed, and no figure is adjusted.

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
