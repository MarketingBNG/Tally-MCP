import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReportRequest,
  buildCollectionRequest,
  buildConnectionProbeRequest,
  buildLedgerListRequest,
  buildGroupListRequest,
  buildTrialBalanceRequest,
  escapeXml,
  FORBIDDEN_WRITE_VERBS,
  UNSCOPED,
} from '../../src/tally/requests.js';

describe('escapeXml', () => {
  it('escapes every character that would break the envelope', () => {
    expect(escapeXml('Gupta & Co <"Ltd">')).toBe('Gupta &amp; Co &lt;&quot;Ltd&quot;&gt;');
  });

  it('escapes apostrophes in party names', () => {
    expect(escapeXml("O'Brien")).toBe('O&apos;Brien');
  });
});

describe('request builders', () => {
  it('always issues Export, never a write verb', () => {
    const requests = [
      buildReportRequest('Trial Balance', { company: UNSCOPED }),
      buildCollectionRequest('Ledgers', 'Ledger', ['Name'], { company: UNSCOPED }),
      buildConnectionProbeRequest(),
    ];

    for (const request of requests) {
      expect(request).toContain('<TALLYREQUEST>Export</TALLYREQUEST>');
      for (const verb of FORBIDDEN_WRITE_VERBS) {
        expect(request).not.toContain(`<TALLYREQUEST>${verb}</TALLYREQUEST>`);
      }
    }
  });

  it('converts ISO dates to Tally format', () => {
    const request = buildTrialBalanceRequest({
      company: UNSCOPED,
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
    });

    expect(request).toContain('<SVFROMDATE>20260401</SVFROMDATE>');
    expect(request).toContain('<SVTODATE>20260430</SVTODATE>');
  });

  it('omits company scoping only when UNSCOPED is passed explicitly', () => {
    // The tag is dropped, but the caller had to SAY so. See CompanyScope.
    expect(buildReportRequest('DayBook', { company: UNSCOPED })).not.toContain('SVCURRENTCOMPANY');
  });

  it('throws rather than emitting an undefined company scope', () => {
    // Unreachable from TypeScript — `company` is required — so this guards the
    // untyped call site. Emitting <SVCURRENTCOMPANY>undefined</SVCURRENTCOMPANY>
    // would be a NAME MISMATCH, and TallyPrime answers a mismatch from whichever
    // company is loaded rather than erroring: silently the wrong entity's books.
    expect(() =>
      buildReportRequest('DayBook', {} as unknown as { company: typeof UNSCOPED })
    ).toThrow(/no company scope/);
  });

  it('escapes a company name containing XML metacharacters', () => {
    const request = buildReportRequest('DayBook', { company: 'Gupta & Sons <Pvt>' });
    expect(request).toContain('<SVCURRENTCOMPANY>Gupta &amp; Sons &lt;Pvt&gt;</SVCURRENTCOMPANY>');
    // The raw ampersand must not survive, or the envelope itself is malformed.
    expect(request).not.toMatch(/Gupta & Sons/);
  });

  it('requests XML by default and JSON only when asked', () => {
    expect(buildReportRequest('DayBook', { company: UNSCOPED })).toContain('$$SysName:XML');

    const json = buildReportRequest('DayBook', { company: UNSCOPED, format: 'json' });
    expect(json).toContain('$$SysName:JSON');
    expect(json).toContain('<SVEXPORTINPLAINFORMAT>Yes</SVEXPORTINPLAINFORMAT>');
  });

  it('marks collections as non-modifying', () => {
    const request = buildLedgerListRequest({ company: UNSCOPED });
    expect(request).toContain('ISMODIFY="No"');
    expect(request).toContain('<TYPE>Ledger</TYPE>');
  });

  it('includes each requested native method', () => {
    const request = buildCollectionRequest('X', 'Ledger', ['Name', 'Parent', 'ClosingBalance'], { company: UNSCOPED });
    expect(request).toContain('<NATIVEMETHOD>Name</NATIVEMETHOD>');
    expect(request).toContain('<NATIVEMETHOD>Parent</NATIVEMETHOD>');
    expect(request).toContain('<NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>');
  });

  it('asks for ClosingBalance even in allFields mode, because FETCH * omits it', () => {
    // Verified live 2026-08-17: `*` does NOT carry ClosingBalance, so the
    // "everything" path returned null for the one number that matters most on
    // a party account — and null means "unreadable" everywhere else in this
    // server. Naming it alongside the wildcard is what makes the two modes
    // agree.
    const request = buildLedgerListRequest({ company: UNSCOPED }, true);
    expect(request).toContain('<FETCH>*</FETCH>');
    expect(request).toContain('<NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>');
    expect(request).toContain('<NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>');
  });

  it('returns the same curated fields in both modes, so a mode switch loses nothing', () => {
    const curated = buildLedgerListRequest({ company: UNSCOPED });
    const everything = buildLedgerListRequest({ company: UNSCOPED }, true);
    for (const method of curated.match(/<NATIVEMETHOD>[^<]+<\/NATIVEMETHOD>/g) ?? []) {
      expect(everything).toContain(method);
    }
  });

  it('produces a balanced envelope', () => {
    const request = buildLedgerListRequest({ company: 'Acme' });
    expect(request.startsWith('<ENVELOPE>')).toBe(true);
    expect(request.endsWith('</ENVELOPE>')).toBe(true);
  });

  it('builds a Group collection request with the classification fields', () => {
    const request = buildGroupListRequest({ company: UNSCOPED });
    expect(request).toContain('<ID>Groups</ID>');
    expect(request).toContain('<TYPE>Group</TYPE>');
    expect(request).toContain('<NATIVEMETHOD>IsRevenue</NATIVEMETHOD>');
    expect(request).toContain('<NATIVEMETHOD>IsDeemedPositive</NATIVEMETHOD>');
  });
});

/**
 * Security: the read-only guarantee is a headline claim of this project, so
 * it is asserted against the source tree rather than trusted.
 */
describe('read-only guarantee', () => {
  function collectSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collectSourceFiles(full, acc);
      else if (entry.endsWith('.ts')) acc.push(full);
    }
    return acc;
  }

  it('contains no write-verb request anywhere in src/', () => {
    const files = collectSourceFiles('src');
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const verb of FORBIDDEN_WRITE_VERBS) {
        // Match the wire form only: prose and identifiers mentioning these
        // words are fine, an actual request envelope is not.
        if (contents.includes(`<TALLYREQUEST>${verb}`)) {
          offenders.push(`${file}: ${verb}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
