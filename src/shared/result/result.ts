/**
 * A minimal, dependency-free `Result` type used across the language and
 * persistence layers to thread recoverable failures without exceptions.
 *
 * The domain never throws for expected failures (bad input, missing files);
 * it returns a `Result` so callers can decide how to surface them.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wrap a success value. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Wrap an error value. */
export function err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Narrow a `Result` to its success variant. */
export function isOk<T>(result: Result<T>): result is { ok: true; value: T } {
  return result.ok;
}

/** Whether the `Result` is a failure. */
export function isErr<T>(result: Result<T>): boolean {
  return !result.ok;
}

/** Map the success value, leaving failures untouched. */
export function map<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Map the error value, leaving successes untouched. Accepts either the raw
 * error or a function that inspects it, which keeps call sites terse.
 */
export function mapErr<T, E2>(
  result: Result<T>,
  fn: (error: unknown) => E2,
): Result<T, E2> {
  return result.ok ? result : { ok: false, error: fn(result.error) };
}
