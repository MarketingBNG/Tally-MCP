import { TallyError } from '../tally/TallyError.js';

/**
 * Pagination.
 *
 * IMPORTANT: this is **client-side slicing over a full fetch**, not
 * server-side paging. TallyPrime does not paginate — a request returns its
 * entire result set — so `pageSize: 100` does not mean a cheap request. The
 * server fetches everything Tally returns and slices it in memory.
 *
 * Because of that, oversized queries are refused up front rather than
 * attempted: see `assertWithinRecordLimit()`. Every tool description that
 * takes page/pageSize must say this so Claude does not mistake paging for
 * a way to make an expensive query cheap.
 */

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  hasMore: boolean;
  /**
   * Present only when the full result set was actually materialised — which
   * it is here, since Tally hands back everything at once. Never fabricated
   * or estimated; omitted entirely if a code path cannot know it cheaply.
   */
  total?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
  /** Non-fatal problems, e.g. records that failed to parse. */
  warnings?: string[];
}

/** Normalise and validate caller-supplied paging parameters. */
export function resolvePagination(page?: number, pageSize?: number): PaginationParams {
  const resolvedPage = page ?? 1;
  const resolvedSize = pageSize ?? DEFAULT_PAGE_SIZE;

  if (!Number.isInteger(resolvedPage) || resolvedPage < 1) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `page must be a whole number of 1 or more; received ${String(page)}.`
    );
  }
  if (!Number.isInteger(resolvedSize) || resolvedSize < 1 || resolvedSize > MAX_PAGE_SIZE) {
    throw new TallyError(
      'INVALID_PARAMETERS',
      `pageSize must be a whole number between 1 and ${String(MAX_PAGE_SIZE)}; received ${String(pageSize)}.`
    );
  }

  return { page: resolvedPage, pageSize: resolvedSize };
}

/**
 * Refuse a query whose full result set would exceed the in-memory ceiling.
 *
 * Called *before* committing to a fetch wherever a cheap size estimate is
 * available, so the user gets RESULT_LIMIT_EXCEEDED rather than a confusing
 * TALLY_TIMEOUT that suggests a connectivity problem.
 */
export function assertWithinRecordLimit(
  estimatedRecords: number,
  maxRecords: number,
  hint: string
): void {
  if (estimatedRecords > maxRecords) {
    throw new TallyError(
      'RESULT_LIMIT_EXCEEDED',
      `This query would return about ${String(estimatedRecords)} records, above the limit of ${String(maxRecords)}.`,
      { suggestion: hint }
    );
  }
}

/**
 * Slice a fully-fetched result set into a page.
 *
 * An empty page is a legitimate outcome, not an error: a valid query that
 * matches nothing returns `items: []`. "Nothing matched" is a meaningful
 * finding in an audit and must not be reported as a failure.
 */
export function paginate<T>(
  items: readonly T[],
  { page, pageSize }: PaginationParams,
  warnings?: string[]
): PaginatedResult<T> {
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);

  return {
    items: slice,
    pagination: {
      page,
      pageSize,
      hasMore: start + pageSize < items.length,
      total: items.length,
    },
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}
