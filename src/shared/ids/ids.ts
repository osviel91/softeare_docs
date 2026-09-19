/**
 * Identifier generation for domain entities.
 *
 * Domain objects need stable, unique ids, but production randomness makes
 * tests non-deterministic. We therefore keep the generator pluggable: the
 * default uses `crypto.randomUUID` when available and falls back to a
 * monotonic counter, while tests can supply their own factory.
 */

/** A function that produces a fresh unique id string. */
export type IdFactory = () => string;

let fallbackCounter = 0;

/**
 * Default id factory. Uses the Web Crypto API when available, otherwise
 * falls back to a module-scoped counter so ids remain unique within a run.
 */
export const defaultIdFactory: IdFactory = (() => {
  const cryptoObj =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;

  if (cryptoObj?.randomUUID) {
    return () => cryptoObj.randomUUID();
  }

  return () => `id-${++fallbackCounter}`;
})();

/** Create an id factory that prepends a stable prefix to each generated id. */
export function prefixedIdFactory(prefix: string): IdFactory {
  return () => `${prefix}-${defaultIdFactory()}`;
}

/**
 * Create a deterministic id factory for tests. Ids are `prefix-0`,
 * `prefix-1`, ... which makes assertions reproducible.
 */
export function testIdFactory(prefix = "id"): IdFactory {
  let n = 0;
  return () => `${prefix}-${n++}`;
}
