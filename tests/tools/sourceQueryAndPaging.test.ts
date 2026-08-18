import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  MockTallyServer,
  callToolEnvelope,
  callToolOk,
  createToolRegistry,
  makeDeps,
  type ToolRegistry,
} from './harness.js';
import { registerMasterTools } from '../../src/tools/masters.js';

/**
 * Two gaps the connector review recorded, covered together because both need a
 * result set bigger than anything the other fixtures hold.
 *
 * 1. `TALLY_SOURCE_QUERY_MODE=compact` — the XML transcript in `source_query`
 *    is often the largest thing in a response. Compact mode trims it. What
 *    matters is that it trims ONLY that: no warning, figure or caveat may move,
 *    and the company scope must survive, since that is what a reader checks
 *    when two companies are open.
 *
 * 2. PAGINATION AT SCALE — every list call in the review returned in one page,
 *    so multi-page traversal was never exercised against a real population.
 *    These walk 250 ledgers end to end and assert the pages partition the set
 *    exactly: no record dropped, none served twice.
 */

let mock: MockTallyServer;
let port: number;

const COMPANY = 'EXAMPLE TRADING PRIVATE LIMITED';

const COMPANY_LIST = `<ENVELOPE><BODY><DATA><COLLECTION>
  <COMPANY NAME="${COMPANY}" RESERVEDNAME="">
    <STARTINGFROM TYPE="Date">20250401</STARTINGFROM>
    <ENDINGAT TYPE="Date">20260331</ENDINGAT>
    <NAME TYPE="String">${COMPANY}</NAME>
    <CURRENCYNAME TYPE="String">$</CURRENCYNAME>
    <COUNTRYNAME TYPE="String">United States of America</COUNTRYNAME>
  </COMPANY>
</COLLECTION></DATA></BODY></ENVELOPE>`;

const LEDGER_COUNT = 250;

/** A ledger population large enough to need real paging. */
const MANY_LEDGERS = (() => {
  const ledgers = Array.from({ length: LEDGER_COUNT }, (_, index) => {
    const n = String(index).padStart(4, '0');
    return (
      `<LEDGER NAME="Ledger ${n}">` +
      `<NAME TYPE="String">Ledger ${n}</NAME>` +
      `<PARENT TYPE="String">Sundry Debtors</PARENT>` +
      `<CLOSINGBALANCE TYPE="Amount">${String(index * 10)}</CLOSINGBALANCE>` +
      `</LEDGER>`
    );
  }).join('');
  return `<ENVELOPE><BODY><DATA><COLLECTION>${ledgers}</COLLECTION></DATA></BODY></ENVELOPE>`;
})();

function build(overrides: Record<string, string> = {}): ToolRegistry {
  const registry = createToolRegistry();
  registerMasterTools(registry.server, makeDeps(port, overrides));
  return registry;
}

beforeAll(async () => {
  mock = new MockTallyServer();
  port = await mock.start();
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.reset();
  mock.onBodyContaining('List of Companies', { body: COMPANY_LIST });
  mock.onBodyContaining('<ID>Ledgers</ID>', { body: MANY_LEDGERS });
});

describe('source_query compaction', () => {
  it('emits the full request body on first use, at the default setting', async () => {
    const envelope = await callToolEnvelope(build(), 'tally_get_masters', {
      type: 'ledger',
      pageSize: 5,
    });

    const queries = envelope.source_query as string[];
    // The default must not have moved: this is the reproducibility claim.
    expect(queries.some((q) => q.includes('<ENVELOPE>') && q.includes('NATIVEMETHOD'))).toBe(true);
  });

  it('reduces each query to a descriptor in compact mode', async () => {
    const envelope = await callToolEnvelope(
      build({ TALLY_SOURCE_QUERY_MODE: 'compact' }),
      'tally_get_masters',
      { type: 'ledger', pageSize: 5 }
    );

    const queries = envelope.source_query as string[];
    expect(queries.some((q) => q.includes('Collection "Ledgers"'))).toBe(true);
    // No XML survives.
    expect(queries.every((q) => !q.includes('<ENVELOPE>'))).toBe(true);
    expect(queries.every((q) => !q.includes('NATIVEMETHOD'))).toBe(true);
  });

  it('keeps the company scope, which is what disambiguates two open companies', async () => {
    const envelope = await callToolEnvelope(
      build({ TALLY_SOURCE_QUERY_MODE: 'compact' }),
      'tally_get_masters',
      { type: 'ledger', company: COMPANY, pageSize: 5 }
    );

    const queries = (envelope.source_query as string[]).join('\n');
    expect(queries).toContain(`company="${COMPANY}"`);
  });

  it('says how to get the replayable body back', async () => {
    const envelope = await callToolEnvelope(
      build({ TALLY_SOURCE_QUERY_MODE: 'compact' }),
      'tally_get_masters',
      { type: 'ledger', pageSize: 5 }
    );

    expect((envelope.source_query as string[])[0]).toContain('TALLY_SOURCE_QUERY_MODE=full');
  });

  it('changes nothing about the data or its warnings', async () => {
    // The whole risk of a size optimisation in this codebase is that it quietly
    // drops the sentence saying a figure is wrong. Compaction must be confined
    // to the transcript.
    const full = await callToolOk(build(), 'tally_get_masters', { type: 'ledger', pageSize: 7 });
    const compact = await callToolOk(build({ TALLY_SOURCE_QUERY_MODE: 'compact' }), 'tally_get_masters', {
      type: 'ledger',
      pageSize: 7,
    });

    expect(compact.items).toEqual(full.items);
    expect(compact.warnings).toEqual(full.warnings);
    expect(compact.pagination).toEqual(full.pagination);
  });
});

describe('source_query dedupe (the default)', () => {
  /**
   * One registry, so one TallyClient and one session — the shape of a real
   * conversation, where the same company-list and currency-list requests are
   * re-sent on nearly every call.
   */
  it('emits the body in full the first time and a descriptor after', async () => {
    const registry = build();

    const first = await callToolEnvelope(registry, 'tally_get_masters', {
      type: 'ledger',
      company: COMPANY,
      pageSize: 5,
    });
    const second = await callToolEnvelope(registry, 'tally_get_masters', {
      type: 'ledger',
      company: COMPANY,
      pageSize: 5,
    });

    const firstQueries = (first.source_query as string[]).join(" ");
    const secondQueries = (second.source_query as string[]).join(" ");

    // Verbatim first — this is what keeps every figure reproducible.
    expect(firstQueries).toContain('<ENVELOPE>');
    expect(firstQueries).toContain('NATIVEMETHOD');
    // Repetition only is what goes.
    expect(secondQueries).not.toContain('<ENVELOPE>');
    expect(secondQueries).toContain('[body shown in full earlier this session]');
  });

  it('leaves the descriptor self-identifying, not a bare back-reference', async () => {
    // The first body is emitted byte-for-byte with no marker added to it, so a
    // numeric "#3" would point at nothing. The descriptor has to stand alone.
    const registry = build();
    await callToolEnvelope(registry, 'tally_get_masters', { type: 'ledger', company: COMPANY, pageSize: 5 });
    const second = await callToolEnvelope(registry, 'tally_get_masters', {
      type: 'ledger',
      company: COMPANY,
      pageSize: 5,
    });

    const queries = (second.source_query as string[]).join(" ");
    expect(queries).toContain('Collection "Ledgers"');
    expect(queries).toContain(`company="${COMPANY}"`);
  });

  it('never annotates the verbatim body it emits first', async () => {
    // Something a consumer replays must not carry notes of ours inside it.
    const registry = build();
    const first = await callToolEnvelope(registry, 'tally_get_masters', {
      type: 'ledger',
      company: COMPANY,
      pageSize: 5,
    });

    const body = (first.source_query as string[]).find((q) => q.includes('<ID>Ledgers</ID>')) ?? '';
    expect(body.startsWith('<ENVELOPE>')).toBe(true);
    expect(body.endsWith('</ENVELOPE>')).toBe(true);
  });

  it('starts fresh for a different session', async () => {
    // A new client is a new conversation; it has seen nothing.
    await callToolEnvelope(build(), 'tally_get_masters', { type: 'ledger', company: COMPANY, pageSize: 5 });
    const other = await callToolEnvelope(build(), 'tally_get_masters', {
      type: 'ledger',
      company: COMPANY,
      pageSize: 5,
    });

    expect((other.source_query as string[]).join(" ")).toContain('<ENVELOPE>');
  });

  it('repeats the body every time at full', async () => {
    const registry = build({ TALLY_SOURCE_QUERY_MODE: 'full' });
    await callToolEnvelope(registry, 'tally_get_masters', { type: 'ledger', company: COMPANY, pageSize: 5 });
    const second = await callToolEnvelope(registry, 'tally_get_masters', {
      type: 'ledger',
      company: COMPANY,
      pageSize: 5,
    });

    expect((second.source_query as string[]).join(" ")).toContain('NATIVEMETHOD');
  });

  it('changes nothing about the data or its warnings', async () => {
    // Same guarantee as compact mode: the saving is confined to the transcript.
    const registry = build();
    const first = await callToolOk(registry, 'tally_get_masters', { type: 'ledger', company: COMPANY, pageSize: 7 });
    const second = await callToolOk(registry, 'tally_get_masters', {
      type: 'ledger',
      company: COMPANY,
      pageSize: 7,
    });

    expect(second.items).toEqual(first.items);
    expect(second.warnings).toEqual(first.warnings);
  });
});

describe('pagination across a population that needs several pages', () => {
  it('reports the true total on page one, not the page size', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', {
      type: 'ledger',
      pageSize: 40,
    });

    const pagination = result.pagination as { total: number; hasMore: boolean; page: number };
    expect(pagination.total).toBe(LEDGER_COUNT);
    expect(pagination.hasMore).toBe(true);
    expect((result.items as unknown[]).length).toBe(40);
  });

  it('walks every page and partitions the population exactly', async () => {
    // The real test: no record dropped between pages, none served twice. A
    // slice computed off the wrong base would show up here and nowhere else.
    const registry = build();
    const seen: string[] = [];
    const pageSize = 40;

    for (let page = 1; page <= Math.ceil(LEDGER_COUNT / pageSize); page++) {
      const result = await callToolOk(registry, 'tally_get_masters', {
        type: 'ledger',
        pageSize,
        page,
      });
      for (const item of result.items as { name: string }[]) seen.push(item.name);
    }

    expect(seen).toHaveLength(LEDGER_COUNT);
    expect(new Set(seen).size).toBe(LEDGER_COUNT);
    expect(seen[0]).toBe('Ledger 0000');
    expect(seen[LEDGER_COUNT - 1]).toBe(`Ledger ${String(LEDGER_COUNT - 1).padStart(4, '0')}`);
  });

  it('marks the last page as complete rather than leaving hasMore set', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', {
      type: 'ledger',
      pageSize: 40,
      page: Math.ceil(LEDGER_COUNT / 40),
    });

    const pagination = result.pagination as { hasMore: boolean; total: number };
    expect(pagination.hasMore).toBe(false);
    expect((result.items as unknown[]).length).toBe(LEDGER_COUNT % 40 || 40);
  });

  it('returns an empty page past the end rather than wrapping to the start', async () => {
    const result = await callToolOk(build(), 'tally_get_masters', {
      type: 'ledger',
      pageSize: 40,
      page: 99,
    });

    expect(result.items).toEqual([]);
    expect((result.pagination as { hasMore: boolean }).hasMore).toBe(false);
  });
});
