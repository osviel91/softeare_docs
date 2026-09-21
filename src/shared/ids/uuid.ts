/**
 * Identifier generation for the server model (ADR-040).
 *
 * Server entities use **UUIDv7**: time-ordered, so a primary key index stays
 * append-mostly, and UUID-shaped, so an id is safe to expose in a URL and never
 * leaks a sequence position. Node has generated them natively since v24; the
 * runtime here is newer, but the fallback keeps a test or an older host working.
 *
 * Randomness is a *parameter*, not a global, for the same reason the diagram id
 * factory takes one: a test can inject a counter and get byte-identical output,
 * which is what makes a server test reproducible.
 */

/** A source of random bytes. */
export type RandomBytes = (size: number) => Uint8Array;

/** Mint identifiers of a given kind. */
export type IdGenerator<T extends string = string> = () => T;

/** A branded identifier type: a string at runtime, distinct at compile time. */
export type Branded<T extends string, Name extends string> = T & {
  readonly __brand: Name;
};

/** The low hex digit that marks a UUID as version 7. */
const VERSION_7 = "7";

/** Format 16 random bytes as a UUIDv7 with the given millisecond timestamp. */
function uuidv7From(bytes: Uint8Array, nowMs: number): string {
  const digits = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(""); // 32 hex digits
  const time = nowMs.toString(16).padStart(12, "0").slice(-12);
  const chars = (time + digits.slice(12)).split("");
  chars[12] = VERSION_7; // version nibble
  const variant = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  chars[16] = variant; // variant nibble
  const hex = chars.join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Whether a string is shaped like a UUID (any version). */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

/**
 * A generator of UUIDv7 strings.
 *
 * @param random - Random-byte source. Defaults to `crypto.getRandomValues`,
 *   which exists both in Node and in the browser.
 */
export function createIdGenerator(random?: RandomBytes): IdGenerator {
  const source: RandomBytes = random ?? defaultRandomBytes();
  return () => uuidv7From(source(16), Date.now());
}

/** The platform's cryptographic random source. */
function defaultRandomBytes(): RandomBytes {
  return (size) => {
    const bytes = new Uint8Array(size);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  };
}

/** A deterministic generator for tests: `id-1`, `id-2`, ... */
export function createSequentialIdGenerator(prefix = "id"): IdGenerator {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${next}`;
  };
}
