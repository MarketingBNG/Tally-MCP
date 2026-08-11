import { describe, it, expect } from 'vitest';
import {
  resolvePagination,
  paginate,
  assertWithinRecordLimit,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../src/utils/pagination.js';
import type { TallyError } from '../../src/tally/TallyError.js';

describe('resolvePagination', () => {
  it('applies documented defaults', () => {
    expect(resolvePagination()).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('accepts the maximum page size', () => {
    expect(resolvePagination(1, MAX_PAGE_SIZE).pageSize).toBe(MAX_PAGE_SIZE);
  });

  it('rejects a page size above the maximum', () => {
    try {
      resolvePagination(1, MAX_PAGE_SIZE + 1);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TallyError).code).toBe('INVALID_PARAMETERS');
    }
  });

  it('rejects non-positive and non-integer values', () => {
    expect(() => resolvePagination(0)).toThrowError(/page must be/);
    expect(() => resolvePagination(-1)).toThrowError(/page must be/);
    expect(() => resolvePagination(1.5)).toThrowError(/page must be/);
    expect(() => resolvePagination(1, 0)).toThrowError(/pageSize must be/);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 250 }, (_, i) => i + 1);

  it('returns the first page and flags more to come', () => {
    const result = paginate(items, { page: 1, pageSize: 100 });
    expect(result.items).toHaveLength(100);
    expect(result.items[0]).toBe(1);
    expect(result.pagination.hasMore).toBe(true);
  });

  it('returns a partial final page with hasMore false', () => {
    const result = paginate(items, { page: 3, pageSize: 100 });
    expect(result.items).toHaveLength(50);
    expect(result.pagination.hasMore).toBe(false);
  });

  it('reports a real total, since Tally hands back the whole set at once', () => {
    expect(paginate(items, { page: 1, pageSize: 100 }).pagination.total).toBe(250);
  });

  it('treats an empty result as success, not an error', () => {
    // "Nothing matched" is a meaningful audit finding and must not look
    // like a failed query.
    const result = paginate([], { page: 1, pageSize: 100 });
    expect(result.items).toEqual([]);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.total).toBe(0);
  });

  it('returns an empty page past the end without throwing', () => {
    const result = paginate(items, { page: 99, pageSize: 100 });
    expect(result.items).toEqual([]);
    expect(result.pagination.hasMore).toBe(false);
  });

  it('omits warnings entirely when there are none', () => {
    expect(paginate(items, { page: 1, pageSize: 10 }).warnings).toBeUndefined();
  });

  it('surfaces warnings when records failed to parse', () => {
    const result = paginate(items, { page: 1, pageSize: 10 }, ['2 records could not be read']);
    expect(result.warnings).toEqual(['2 records could not be read']);
  });
});

describe('assertWithinRecordLimit', () => {
  it('permits a query at exactly the limit', () => {
    expect(() => assertWithinRecordLimit(5000, 5000, 'narrow it')).not.toThrow();
  });

  it('refuses an oversized query with RESULT_LIMIT_EXCEEDED, not a timeout', () => {
    // Discovering size by timing out would report TALLY_TIMEOUT and send the
    // user chasing a connectivity problem that does not exist.
    try {
      assertWithinRecordLimit(5001, 5000, 'Try a single month.');
      expect.unreachable('should have thrown');
    } catch (error) {
      const tallyError = error as TallyError;
      expect(tallyError.code).toBe('RESULT_LIMIT_EXCEEDED');
      expect(tallyError.suggestion).toBe('Try a single month.');
      expect(tallyError.message).toContain('5000');
    }
  });
});
