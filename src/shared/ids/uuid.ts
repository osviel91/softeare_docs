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
 * **Monotonic within a millisecond.** Two ids minted in the same tick still sort
 * in creation order, because the second one advances the first one's random tail
 * instead of drawing a fresh one. That is not cosmetic: `audit_events` and the
 * other tables order a listing by `(occurred_at DESC, id DESC)`, and `occurred_at`
 * is the database's clock, which collides at its own resolution. Without
 * monotonic ids the tie-break is random, so "newest first" would sometimes return
 * an older row first. It also keeps a primary-key index append-mostly, which is
 * the whole reason for UUIDv7.
 *
 * @param random - Random-byte source. Defaults to `crypto.getRandomValues`,
 *   which exists both in Node and in the browser.
 */
export function createIdGenerator(random?: RandomBytes): IdGenerator {
  const source: RandomBytes = random ?? defaultRandomBytes();
  // The state monotonicity needs: the millisecond of the last id, and the buffer
  // it was built from.
  let lastMs = -1;
  let lastBytes: Uint8Array | null = null;
  return () => {
    const now = Date.now();
    // A later millisecond draws fresh randomness. A repeat of the same
    // millisecond — or a clock that stepped backwards — advances the previous
    // tail, so the id is strictly greater than the one before it.
    if (lastBytes === null || now > lastMs) {
      lastBytes = source(16);
      lastMs = now;
    } else {
      incrementTail(lastBytes);
    }
    // `uuidv7From` reads the buffer and returns a string; it never mutates the
    // buffer, so advancing it here is what the next call sees.
    return uuidv7From(lastBytes, lastMs);
  };
}

/**
 * Advance the 80-bit random tail of a UUIDv7 buffer in place.
 *
 * Big-endian, carrying upward from the final byte. {@link uuidv7From} overwrites
 * the version and variant nibbles afterwards; a carry would have to reach the
 * high nibble of byte 6 or 8 to disturb them, which needs on the order of 2^56
 * increments inside one millisecond. The ordering the increment establishes is
 * therefore real rather than probabilistic.
 */
function incrementTail(bytes: Uint8Array): void {
  for (let index = bytes.length - 1; index >= 6; index -= 1) {
    bytes[index] = (bytes[index] + 1) & 0xff;
    if (bytes[index] !== 0) return;
  }
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
