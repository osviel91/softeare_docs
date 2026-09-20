import { describe, expect, it } from "vitest";
import type { Result } from "../../../src/shared/result/result";
import { isErr, isOk } from "../../../src/shared/result/result";
import {
  createZip,
  readZip,
  type ZipEntry,
} from "../../../src/workspace/transfer/zip";

const encoder = new TextEncoder();

/** Assert a failed result and return its error for message assertions. */
function expectError(result: Result<ZipEntry[], Error>): Error {
  if (result.ok) throw new Error("expected a failed Result");
  return result.error;
}

/** Assert a successful result and return its value. */
function expectValue(result: Result<ZipEntry[], Error>): ZipEntry[] {
  if (!isOk(result)) throw result.error;
  return result.value;
}

/** A DataView over a byte array, offset-safe for subarray inputs. */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The archive's central directory offset, read from its EOCD record. */
function centralDirectoryOffset(bytes: Uint8Array): number {
  return viewOf(bytes).getUint32(bytes.length - 22 + 16, true);
}

describe("createZip", () => {
  it("starts with a local file header and ends with an EOCD record", () => {
    const bytes = createZip([
      { path: "hello.txt", data: encoder.encode("hi") },
    ]);

    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(Array.from(bytes.slice(-22, -18))).toEqual([0x50, 0x4b, 0x05, 0x06]);
    // A trailing comment would sit after the EOCD; ours must be zero-length.
    expect(viewOf(bytes).getUint16(bytes.length - 2, true)).toBe(0);
  });

  it("records the known CRC-32 of the check string in the local header", () => {
    // The standard CRC-32 check value for "123456789" is 0xcbf43926.
    const bytes = createZip([
      { path: "check.txt", data: encoder.encode("123456789") },
    ]);

    expect(viewOf(bytes).getUint32(14, true)).toBe(0xcbf43926);
    // Method 0 (STORE) and the UTF-8-name flag are set in the local header.
    expect(viewOf(bytes).getUint16(8, true)).toBe(0);
    expect(viewOf(bytes).getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it("writes exactly the EOCD record for an empty archive", () => {
    expect(Array.from(createZip([]))).toEqual([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
  });

  it("is deterministic: identical entries give byte-identical output", () => {
    const entries: ZipEntry[] = [
      { path: "docs/a.md", data: encoder.encode("alpha") },
      { path: "docs/b.bin", data: new Uint8Array([0, 1, 2, 255]) },
    ];

    expect(createZip(entries)).toEqual(createZip(entries));
  });
});

describe("readZip", () => {
  it("round-trips text, binary, empty and nested entries", () => {
    const binary = new Uint8Array(256);
    for (let value = 0; value < 256; value += 1) {
      binary[value] = value;
    }
    const entries: ZipEntry[] = [
      { path: "empty.txt", data: new Uint8Array(0) },
      { path: "binary.bin", data: binary },
      { path: "notes/readme.md", data: encoder.encode("hello\nworld\n") },
    ];

    const parsed = expectValue(readZip(createZip(entries)));

    expect(parsed.map((entry) => entry.path)).toEqual([
      "empty.txt",
      "binary.bin",
      "notes/readme.md",
    ]);
    // Compare byte contents: TextEncoder output can come from a different
    // realm than the arrays this test allocates, which defeats `toEqual`.
    expect(parsed.map((entry) => Array.from(entry.data))).toEqual([
      [],
      Array.from(binary),
      Array.from(encoder.encode("hello\nworld\n")),
    ]);
  });

  it("round-trips non-ASCII paths through the UTF-8 name flag", () => {
    const entries: ZipEntry[] = [
      { path: "docs/arquitectura-ñ.md", data: encoder.encode("diseño") },
    ];

    const parsed = expectValue(readZip(createZip(entries)));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.path).toBe("docs/arquitectura-ñ.md");
    expect(Array.from(parsed[0]?.data ?? [])).toEqual(
      Array.from(encoder.encode("diseño")),
    );
  });

  it("round-trips an empty entry list to []", () => {
    const parsed = readZip(createZip([]));

    expect(isOk(parsed)).toBe(true);
    expect(expectValue(parsed)).toEqual([]);
  });

  it("preserves entry order rather than sorting paths", () => {
    const entries: ZipEntry[] = [
      { path: "z-last.txt", data: encoder.encode("z") },
      { path: "a-first.txt", data: encoder.encode("a") },
      { path: "m-middle.txt", data: encoder.encode("m") },
    ];

    const parsed = expectValue(readZip(createZip(entries)));

    expect(parsed.map((entry) => entry.path)).toEqual([
      "z-last.txt",
      "a-first.txt",
      "m-middle.txt",
    ]);
  });

  it("returns an error for an empty buffer instead of throwing", () => {
    const result = readZip(new Uint8Array(0));

    expect(isErr(result)).toBe(true);
    expect(expectError(result).message).toMatch(/end-of-central-directory/i);
  });

  it("returns an error for arbitrary non-ZIP garbage", () => {
    const garbage = encoder.encode(
      "this is plainly not a zip archive, just a line of text",
    );

    const result = readZip(garbage);

    expect(isErr(result)).toBe(true);
    expect(expectError(result)).toBeInstanceOf(Error);
  });

  it("returns an error for a truncated archive", () => {
    const bytes = createZip([
      { path: "hello.txt", data: encoder.encode("hello there") },
    ]);

    const result = readZip(bytes.slice(0, bytes.length - 10));

    expect(isErr(result)).toBe(true);
  });

  it("returns an error when an entry's payload is truncated", () => {
    const entries: ZipEntry[] = [
      { path: "a.txt", data: encoder.encode("aaa") },
      { path: "b.txt", data: encoder.encode("bbb") },
    ];
    const bytes = createZip(entries);
    // Overstate the second entry's uncompressed size in the central directory.
    const second = viewOf(bytes);
    const central = centralDirectoryOffset(bytes);
    const secondHeader = central + 46 + "a.txt".length;
    second.setUint32(secondHeader + 24, 0xffff, true);

    const result = readZip(bytes);

    expect(isErr(result)).toBe(true);
    expect(expectError(result).message).toMatch(/b\.txt/);
  });

  it("errors on an unsupported compression method, naming the entry", () => {
    const bytes = createZip([
      { path: "docs/a.md", data: encoder.encode("stored but pretending") },
    ]);
    const view = viewOf(bytes);
    const central = centralDirectoryOffset(bytes);
    // Patch the method fields to 8 (deflate) in both headers.
    view.setUint16(8, 8, true);
    view.setUint16(central + 10, 8, true);

    const result = readZip(bytes);

    expect(isErr(result)).toBe(true);
    const message = expectError(result).message;
    expect(message).toMatch(/compression method 8/i);
    expect(message).toMatch(/docs\/a\.md/);
  });

  it("errors when a local header offset points past the archive", () => {
    const bytes = createZip([{ path: "a.txt", data: encoder.encode("aaa") }]);
    const view = viewOf(bytes);
    const central = centralDirectoryOffset(bytes);
    view.setUint32(central + 42, 0xfffffff0, true);

    const result = readZip(bytes);

    expect(isErr(result)).toBe(true);
    expect(expectError(result).message).toMatch(/local header offset/i);
  });
});
