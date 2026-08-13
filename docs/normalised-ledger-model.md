# Normalised ledger model — draft for review

**Status:** draft. Not implemented, not wired to anything.
**For review by:** the audit-team domain owner, per Annexure A §7 item 3 — *"Draft normalised ledger model schema, for review by the audit-team domain owner **before** any adapter is written."*
**Types:** [src/model/ledger.ts](../src/model/ledger.ts)
**Date:** 12 August 2026

---

## What this is, in one paragraph

Today this server reads TallyPrime and hands back data shaped the way Tally
shapes it. Annexure A §3 changes that: our clients are on QuickBooks Online,
Zoho Books **and** Tally, and the US entities are not on Tally at all. So we
need one common shape that all three get converted into, and every audit test
and every report gets written once, against that shape. This document proposes
the shape.

Annexure A §3.3 states the test of success: *if a test contains a
Tally-specific field name, it is written wrong.* Everything below follows from
that.

## Why it has to be settled before any adapter is written

An adapter is the translator between one accounting system and this model.
Once two adapters exist, changing the model means rewriting both — plus every
test and report built on top. The cost of getting this wrong rises steeply and
never comes back down. That is why Annexure A puts it at P1-blocking and why
it wants an auditor's eyes on it before code.

---

## The one decision we need from you

**How should a debit be represented?**

TallyPrime encodes debit and credit in the **sign** of the number. A debit
balance arrives as a negative. An expense arrives as a negative. Stock in hand
arrives as a negative.

The current server passes that through untouched, on purpose: it means the
number the system reasons about is the same number you would see on the Tally
screen. That has been a good rule for a Tally-only tool.

It cannot survive a second source. QuickBooks and Zoho Books do not use Tally's
convention. If we keep signs as they arrive, every audit test would have to ask
"which system did this number come from?" before it could tell a debit from a
credit — which is the coupling we are trying to eliminate.

**What we propose instead:** every amount is stored as a **positive number plus
an explicit `debit` or `credit` label.**

| | Tally today | Proposed model |
|---|---|---|
| ₹5,000 paid out of bank | `-5000.00` | `5000.00`, side `credit` |
| ₹5,000 rent expense | `-5000.00` | `5000.00`, side `debit` |
| ₹5,000 owed by a customer | `-5000.00` | `5000.00`, side `debit` |

We already do half of this. The existing code reads the side from Tally's own
internal debit flag rather than from the sign, because that flag is what Tally
treats as authoritative.

**What it costs, stated plainly.** The adapter now transforms the number rather
than passing it through. A figure in this model will no longer match the Tally
screen character for character, and anyone comparing the two needs to know the
conventions differ. We are trading fidelity to one system for comparability
across three.

**We believe this is right, but it is a professional judgement rather than an
engineering one, and it is yours to make.** If you would rather keep Tally's
signs exactly as they are, say so now — it is cheap today and expensive after
the second adapter.

---

## What is in the model

Twelve things. Nothing exotic; the intent is that each maps onto something you
would name yourself.

| Model | What it is | Note for review |
|---|---|---|
| **Entity** | One set of books | Called "entity" not "company" because consolidation treats branches and subsidiaries alike |
| **FiscalPeriod** | A financial year or shorter period | Carries whether the source says it is closed |
| **Account** | A node in the chart of accounts | **Merges Tally's Group and Ledger into one tree** — see below |
| **Party** | Customer, vendor, employee, bank | Related-party status is `undetermined` by default, never assumed |
| **CostCentre** | Cost centre / class / department | |
| **StockItem** | An inventory item | Quantities keep their unit; never converted |
| **Voucher** | One transaction | Cancelled and optional vouchers are **kept**, not filtered |
| **EntryLine** | One line of a voucher | Where the debit/credit decision above bites |
| **TaxLine** | One tax component on a line | GST, TDS, VAT and US sales tax all fit the same shape |
| **BillReference** | The bill a line settles | The ageing and outstanding backbone |
| **DocumentLink** | Link from a voucher to a source document | Defined now, populated when the document layer exists |
| **SourceRef** | Where a record came from | On **every** record, per Spec §6 rule 2 |

### Three modelling choices worth your attention

**1. Group and Ledger become one thing.** TallyPrime splits the chart of
accounts into Groups (which cannot hold transactions) and Ledgers (which can).
QuickBooks and Zoho Books use a single account tree where any node may or may
not be postable. We follow the latter and carry a `isPostable` flag. A test
that walks the chart of accounts then works identically on all three.

**2. No Schedule III or US GAAP captions in the model.** Accounts carry only
the five classifications every framework agrees on — asset, liability, equity,
income, expense. Schedule III heads and US GAAP captions are produced by the
mapping layer (`gaap_bridge_engine`), not stored here. Putting one framework's
vocabulary into the shared model is how a dual-framework system quietly stops
being dual, and dual is the whole moat.

**3. Cancelled vouchers are retained.** A voucher that was entered and then
cancelled is evidence. If the adapter drops it, no downstream test can ever see
it — including the ones specifically looking for deleted and altered vouchers.

### Three rules carried over unchanged

These are already proven against live Tally data in the current server:

1. **An unreadable value becomes empty, never zero.** A fabricated `0.00` is
   indistinguishable from a real balance of zero, and in an audit that is the
   more dangerous of the two. (Spec §6 rule 10.)
2. **Every record says where it came from** — which system, which record, and
   the query that produced it. (Spec §6 rule 2.)
3. **Nothing that arrived is thrown away.** Each entity keeps a raw field bag,
   so mapping can be done incrementally without losing data we did not expect.
   This is what makes the existing tools work on companies whose configuration
   nobody anticipated.

---

## Tally → model mapping

Every field the current server extracts, and where it lands. Taken from
[src/tally/normalize.ts](../src/tally/normalize.ts).

| Tally today | Model | Note |
|---|---|---|
| `Company.name` | `Entity.name` | |
| `Company.startingFrom` | `FiscalPeriod.startDate` | |
| `Group.name` / `Group.parent` | `Account.name` / `Account.parentId` | Group and Ledger merge |
| `Group.isRevenue` | `Account.type` | Revenue groups → `income`/`expense`; others → balance sheet types |
| `Group.isDeemedPositive` | `Account.normalBalance` | |
| `Ledger.name` / `Ledger.parent` | `Account.name` / `Account.parentId` | With `isPostable: true` |
| `Ledger.openingBalance` / `closingBalance` | `Account.openingBalance` / `closingBalance` | **Sign becomes side + magnitude** |
| `Ledger.gstin` | `Party.taxIdentifiers[kind: 'gstin']` | Moves from the account to the party |
| `Ledger.fields` | `Account.raw` | |
| `VoucherType.parent` | `Voucher.family` | Custom types resolve to their base type |
| `VoucherType.name` | `Voucher.sourceType` | Kept: "Tax Invoice" matters to an auditor |
| `Voucher.guid` | `SourceRef.identifier` | |
| `Voucher.date` | `Voucher.date` | |
| `Voucher.voucherNumber` | `Voucher.number` | |
| `Voucher.narration` | `Voucher.narration` | |
| `Voucher.partyLedgerName` | `Voucher.partyId` | Name becomes a reference |
| `Voucher.isCancelled` | `Voucher.isCancelled` | Retained, not filtered |
| `Voucher.isOptional` | `Voucher.isDraft` | |
| `LedgerEntry.ledgerName` | `EntryLine.accountId` | Name becomes a reference |
| `LedgerEntry.amount` + `.side` | `EntryLine.amount` (`SignedAmount`) | **The sign decision** |
| `LedgerEntry.nested` (bill allocations) | `EntryLine.billReferences` | |
| `LedgerEntry.nested` (cost centre) | `EntryLine.costCentreId` | |
| `LedgerEntry.nested` (GST/tax) | `EntryLine.taxLines` | |
| `Voucher.nested` (inventory lines) | `EntryLine.stockItemId` + `.quantity` | |
| `StockItem.*` | `StockItem.*` | Quantity strings split into amount + unit |
| `TrialBalanceRow`, `StatementRow`, `MonthlyFlowRow` | — | **No home. See below.** |

### What has no home, and why that is correct

**Tally's rendered reports** — trial balance, balance sheet, profit and loss,
cash flow — do not map into this model, and should not. They are Tally's
*presentation* of the underlying entries. In the target architecture those
statements are **computed** from the normalised entries (Spec §4 L4
`fs_cash_flow_compute` says so explicitly), which is also what lets the same
entries produce both Indian and US GAAP output.

They stay useful for one thing: **checking our arithmetic against Tally's.** If
we compute a trial balance from the entries and it does not agree with the one
Tally rendered, something is wrong with our adapter — which is exactly the
`tie_out_gate` control in Spec §4 L5.

**Two gaps we cannot fill from Tally today:**

- **Audit-trail fields.** `Voucher.createdAt`, `createdBy`, `lastAlteredAt`,
  `lastAlteredBy` are in the model because most of the fraud-risk tests need
  them — entries posted at odd hours, backdated entries, entries by users who
  rarely post. The current server does not read Tally's edit log. For an Indian
  statutory audit, a client whose edit log is off is itself a finding.
- **Related-party status.** Modelled as three-state: yes, no, or *not yet
  determined*. It defaults to undetermined, and an adapter is never allowed to
  assert it — that is professional judgement.

---

## Open questions for the domain owner

1. **The debit/credit decision above.** The one that must be settled first.
2. **Account codes.** Tally has no account code; QuickBooks does. Do we need a
   firm-standard code assigned during mapping, or is the account path enough?
3. **`VoucherFamily`.** Proposed: sales, purchase, receipt, payment, contra,
   journal, credit note, debit note, stock journal, other. Is anything missing
   that a test would need to select on?
4. **Party roles.** A party can be customer and vendor at once, so roles are a
   list. Do we need more than customer / vendor / employee / bank / government?
5. **Tax regimes.** Proposed as open strings (`gst_cgst`, `tds`, `vat`,
   `us_sales_tax`) rather than a fixed list, so a new jurisdiction does not
   require a model change. Do you want a controlled vocabulary instead?
6. **Multi-currency.** Currency is per entity. Transactions in a foreign
   currency currently have nowhere to record the original amount and rate —
   needed for AS 11 / Ind AS 21 / ASC 830. Do we add it now or when the first
   multi-currency client arrives?

## What happens next

Once this is signed off: build the Tally adapter against it, and prove the
adapter by computing a trial balance from the normalised entries and agreeing
it to the one TallyPrime renders. That tie-out is both the acceptance test for
the adapter and the first working piece of the `tie_out_gate` control.

Nothing else should be built on this model until that agreement holds.
