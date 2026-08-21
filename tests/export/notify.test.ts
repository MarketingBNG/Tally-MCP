import { describe, it, expect } from 'vitest';
import { psQuote } from '../../installer/scripts/lib/notify.mjs';

/**
 * The failure notification.
 *
 * This matters more than it looks. Once the scheduled task started running
 * hidden — no console, nothing on screen — the toast became the only thing that
 * surfaces a failure while somebody is at the machine. The `LAST RUN FAILED`
 * filename and run-log.txt are the durable record, but nobody is looking at the
 * folder; the toast is what makes them look.
 *
 * The escaping is the part worth pinning. The message carries a COMPANY NAME
 * straight from TallyPrime, and company names contain apostrophes — "O'Brien &
 * Co" is an ordinary client. An unescaped one would break the PowerShell
 * command, and the notification would silently never appear: the failure would
 * be invisible precisely on the companies whose names are awkward.
 *
 * `toast()` itself is not called here — it puts a real notification on the
 * screen of whoever runs the tests, which is not a thing a test suite should do.
 * It was verified against the live machine instead (2026-08-20), including with
 * apostrophes in both the title and the message.
 */

describe('quoting for PowerShell', () => {
  it('wraps a plain string in single quotes', () => {
    expect(psQuote('MUDALS TECHNOLOGIES')).toBe("'MUDALS TECHNOLOGIES'");
  });

  it("doubles an apostrophe, which is PowerShell's escape", () => {
    // The real case: a company name with an apostrophe in it.
    expect(psQuote("O'Brien & Co")).toBe("'O''Brien & Co'");
  });

  it('survives a name that is nothing but quotes', () => {
    expect(psQuote("'''")).toBe("''''''''");
  });

  it('leaves the characters PowerShell does not expand inside single quotes', () => {
    // `$` and backtick are only special inside DOUBLE quotes. Escaping them
    // here would put literal backslashes into the notification text.
    expect(psQuote('$total `x` 100%')).toBe("'$total `x` 100%'");
  });

  it('coerces a non-string rather than throwing', () => {
    expect(psQuote(42)).toBe("'42'");
  });
});
