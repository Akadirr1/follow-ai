/**
 * Typed failures. Nothing in the data-access layer throws a string or rejects with
 * a bare `Error`: repository methods resolve a `Result`, so every caller has to
 * look at `ok` before reaching for data, and every failure carries a code the UI
 * can branch on and a `retryable` flag the query layer can honour.
 */

export type DataErrorCode =
  /** The selected data mode has no implementation yet (the `supabase` stub). */
  | 'not_implemented'
  /** Caller passed something the layer rejects — bad id, empty URL, bad cursor. */
  | 'invalid_input'
  | 'not_found'
  /** The URL is well-formed but not an acceptable source (no feed, blocked host). */
  | 'unsupported_source'
  /** Source already in the catalog; carries the existing id in `details`. */
  | 'duplicate_source'
  | 'network'
  | 'rate_limited'
  | 'server'
  | 'unknown';

export type DataError = {
  code: DataErrorCode;
  /** Whether an identical retry could plausibly succeed. */
  retryable: boolean;
  message: string;
  /** Optional structured context; never raw article content or credentials. */
  details?: Record<string, string | number | boolean | null>;
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: DataError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export const err = <T = never>(
  code: DataErrorCode,
  message: string,
  options?: { retryable?: boolean; details?: DataError['details'] },
): Result<T> => ({
  ok: false,
  error: {
    code,
    message,
    retryable: options?.retryable ?? RETRYABLE_BY_DEFAULT.has(code),
    ...(options?.details ? { details: options.details } : {}),
  },
});

/** Codes whose failure is about the moment rather than the request. */
const RETRYABLE_BY_DEFAULT = new Set<DataErrorCode>(['network', 'rate_limited', 'server']);

/**
 * Thrown only where there is no `Result` channel to return through — currently
 * just `getRepositories('supabase')`, which cannot hand back a half-built
 * repository set. Method-level failures never throw.
 */
export class DataErrorException extends Error {
  readonly error: DataError;

  constructor(error: DataError) {
    super(error.message);
    this.name = 'DataErrorException';
    this.error = error;
  }
}

export const isDataErrorException = (value: unknown): value is DataErrorException =>
  value instanceof DataErrorException;
