import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { PriorYearStore } from '../tools/vouchers/priorYearStore.js';

/**
 * Earlier book years, kept between export runs so a change to today's books
 * does not re-read five years of history.
 *
 * ## Why
 *
 * The years before the current one come from the Voucher Register report, a
 * month or two per request, and they are nearly all of an export's cost: 27s
 * and 103s for two prior years on MUDALS, against about 2s for the current
 * year. Client run logs (2026-10-07) show whole exports of 102-249s, which is
 * TallyPrime unusable for that long, every time somebody's edits settle.
 *
 * ## Why this is safe to reuse
 *
 * The change check cannot see an earlier year at all: the fingerprint is read
 * from a voucher COLLECTION, which only ever serves the current year. So an
 * edit to a prior year was already only guaranteed to reach the workbook at the
 * daily run. Reusing the saved years on a 'changed' run keeps exactly that
 * guarantee, and the daily, first and forced runs read everything fresh and
 * replace what is saved. The workbook's Manifest says when years were carried
 * over, so nobody is told the history was re-read when it was not.
 *
 * What is saved is TallyPrime's own response, keyed on the exact request, and
 * it goes back through the same parser — so a carried-over year cannot come
 * out differently from a fresh read of the same bytes.
 *
 * ## Where
 *
 * On this computer, never in the export folder. That folder syncs to the cloud,
 * and these files are tens of megabytes of raw client data that nobody reads.
 * Losing them costs one slow export, nothing else.
 */

/** A saved year older than this is not trusted: the daily refresh has not run. */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export type PriorYearMode = 'reuse' | 'refresh';

export interface ExportPriorYearStore extends PriorYearStore {
  /** After a refresh, drop saved years this run did not write. */
  finish(): void;
}

export function priorYearFolder(exportFolder: string, company: string): string {
  const base = process.env.LOCALAPPDATA ?? tmpdir();
  const id = createHash('sha256').update(`${exportFolder}\n${company}`).digest('hex').slice(0, 16);
  return join(base, 'TallyPrime for Claude', 'earlier years', id);
}

export function priorYearStore(
  folder: string,
  mode: PriorYearMode,
  now: Date = new Date()
): ExportPriorYearStore {
  const written = new Set<string>();
  const fileFor = (request: string): string =>
    join(folder, `${createHash('sha256').update(request).digest('hex')}.json.gz`);

  return {
    read(request) {
      if (mode === 'refresh') return null;
      const file = fileFor(request);
      try {
        if (now.getTime() - statSync(file).mtimeMs > MAX_AGE_MS) return null;
        const saved = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as {
          body?: unknown;
          repairs?: unknown;
        };
        if (typeof saved.body !== 'string' || !Array.isArray(saved.repairs)) return null;
        return { body: saved.body, repairs: saved.repairs.map(String) };
      } catch {
        return null;
      }
    },

    write(request, response) {
      const file = fileFor(request);
      try {
        mkdirSync(folder, { recursive: true });
        const payload = JSON.stringify({ body: response.body, repairs: response.repairs });
        writeFileSync(`${file}.tmp`, gzipSync(payload));
        // Remove first: a rename onto an existing file fails on Windows.
        rmSync(file, { force: true });
        renameSync(`${file}.tmp`, file);
        written.add(file);
      } catch {
        // A year that cannot be saved is read from Tally next time. Never fatal.
      }
    },

    finish() {
      if (mode !== 'refresh') return;
      try {
        for (const entry of readdirSync(folder)) {
          const file = join(folder, entry);
          if (!written.has(file)) rmSync(file, { force: true });
        }
      } catch {
        // Nothing saved yet, or the folder is gone. Either way nothing to tidy.
      }
    },
  };
}
