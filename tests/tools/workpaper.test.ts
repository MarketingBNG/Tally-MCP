import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerWorkpaperTools } from '../../src/tools/workpaper.js';

/**
 * `tally_make_workpaper`.
 *
 * The risk this tool carries is not that it renders badly — it is that it
 * renders CONVINCINGLY from something that was never in the books. So the
 * tests here are mostly about what the document refuses to say: it will not
 * write a conclusion, it will not quietly drop the limitations, and it will not
 * accept figures from the caller.
 */

let mock: MockTallyServer;
let port: number;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerWorkpaperTools(registry.server, makeDeps(port));
  return registry;
}

const PERIOD = { fromDate: '2026-07-01', toDate: '2026-07-31' };

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
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: fixture('ledger-list.xml') });
  mock.onBodyContaining('<TYPE>Voucher</TYPE>', { body: fixture('day-book.xml') });
});

async function paper(args: Record<string, unknown>): Promise<string> {
  const result = await callToolOk(build(), 'tally_make_workpaper', {
    objective: 'Establish whether any journal was posted at a round amount.',
    ...PERIOD,
    ...args,
  });
  return String(result.markdown);
}

describe('what the workpaper refuses to do', () => {
  it('does not write a conclusion, and shows the gap where one belongs', async () => {
    // The single most important behaviour. A generated conclusion in an audit
    // file is somebody else's professional judgement with their name on it.
    const markdown = await paper({ test: 'round_numbers' });

    expect(markdown).toContain('## Conclusion');
    expect(markdown).toContain('NOT RECORDED');
    expect(markdown).toContain("auditor's judgement");
  });

  it('records a conclusion when the auditor supplies one, verbatim', async () => {
    const markdown = await paper({
      test: 'round_numbers',
      conclusion: 'Two round journals were traced to approved accruals. No exceptions.',
    });

    expect(markdown).toContain('Two round journals were traced to approved accruals.');
    expect(markdown).not.toContain('NOT RECORDED');
  });

  it('reproduces every limitation in full rather than summarising them', async () => {
    // A workpaper that drops the caveats reads as saying more than the
    // procedure established, which is the failure that survives into the file.
    const weekend = await callToolOk(build(), 'tally_make_workpaper', {
      test: 'weekend',
      objective: 'Identify weekend-dated postings.',
      ...PERIOD,
    });

    const markdown = String(weekend.markdown);
    expect(markdown).toContain('## Limitations and notes');
    // The two caveats the weekend test always carries.
    expect(markdown).toContain('SATURDAY AND SUNDAY WERE ASSUMED');
    expect(markdown).toContain('not the date it was entered');
    // And they are present in the same number as the structured result.
    for (const warning of weekend.warnings as string[]) {
      expect(markdown).toContain(warning);
    }
  });

  it('requires an objective, because an unreviewable paper is worse than none', () => {
    // Rejected by the schema rather than the handler, so the call never reaches
    // TallyPrime — which is the right layer for it, but means asserting the
    // parse rather than a tool error.
    const schema = build().schemas.get('tally_make_workpaper');
    expect(() => schema?.parse({ test: 'round_numbers', ...PERIOD })).toThrow(/objective/);
  });
});

describe('what the workpaper records', () => {
  it('states the population tested and what was excluded from it', async () => {
    const markdown = await paper({ test: 'round_numbers' });
    expect(markdown).toContain('## Population');
    expect(markdown).toContain('Vouchers tested');
  });

  it('records the sampling seed and method, which is what makes it reproducible', async () => {
    const markdown = await paper({
      test: 'sample',
      objective: 'Select a sample of vouchers for substantive testing.',
      sampleSize: 3,
      sampleSeed: 'audit-2026',
      sampleMethod: 'monetary_unit',
    });

    expect(markdown).toContain('sampleSeed');
    expect(markdown).toContain('audit-2026');
    expect(markdown).toContain('monetary_unit');
    // And the block that lets a reviewer re-run it.
    expect(markdown).toContain('## Reproducing this paper');
  });

  it('shows only the parameters that applied to this procedure', async () => {
    // A cut-off day count printed on a Benford analysis invites a reviewer to
    // believe it did something.
    const markdown = await paper({
      test: 'benford',
      objective: 'Assess digit conformity of voucher amounts.',
    });

    expect(markdown).toContain('benfordDigits');
    expect(markdown).not.toContain('cutoffDays');
    expect(markdown).not.toContain('sampleSeed');
  });

  it('stamps the entity, period, preparer and source', async () => {
    const markdown = await paper({
      test: 'round_numbers',
      preparedBy: 'K. Arora',
      reference: 'C-140',
    });

    expect(markdown).toContain('K. Arora');
    expect(markdown).toContain('C-140');
    expect(markdown).toContain('2026-07-01');
    expect(markdown).toContain('TallyPrime, read-only');
  });

  it('marks an unsigned paper as unsigned rather than leaving it blank', async () => {
    const markdown = await paper({ test: 'round_numbers' });
    expect(markdown).toContain('| Prepared by | _not recorded_ |');
  });

  it('returns the structured result alongside the document, so nothing is lost', async () => {
    const result = await callToolOk(build(), 'tally_make_workpaper', {
      test: 'round_numbers',
      objective: 'Round-amount screen.',
      ...PERIOD,
    });

    expect(result).toHaveProperty('markdown');
    expect(result).toHaveProperty('population');
    expect(result.period).toMatchObject(PERIOD);
  });
});
