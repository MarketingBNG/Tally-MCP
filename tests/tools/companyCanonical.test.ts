import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockTallyServer } from '../../mock-tally/server.js';
import { TallyClient } from '../../src/tally/TallyClient.js';
import { loadConfig } from '../../src/config/config.js';
import { createLogger } from '../../src/utils/logger.js';
import {
  assertCompanyIsLoaded,
  resolvePeriodForCompany,
  type ToolDeps,
} from '../../src/tools/toolResult.js';

/**
 * The wrong-attribution bug these cover.
 *
 * `assertCompanyIsLoaded` matches the caller's company name **case-insensitively**,
 * but TallyPrime matches `SVCURRENTCOMPANY` **exactly** — and on a mismatch Tally
 * raises no error at all: it silently answers from whichever company is loaded.
 *
 * The function used to return void, so the caller's own spelling went on to the
 * wire. A request for `"example trading private limited"` therefore passed
 * validation, reached Tally in that casing, and produced real figures attributed
 * to a name the company does not have. With one company loaded the numbers
 * happened to be right; with two loaded it is a silent wrong-company answer.
 *
 * It now returns the name as Tally spells it, and every call site uses that.
 * These tests pin the contract, since the failure is invisible from the outside:
 * a wrong-company answer looks exactly like a right one.
 */

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const fixture = (name: string): string => readFileSync(fixturePath(name), 'utf8');

let mock: MockTallyServer;
let port: number;

/** The name exactly as the fixture spells it. */
const LOADED = 'EXAMPLE TRADING PRIVATE LIMITED';

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: fixture('company-list.xml') });
});

function depsFor(): ToolDeps {
  const config = loadConfig({
    TALLY_HOST: '127.0.0.1',
    TALLY_PORT: String(port),
    LOG_LEVEL: 'error',
    // Cache off so each assertion sees its own request rather than the previous
    // test's response.
    TALLY_CACHE_TTL_MS: '0',
  });
  const logger = createLogger('error');
  return { client: new TallyClient(config, logger), config, logger };
}

describe('assertCompanyIsLoaded returns the canonical company name', () => {
  it('returns undefined when no company was named', async () => {
    // Nothing to canonicalise: Tally uses whatever is loaded, and the request
    // must omit SVCURRENTCOMPANY entirely rather than send an empty one.
    await expect(assertCompanyIsLoaded(depsFor(), undefined)).resolves.toBeUndefined();
  });

  it("replaces the caller's casing with TallyPrime's own spelling", async () => {
    // The bug, in one assertion. Lower-cased in, canonical out.
    const resolved = await assertCompanyIsLoaded(depsFor(), 'example trading private limited');
    expect(resolved).toBe(LOADED);
  });

  it('canonicalises mixed casing too', async () => {
    const resolved = await assertCompanyIsLoaded(depsFor(), 'Example Trading Private Limited');
    expect(resolved).toBe(LOADED);
  });

  it('strips a trailing newline before matching', async () => {
    // Company names created by copy-paste routinely carry a trailing CR or LF,
    // and such a name is documented to make Tally reject SVCURRENTCOMPANY in a
    // way that cannot be diagnosed from outside. Trim first, then match.
    const resolved = await assertCompanyIsLoaded(depsFor(), `${LOADED}\r\n`);
    expect(resolved).toBe(LOADED);
  });

  it('treats a whitespace-only name as no name rather than a miss', async () => {
    await expect(assertCompanyIsLoaded(depsFor(), '   ')).resolves.toBeUndefined();
  });

  it('still refuses a company that is genuinely not loaded', async () => {
    // The canonicalisation must not become a way to smuggle an unknown name
    // through: an unverified name reaching Tally's request path is the behaviour
    // that has taken the application down.
    await expect(assertCompanyIsLoaded(depsFor(), 'SOME OTHER CO')).rejects.toThrow(
      /does not have "SOME OTHER CO" open/
    );
  });

  it('names the loaded company in the refusal, so the caller can correct it', async () => {
    await expect(assertCompanyIsLoaded(depsFor(), 'SOME OTHER CO')).rejects.toThrow(
      new RegExp(LOADED)
    );
  });
});

describe('the canonical name is what actually reaches TallyPrime', () => {
  it("sends TallyPrime's spelling in SVCURRENTCOMPANY, not the caller's", async () => {
    // The end-to-end guarantee. Asserting on the returned string alone would
    // pass even if a call site ignored it, which is exactly how the original
    // bug survived: the validation was right and the request was wrong.
    mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });

    const deps = depsFor();
    const canonical = await assertCompanyIsLoaded(deps, 'example trading private limited');

    const { buildLedgerListRequest } = await import('../../src/tally/requests.js');
    await deps.client.send(
      buildLedgerListRequest({ ...(canonical === undefined ? {} : { company: canonical }) })
    );

    // Only the ledger request carries a company scope; the company-list probe
    // that resolved the name deliberately does not.
    const sent = mock.requests
      .map((request) => request.body)
      .filter((body) => body.includes('<ID>Ledgers</ID>'))
      .join('\n');

    expect(sent).toContain(`<SVCURRENTCOMPANY>${LOADED}</SVCURRENTCOMPANY>`);
    // The load-bearing negative: the caller's spelling must not reach the wire.
    expect(sent).not.toContain('example trading private limited');
  });
});

describe('the default period is the company book year, not an assumed Indian one', () => {
  /**
   * A1. `resolvePeriod` defaults to `financialYearFor(today)`, hard-coded to
   * 1 April – 31 March. For a company on a calendar year — a US LLC, which is
   * what this connector is most often pointed at — that window straddles two of
   * its own years, so every date-defaulted total silently blends the second half
   * of one reporting period with the first half of the next.
   *
   * `tally_check_tie_out` already anchored on the company's own year by hand.
   * `resolvePeriodForCompany` makes that the default for every tool.
   */
  it("uses the loaded company's own book year when no dates are given", async () => {
    // The shared fixture's books run 2021-04-01 to 2022-03-31.
    const period = await resolvePeriodForCompany(depsFor());
    expect(period).toEqual({ fromDate: '2021-04-01', toDate: '2022-03-31' });
  });

  it('anchors a calendar-year company on January, not April', async () => {
    mock.reset();
    mock.onBodyContaining('List of Companies', {
      body: [
        '<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="CALENDAR YEAR LLC">',
        '<ENDINGAT TYPE="Date">20261231</ENDINGAT>',
        '<STARTINGFROM TYPE="Date">20260101</STARTINGFROM>',
        '<NAME TYPE="String">CALENDAR YEAR LLC</NAME>',
        '</COMPANY></COLLECTION></DATA></BODY></ENVELOPE>',
      ].join(''),
    });

    // The bug this fixes: the old default would have returned
    // 2026-04-01..2027-03-31, which contains only nine months of this company's
    // year and three of the next.
    const period = await resolvePeriodForCompany(depsFor());
    expect(period).toEqual({ fromDate: '2026-01-01', toDate: '2026-12-31' });
  });

  it('does not consult the company at all when dates are supplied', async () => {
    const deps = depsFor();
    const before = mock.requests.length;

    const period = await resolvePeriodForCompany(deps, '2024-02-01', '2024-02-29');

    expect(period).toEqual({ fromDate: '2024-02-01', toDate: '2024-02-29' });
    // Explicit dates must not cost a round trip: this runs on every call.
    expect(mock.requests.length).toBe(before);
  });

  it('still refuses a single date rather than guessing the other end', async () => {
    await expect(resolvePeriodForCompany(depsFor(), '2024-02-01')).rejects.toThrow(
      /Supply both fromDate and toDate/
    );
  });

  it('falls back to the financial year containing today when the company is unreadable', async () => {
    mock.reset();
    mock.onBodyContaining('List of Companies', {
      body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
    });

    // Previous behaviour preserved rather than failing the call: a tool that
    // could answer must not break because a metadata lookup came back empty.
    const period = await resolvePeriodForCompany(depsFor());
    expect(period.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(period.toDate > period.fromDate).toBe(true);
  });
});
