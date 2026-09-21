/**
 * Server identifier generation (ADR-040).
 *
 * The property that matters is not "is it a UUID" but "do two ids minted in the
 * same millisecond sort in creation order". Listings order by
 * `(occurred_at DESC, id DESC)`, and the database clock collides at its own
 * resolution, so a random tie-break would make "newest first" occasionally return
 * an older row — which is exactly the flake this monotonicity removes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdGenerator,
  createSequentialIdGenerator,
  isUuid,
} from "../../../src/shared/ids/uuid";

/** A deterministic random source, so a test never depends on entropy. */
function fixedBytes(value: number) {
  return (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    bytes.fill(value & 0xff);
    return bytes;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createIdGenerator", () => {
  it("mints version-7 UUIDs", () => {
    const newId = createIdGenerator();
    const id = newId();
    expect(isUuid(id)).toBe(true);
    // The version nibble is the first character of the third group.
    expect(id[14]).toBe("7");
    expect(newId()).not.toBe(id);
  });

  it("keeps ids strictly increasing when the clock does not move", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const newId = createIdGenerator(fixedBytes(0x00));

    const ids = Array.from({ length: 500 }, () => newId());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps ids increasing across milliseconds", () => {
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const newId = createIdGenerator(fixedBytes(0xff));

    const first = newId();
    clock += 1;
    const second = newId();
    expect(second > first).toBe(true);
  });

  it("stays increasing when the clock steps backwards", () => {
    // A backwards clock must not produce an id that sorts before an older one:
    // the id is an ordering token, not a clock reading.
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const newId = createIdGenerator(fixedBytes(0x00));

    const first = newId();
    clock -= 5_000;
    const second = newId();
    expect(second > first).toBe(true);
  });
});

describe("createSequentialIdGenerator", () => {
  it("is deterministic, for tests that need reproducible bytes", () => {
    const newId = createSequentialIdGenerator("user");
    expect([newId(), newId(), newId()]).toEqual(["user-1", "user-2", "user-3"]);
  });
});
