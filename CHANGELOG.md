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

## 0.8.2 — unreleased
**Updates now actually install themselves.** Version 0.8.1 could find a new
version and download it, but could not unpack it — so nothing ever updated. If
you are reading this in 0.8.1, it will not update on its own; install this
version once by hand and it will keep itself current from then on.

## 0.8.1 — 2026-08-22
**If Setup said it worked but Claude still could not see your Tally data, this is
the fix.** Recent versions of Claude Desktop keep their settings in a different
place than they used to, and Setup was writing to the old one. It said
"Connected", and Claude never saw it. Setup now writes wherever Claude is
actually reading from, and tells you the exact file it wrote.

**Check-Tally is worth trusting again.** It was reporting a perfectly good
install as broken, and — worse — could report a broken one as fine, because it
was reading a settings file Claude no longer uses. It now also checks Codex,
which it never mentioned at all, and prints which settings file it looked at.

**Setup will now stop and explain instead of half-working:**

- If it was started with "Run as administrator" it stops. Windows gives an
  administrator its own settings folder, so it would have set Claude up for the
  wrong account and cheerfully reported success. Nothing here needs
  administrator rights — a plain double-click is correct.
- If the folder cannot be written to — anything under Program Files, or a
  read-only network drive — it says so before changing anything, rather than
  failing halfway through.

**Updates keep working even if you never set up the spreadsheet.** Previously the
hourly spreadsheet job was the only thing that looked for new versions, so an
install using only the live connector would never have found one. It now also
checks when you open Claude.

**And updates can now fix the updater itself.** Each version carries fresh copies
of its own launcher files, so a problem in the part that installs updates is no
longer something only a manual reinstall could repair.

## 0.8.0 — 2026-08-21
**New: it updates itself. No more replacing folders by hand.**
Until now a new version meant somebody emailing you a 42MB zip and talking you
through swapping a folder over — so copies drifted, and one sat two versions
behind for weeks without anyone noticing. From this version on, your copy checks
once an hour whether a newer one has been published, downloads it quietly in the
background, and starts using it **the next time you open Claude**.

What you will see: one notification, once, saying a version is ready. Then
nothing until you next restart Claude. `Check-Tally` tells you at any time which
version you are on and whether one is waiting.

**Why it waits for a restart rather than switching immediately.** Claude holds
the connection open while it is running, so swapping underneath it is not
possible — and would not be desirable anyway. If you quote a figure from the
spreadsheet on Tuesday, which version produced it has to have an answer. Changing
only when you restart makes that a moment you chose.

**If an update is ever broken, your copy puts itself back.** The previous version
is kept, not deleted. If a new one fails to start, the old one is restored
automatically and the broken version is refused from then on — you keep a working
tool without doing anything, and `Check-Tally` says what happened. A download that
does not match its published checksum is discarded and never unpacked.

**Your settings survive an update.** The export folder you chose, the schedule
you agreed to, and your run history now live above the part that gets replaced,
so an update cannot quietly reset them.

**One last manual step, this once.** Self-updating needs the new folder layout,
which an existing copy does not have. So this version has to be installed the old
way — unzip and run Setup once. Every version after it arrives on its own.

## 0.7.0 — 2026-08-21
**New: your Tally data can now write itself to a spreadsheet, automatically.**
Setup opens a folder picker — choose one inside Google Drive — and from then on a small
job keeps an Excel workbook there up to date, one file per company, a tab per
part of the books. Claude reads that workbook through the Google Drive
connector.

Three things this buys you:

- **TallyPrime does not have to be open** for somebody to ask a question. The
  spreadsheet is already there.
- **You get a real spreadsheet**, not figures retyped out of a chat.
- **Conversations get cheaper.** With the connector switched off, you save about
  12,000 tokens of every conversation that went on describing tools you were not
  using. Setup now offers to leave the connector off for exactly this reason —
  and turning it back on is just running Setup again.

**It only writes when the books change.** The job wakes once an hour and asks
TallyPrime one cheap question — has anything moved? — which takes about a fifth
of a second. Only when the answer is yes does it do the real work. It also
exports once a day regardless, so the file can never quietly go stale while
looking current.

The machinery is fast enough to run every minute, and that is the intended
cadence. It ships hourly because the "has anything moved?" check relies on
TallyPrime marking every edit — including a DELETED voucher — and that has not
yet been confirmed at a real TallyPrime screen. If it turned out not to hold,
a minute-by-minute job could skip exports while your books were changing, and
the spreadsheet would look current while being out of date. Hourly is only
slower. Once it is confirmed, the interval line in the .env file goes to 1.

**Read the Manifest tab first.** It carries the things the connector used to say
out loud: which company these figures are, what currency and how we know, what
period is covered, when it was last read, which voucher flags to exclude before
totalling anything, and every warning TallyPrime produced. Without it the
workbook is a pile of numbers with no context.

**Two limits worth knowing:**

- **It goes back as far as your books do.** Not just this year: on one real
  company the spreadsheet went from 284 vouchers to 2,738 across five years.
  Earlier years take longer to fetch, which is why an export can run for a
  couple of minutes when the books have changed.
- **The statements are still this year only.** Trial balance, profit and loss
  and balance sheet cover the current book year, because TallyPrime will not
  honour any other end date. The Manifest says which period each part covers,
  so do not tie a trial balance to the full voucher history.
- **"As at", not "now".** Every answer from the spreadsheet is as at the last
  successful export. If a figure is going into an audit file, check it against
  the live connector first.

**Do not use File → Save as Google Sheets** on the workbook. That makes a
separate copy the job will never touch again — it looks live and is frozen. Open
the .xlsx directly; Google Sheets reads it with the tabs intact.

**It runs invisibly.** Nothing pops up on screen while you work — the
background job has no window. Double-click `Run-Export` yourself when you
actually want to watch one happen.

Also in this release: `Run-Export` in your folder exports on demand, and
`Check-Tally` now reports how old the spreadsheet is and whether the last run
worked.

## 0.6.0 — 2026-08-18
**New: you can now ask which entries were written long after the date they
carry.** `tally_test_vouchers` has an eighth test, `late_entry`. It lists
vouchers whose last save happened well after the date on their face — an invoice
dated 31 March that was keyed in during June — and vouchers dated inside the year
that were written after the year ended. That is the cut-off question an auditor
actually asks, and until now nothing in this connector could answer it.

Read the three limits, because they decide what you can say about the result:

- **It is the LAST save, and nobody's name is attached.** An entry keyed in late
  and an entry keyed in on time then altered months later look identical here.
  Treat a flagged voucher as one to ask the client about.
- **It is not an audit trail.** It does not show what changed, or that anything
  changed, and it cannot support CARO Rule 11(g). That still needs TallyPrime's
  own Edit Log on screen.
- **A lag is not an irregularity.** Books written up monthly show a 30-day lag on
  nearly every voucher. The result reports the lag spread across the whole
  population so you can set the threshold to what this company normally does —
  measured on real books, one company's median lag was 42 days and another's 50.

**On a company that does not record save times, this test refuses to run**
rather than reporting that nothing was found. TallyPrime returns a row of zeros
instead of leaving the field out, so an empty answer would have been
indistinguishable from books where every entry was written on the day it is
dated. It fails with an explanation instead.

**Also: the Edit Log itself remains unreachable, and this is now settled rather
than assumed.** Eleven report names were tried against a live TallyPrime and all
eleven were refused; the fields naming who entered or altered a voucher are
served but always empty. Documented in
`docs/probe-findings-2026-08-18.md`.

## 0.5.1 — 2026-08-18
**Read this first: the TDS check was giving a misleading answer on non-Indian
companies, and a clean-looking one on an Indian company that does deduct tax.**

- **"No TDS set up" no longer implies an audit point on a company outside
  India.** Asking about TDS on a German or American company produced the same
  sentence as on an Indian one, ending "for an Indian company with payments
  that attract TDS, that is itself the audit point". TDS is an Indian tax, so
  on those companies the sentence stated a problem that does not exist. It now
  names the country and says plainly that TDS does not apply there.

- **TDS ledgers in the accounts are no longer reported as "the feature is
  unused".** On a company whose books contain TDS Payable, TDS on Rent, TDS on
  Salary and others, the answer was that no ledger carried a TDS setting and
  the feature was therefore unused. Tax was being deducted — just outside
  TallyPrime's own TDS machinery, so none of its rate, threshold or section
  checks were running. The answer now lists those ledgers and says so, which is
  a bigger point than the one it replaced, not a smaller one. **If you were
  told a company does not use TDS, ask again.**

- **A profit and loss now says when its closing stock disagrees with the stock
  summary.** On one company the profit and loss carried the same stock figure
  at the start and the end of the period while the stock records showed goods
  going out, so cost of sales was nil and the gross margin read as 100%. Both
  figures came from TallyPrime and neither has been changed; what is new is
  that the connection now tells you they disagree and by how much.

- **Figures for a period that runs past the end of the books are labelled as
  such.** Asked about a company whose books stop in April, the connection would
  answer for the whole year and say nothing — so a fortnight of trading was
  read as a full year, and every ratio and margin with it. It now says how many
  days of the period actually contain any transactions.

- **New: the tie-out now checks stock as well.** "Do the books tie?" previously
  meant every voucher balances and every ledger rolls forward. It now also
  checks that the stock figure in the accounts agrees with the stock records,
  at both the start and the end of the period — because a difference at the
  start is an opening-balance error while a difference at the end means goods
  moved without the accounts being told, and they need different fixes. Where a
  company keeps stock records but has no stock account in its ledger, the
  connection says the stock is untied rather than reporting a clean result.

## 0.5.0 — 2026-08-17
**Read this first: a single ledger fetched by name was showing a blank closing
balance.**

- **Asking for one ledger by name returned no closing balance at all.** The
  balance showed as empty, which everywhere else in this connection means "we
  could not read it" — so a party account with 1.48 crore outstanding looked
  like an account with nothing to see. Listing the same ledger showed the
  balance correctly, so the two ways of asking disagreed. The cause was that
  TallyPrime's "give me everything" request quietly leaves the closing balance
  out. Both ways of asking now return the same figures. **If you looked up a
  single ledger by name and read the balance as blank, look again.**

- **New: TDS and TCS.** Ask "which ledgers are set up for TDS?" and you get the
  tax ledgers, the parties tax is deducted from, the expenses flagged as
  TDS-bearing, anything set to a special (206AA) rate, and anything set to
  ignore the exemption limit — with counts, so "3 of 330" is visible. Nothing
  is calculated: no rate is applied and no shortfall or disallowance is worked
  out, because those depend on the section, PAN status, 197 certificates and
  per-payee thresholds that the books do not hold. The useful finding is
  usually an expense that *should* be flagged and is not.

- **New: related-party disclosure table.** The related-party test now returns a
  row per party alongside the list of vouchers — what was transacted, split by
  the nature of the dealing, and the balance outstanding at period end. That is
  the shape AS 18 / Ind AS 24 asks for. Amounts are not netted, and a
  transaction between two related parties counts under both, so the rows do not
  add up to a company total; the output says both of these plainly.

- **New: value-weighted sampling.** Sampling can now select in proportion to
  amount, so large vouchers are near-certain to be picked and the testing goes
  where the money is. It reports the sampling interval and flags which items
  were certainties. It is the right choice for testing overstatement and the
  wrong one for testing completeness — it says so, because a conclusion about
  missing entries drawn from this method would be wrong.

- **New: workpapers.** Ask for a procedure as a workpaper and you get a
  document ready for the audit file — objective, population tested and what was
  excluded, the method with its parameters, the results, the limitations in
  full, and the exact call that reproduces it. It **re-runs the procedure
  against Tally** rather than tidying up figures from the conversation, so every
  number on the page came out of the books. It will **not** write your
  conclusion: leave it out and the paper says the conclusion was not recorded,
  because an unsigned working paper should look unsigned.

- **New: fixed asset schedule.** Opening, additions, disposals and closing for
  each asset ledger, with every addition and disposal traced back to the
  voucher that caused it. It checks that the movements actually explain the
  change in balance and tells you which ledgers do not add up — the balances and
  the movements come from two different places, so agreement is real evidence.
  Depreciation is reported as charged and never recalculated: Tally holds no
  asset register, so there is no acquisition date or useful life to work from.

- **New: confirmation list.** The parties you could circularise, largest first,
  with the balance per the books and the contact details Tally holds. Parties
  with no phone, contact or email are **kept in the list** and marked
  uncontactable, because a large balance owed by someone unreachable is a
  finding, not a row to hide. No default cut-off is applied — which parties to
  confirm is your judgement.

- **Known gap, now confirmed rather than assumed:** TallyPrime does not record
  whether a supplier is an MSME. The 45-day test under Section 43B(h) therefore
  cannot be done from the books alone and needs a supplier list from you, the
  same way credit terms already work.

## 0.4.1 — 2026-08-17
**Read this first: one way of asking for a single ledger could give you the
wrong record.**

- **Asking for one ledger by name while also passing a search term returned the
  named ledger and ignored the search.** If you asked for "the ledger named X"
  and, in the same breath, narrowed it by a search word or a condition, only the
  name was used — the rest of what you asked for was dropped, and nothing in the
  answer said so. The reply looked exactly like a filtered one that had been
  honoured. Asking that way now comes back as a clear error telling you to pick
  one or the other, so a half-answered question can no longer look like a whole
  one. Asking by name on its own is unchanged.

- **Large voucher fetches are much faster.** Cleaning up what TallyPrime sends
  took about 1.6 seconds on a big voucher register and now takes under a tenth of
  a second. Nothing about the figures changed — this is the same work done a
  better way.

- **Fewer repeated requests to TallyPrime.** Answering one question used to ask
  Tally the same thing up to three times over — which company is open, what its
  year is, what currency it uses. It now asks once per question. Tally handles one
  request at a time, so this is time back on every answer, and it matters most on
  the slowest ones.

- **Held-in-memory voucher data is managed better.** When the connector was
  keeping several periods' vouchers to avoid re-reading them, out-of-date copies
  could sit there occupying space that a period you were actually working in
  needed. They are now cleared out properly.

The speed work was checked by running the same twelve questions against a live
TallyPrime before and after, and comparing the answers character by character:
every one came back identical.

## 0.4.0 — 2026-08-15
**Read this first: "the books don't balance" could have been wrong.**

Testing against three live companies on 15 Aug 2026 found a fault in the
books-tie check itself. It is fixed, and it is the reason to update.

- **The tie-out check reported books as OUT when they were fine.** Some supplier
  and customer names come out of TallyPrime with a hidden line break in them —
  a real German supplier is stored as "BUNDESANZEIGER VERLAG G⏎ MBH". The
  connector was reading that name one way from the ledger list and a different
  way from the transactions, so the two never lined up. It then saw **no
  transactions at all** for those accounts, decided the closing balance could
  not be explained, and reported the books as out of balance. On the company
  tested it raised two failures against books that balance perfectly. If you
  have run the books-tie check and it failed, **run it again** — the failure may
  not have been real. Nothing was ever wrong with the figures themselves, only
  with the verdict on them.

- **Amounts now say which currency they are in.** Two of the three companies
  tested had every figure labelled "unknown", because TallyPrime cannot send the
  € or ₹ symbol — it substitutes a question mark. It turns out TallyPrime does
  send the currency's full name ("European Euro", "INR") right alongside, and
  the connector now reads that. Those companies' figures come back labelled EUR
  and INR, taken from the company's own currency settings rather than guessed.
  Where the currency genuinely cannot be established it still says "unknown"
  rather than assuming.

- **Figures from companies in different currencies are never subtracted.**
  Comparing several companies side by side used to work out differences between
  them whenever their currency labels matched — and while two companies were
  both labelled "unknown", those labels matched. Euros could be subtracted from
  rupees and presented as a difference. Now a difference is only worked out when
  every currency is genuinely established, and the answer says so either way.

- **The books-tie check labelled every amount as rupees.** It ignored the
  company's own currency, so a euro company's exceptions were reported in INR.

**New, and worth knowing about:**

- **Check several companies in one go.** The books-tie check now accepts a list
  of companies and checks each against its own books and its own financial year.
  It only reports an overall pass if every company passes.

- **Shorter answers when you want them.** Ask for a summary and you get the
  findings without the standing explanation that accompanies every answer — on
  the company tested that left out 538 explanatory notes. Anything reporting a
  problem is always kept, whatever you ask for. A statement in summary form also
  leaves out accounts that are nil, and says how many it left out.

- **Findings now come with a severity.** Problems are tagged as a real exception,
  as something that could not be checked, or as information — so a genuine
  finding no longer has to be picked out of the notes by reading them.

- **Stock movement warning was over-counting.** Asking about one stock item could
  warn about delivery notes that concerned entirely different items.

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

**New: compare several companies side by side.**

Give `companies` a list and the same statement is read for each of them, with the
rows lined up. TallyPrime holds several companies open at once, so this reads each
in turn.

Three rules it will not bend:

- **It asks you for the dates.** Your companies keep different financial years —
  the German books run January to December and the other two April to March — so
  there is no shared "this year" to fall back on, and picking one of them would
  quietly put different months next to each other under one heading.
- **It does not subtract across currencies.** Where the companies report in
  different currencies the columns are shown but nothing is compared, because a
  dollar figure minus a rupee one looks like a real difference and means nothing.
  Nothing here ever converts between currencies.
- **A row missing for one company is blank, not zero** — same rule as the trend.

And where the currencies do match and differences ARE shown, it still says they
are differences between separate businesses, not a change over time.

Verified against your three companies: capital of 47,088.23, 4,844.93 and
1,161,289.87 — three genuinely different sets of books, not one repeated.

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
