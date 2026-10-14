import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../../config/config.js';

/**
 * The write log: one JSON line per write sent to TallyPrime.
 *
 * Append-only and local. It is what lets an accountant answer "what did Claude
 * change in these books, when, and how do I undo it" without trusting anybody's
 * memory — including Claude's. Every entry carries the exact XML sent and
 * TallyPrime's exact reply, so the log is evidence, not a summary.
 */

export type WriteOutcome = 'WRITTEN' | 'REJECTED' | 'UNEXPECTED_CHANGE' | 'OUTCOME_UNKNOWN';

export interface WriteLogEntry {
  at: string;
  tool: string;
  company: string;
  outcome: WriteOutcome;
  summary: string;
  preview: Record<string, unknown>;
  requestXml: string;
  responseXml: string | null;
  problems: string[];
  readBack: unknown;
  undo: string | null;
}

export function writeLogPath(config: AppConfig): string {
  return (
    config.tallyWriteLogPath ??
    join(process.env.LOCALAPPDATA ?? homedir(), 'tally-mcp', 'write-log.jsonl')
  );
}

/**
 * Append one entry. A failure to log is raised, not swallowed: the caller
 * reports it alongside the write's outcome, because an unlogged write is
 * exactly what this file exists to prevent going unnoticed.
 */
export function appendWriteLog(config: AppConfig, entry: WriteLogEntry): void {
  const path = writeLogPath(config);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** The most recent entries, newest first. Lines that do not parse are skipped, never fatal. */
export function readWriteLog(config: AppConfig, limit: number): WriteLogEntry[] {
  const path = writeLogPath(config);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const entries: WriteLogEntry[] = [];
  for (const line of lines.reverse()) {
    try {
      entries.push(JSON.parse(line) as WriteLogEntry);
    } catch {
      continue;
    }
    if (entries.length >= limit) break;
  }
  return entries;
}
