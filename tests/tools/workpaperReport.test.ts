import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolError,
  callToolOk,
  createToolRegistry,
  fixture,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerWorkpaperTools } from '../../src/tools/workpaper.js';

/**
 * `tally_make_workpaper` with `report` — documenting one of TallyPrime's own
 * report views.
 *
 * THE GAP THIS CLOSES. The workpaper tool only ever accepted the eight voucher
 * procedures, so everything `tally_get_report` exposes — the negative-ledger
 * exception report among them — could not be turned into a workpaper at all.
 * The only route into an audit file was a model copying rows out of one tool's
 * output and retyping them, which is exactly the transcription risk the
 * workpaper tool was built to remove.
 *
 * THE RISK IT INTRODUCES, and what these tests are mostly about. A report view
 * is NOT a performed procedure. Nothing was sampled, nothing excluded, no test
 * applied — TallyPrime decided what appears on it. A paper that renders a
 * printout under the same headings as a procedure overstates the work done, and
 * an overstated workpaper is worse than no workpaper. So the document has to
 * say what it is, and must not claim a population it never had.
 */

let mock: MockTallyServer;
let port: number;

function build(): ToolRegistry {
  const registry = createToolRegistry();
  registerWorkpaperTools(registry.server, makeDeps(port));
  return registry;
}

/** Two rows in the shape `normalizeGenericReport` reads. */
const NEGATIVE_LEDGERS = [
  '<ENVELOPE>',
  '<DSPACCNAME><DSPDISPNAME>Petty Cash</DSPDISPNAME></DSPACCNAME>',
  '<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-4200.00</DSPCLDRAMTA></DSPCLDRAMT></DSPACCINFO>',
  '<DSPACCNAME><DSPDISPNAME>Suspense A/c</DSPDISPNAME></DSPACCNAME>',
  '<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-1150.50</DSPCLDRAMTA></DSPCLDRAMT></DSPACCINFO>',
  '</ENVELOPE>',
].join('');

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
  mock.onBodyContaining('<ID>Negative Ledgers</ID>', { body: NEGATIVE_LEDGERS });
  mock.onBodyContaining('<ID>Bills Receivable</ID>', {
    body: '<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>',
  });
});

describe('a report view can be rendered as a workpaper', () => {
  it('fetches the report itself rather than accepting rows from the caller', async () => {
    const result = await callToolOk(build(), 'tally_make_workpaper', {
      report: 'negative_ledgers',
      objective: 'Identify accounts carrying a balance on the wrong side.',
      ...PERIOD,
    });

    const markdown = result.markdown as string;
    // The figures are in the document because they were read from Tally on this
    // call — the whole point of the tool.
    expect(markdown).toContain('Petty Cash');
    expect(markdown).toContain('-4200.00');
    expect(result.rows).toHaveLength(2);
    expect(
      mock.requests.filter((request) => request.body.includes('<ID>Negative Ledgers</ID>'))
    ).toHaveLength(1);
  });

  it('names the report and the entity in the header', async () => {
    const result = await callToolOk(build(), 'tally_make_workpaper', {
      report: 'negative_ledgers',
      objective: 'Exception review.',
      reference: 'C-142',
      preparedBy: 'K. Arora',
      ...PERIOD,
    });

    const markdown = result.markdown as string;
    expect(markdown).toContain('# TallyPrime report: Negative Ledgers');
    expect(markdown).toContain('| Working paper ref | C-142 |');
    expect(markdown).toContain('| Prepared by | K. Arora |');
    expect(markdown).toContain('2026-07-01 to 2026-07-31');
  });

  it('says plainly that this is a report, not a procedure that was performed', async () => {
    // The load-bearing test. Without this the paper reads as evidence of work
    // that nobody did.
    const result = await callToolOk(build(), 'tally_make_workpaper', {
      report: 'negative_ledgers',
      objective: 'Exception review.',
      ...PERIOD,
    });

    const markdown = result.markdown as string;
    expect(markdown).toContain('## Nature of this paper');
    expect(markdown).toContain('not a procedure performed by this server');
    expect(markdown).toContain('no population');
  });

  it('claims no population, because it had none', async () => {
    const result = await callToolOk(build(), 'tally_make_workpaper', {
      report: 'negative_ledgers',
      objective: 'Exception review.',
      ...PERIOD,
    });

    const markdown = result.markdown as string;
    // "Vouchers tested: 0" under an audit heading would read as a procedure
    // that found nothing rather than one that was never run.
    expect(markdown).not.toContain('Vouchers tested');
    expect(markdown).not.toContain('## Population');
  });

  it('still refuses to write the conclusion', async () => {
    const result = await callToolOk(build(), 'tally_make_workpaper', {
      report: 'negative_ledgers',
      objective: 'Exception review.',
      ...PERIOD,
    });

    expect(result.markdown as string).toContain('_not recorded_');
  });

  it('carries the unverified-row-shape warning into the paper', async () => {
    // bills_receivable has never had its rows observed. A workpaper built on it
    // must carry that, or it launders an unverified shape into an audit file.
    const result = await callToolOk(build(), 'tally_make_workpaper', {
      report: 'bills_receivable',
      objective: 'List outstanding receivable bills.',
      ...PERIOD,
    });

    const markdown = result.markdown as string;
    expect(markdown).toContain('Row shape unverified');
    expect(markdown).toContain('TallyPrime');
  });

  it('does not rename TallyPrime tag names to debit and credit', async () => {
    const result = await callToolOk(build(), 'tally_make_workpaper', {
      report: 'negative_ledgers',
      objective: 'Exception review.',
      ...PERIOD,
    });

    expect(result.markdown as string).toContain('DSPCLDRAMTA');
  });
});

describe('test and report are mutually exclusive', () => {
  it('refuses both at once rather than picking one', async () => {
    const error = await callToolError(build(), 'tally_make_workpaper', {
      test: 'journal_screen',
      report: 'negative_ledgers',
      objective: 'Ambiguous.',
      ...PERIOD,
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
    expect(error.message).toMatch(/not both/);
  });

  it('refuses neither rather than defaulting to a procedure', async () => {
    const error = await callToolError(build(), 'tally_make_workpaper', {
      objective: 'Unspecified.',
      ...PERIOD,
    });

    expect(error.code).toBe('INVALID_PARAMETERS');
    expect(error.message).toMatch(/Give either/);
  });
});
