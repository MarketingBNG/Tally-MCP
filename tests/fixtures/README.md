# Test fixtures

These are **redacted** copies of real TallyPrime 7.x responses captured from a
live install on 2026-08-10. Names, amounts and identifiers are fake. Everything
structural is not.

> **These fixtures are committed. `samples/` is not.**
>
> The originals came from a real, operating company — real ledger names, party
> names, GSTINs, turnover and balances. So every value here must be invented,
> and the structure alone is what carries over.
>
> This was got wrong once already: the first version of these fixtures replaced
> the names but kept the amounts, which put the company's actual turnover and
> expense totals into a public, MIT-licensed repository. If you add or refresh
> a fixture, **change every figure**, and check it against `samples/`:
>
> ```bash
> # any amount appearing in both is a leak
> grep -oE '[0-9]+\.[0-9]{2}' tests/fixtures/*.xml | cut -d: -f2 | sort -u \
>   | while read a; do grep -ql "$a" samples/*.xml 2>/dev/null && echo "LEAK: $a"; done
> ```
>
> Round, obviously-synthetic figures (`12345678.91`, `-9876543.21`) are used
> deliberately: they are recognisable as fake at a glance, so a real value
> reintroduced later stands out.

The quirks below are reproduced deliberately. They are the reason these
fixtures exist rather than hand-invented ones, and "tidying" any of them would
quietly delete the test:

- **Reports return parallel sibling arrays, not records.** In the trial
  balance, `<DSPACCNAME>` and `<DSPACCINFO>` alternate as siblings under
  `<ENVELOPE>`; nothing nests a name with its own amount. The association is
  positional. Balance sheet (`BSNAME`/`BSAMT`) and P&L (`DSPACCNAME`/`PLAMT`)
  do the same.
- **Empty elements mean absent, not zero.** `<DSPCLDRAMTA></DSPCLDRAMTA>` and
  `<CLOSINGBALANCE TYPE="Amount"></CLOSINGBALANCE>` both appear in real data
  alongside genuine `0.00` values, and the two must not collapse together.
- **`&#4;` appears inside real text.** See `<GSTCLASS>` in the day book. This
  is a raw control character Tally uses internally and does not strip.
- **Numbers carry leading whitespace.** `<LANGUAGEID TYPE="Number"> 1033`.
- **Debits are negative** in trial balance and P&L output.
- **Vouchers are mostly empty scaffolding.** ~200 empty date/tax elements per
  voucher; the real content is a handful of fields. Trimmed here to a
  representative sample rather than the full ~50 KB per voucher.
- **P&L reuses `BSMAINAMT`** inside `<PLAMT>` rather than a P&L-specific tag.

The unredacted originals live in `samples/`, which is gitignored — it contains
real accounting data and must never be committed.
