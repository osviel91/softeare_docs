/**
 * A small, dependency-free ZIP writer/reader for uncompressed (STORE) entries.
 *
 * The transfer layer needs to hand a handful of files to the user as a single
 * archive and to read them back. Owning a minimal implementation keeps the
 * dependency surface at zero (no JSZip, no pako) and keeps the byte layout
 * under our control, which is what makes deterministic output possible.
 */

import { err, ok, type Result } from "../../shared/result/result";

/** One file inside a ZIP archive. Paths use `/` separators and are relative. */
export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const STORE_METHOD = 0;
const VERSION_NEEDED_TO_EXTRACT = 20;
const VERSION_MADE_BY = 20;
/** General-purpose bit 11: file names are UTF-8 encoded. */
const UTF8_FILENAME_FLAG = 0x0800;

/*
 * Determinism is deliberate: every entry carries the same fixed 1980-01-01
 * timestamp and the entries are written in the caller's order, so the same
 * entries always produce byte-identical output (diffable fixtures, stable
 * hashes, cheap equality checks).
 */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
/** EOCD record plus the largest trailing comment the format allows. */
const MAX_EOCD_SEARCH = END_OF_CENTRAL_DIRECTORY_SIZE + MAX_UINT16;

let crcTableCache: Uint32Array | null = null;

/** Build the CRC-32 (IEEE 0xEDB88320) lookup table on first use. */
function crcTable(): Uint32Array {
  if (crcTableCache === null) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let bit = 0; bit < 8; bit += 1) {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    crcTableCache = table;
  }
  return crcTableCache;
}

/** CRC-32 of a byte sequence, returned as an unsigned 32-bit integer. */
function crc32(data: Uint8Array): number {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ data[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface PreparedEntry {
  readonly nameBytes: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly offset: number;
}

/**
 * Build an uncompressed (STORE) ZIP archive from entries, in the given order.
 * Deterministic: the same entries always produce byte-identical output.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_UINT16) {
    throw new Error(
      `cannot write ${entries.length} entries: ZIP64 is required beyond ${MAX_UINT16} entries`,
    );
  }

  const encoder = new TextEncoder();
  const prepared: PreparedEntry[] = [];
  let localSize = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    if (nameBytes.length > MAX_UINT16) {
      throw new Error(
        `cannot write entry "${entry.path}": the file name is too long for a ZIP header`,
      );
    }
    if (entry.data.length > MAX_UINT32) {
      throw new Error(
        `cannot write entry "${entry.path}": ZIP64 is required for entries larger than 0xFFFFFFFF bytes`,
      );
    }
    if (localSize > MAX_UINT32) {
      throw new Error(
        `cannot write entry "${entry.path}": ZIP64 is required (local header offset exceeds 0xFFFFFFFF)`,
      );
    }
    prepared.push({
      nameBytes,
      data: entry.data,
      crc: crc32(entry.data),
      offset: localSize,
    });
    localSize += LOCAL_FILE_HEADER_SIZE + nameBytes.length + entry.data.length;
    centralSize += CENTRAL_DIRECTORY_HEADER_SIZE + nameBytes.length;
  }

  if (localSize > MAX_UINT32 || centralSize > MAX_UINT32) {
    throw new Error(
      "cannot write archive: ZIP64 is required (directory size exceeds 0xFFFFFFFF bytes)",
    );
  }
  const total = localSize + centralSize + END_OF_CENTRAL_DIRECTORY_SIZE;
  if (total > MAX_UINT32) {
    throw new Error(
      "cannot write archive: ZIP64 is required (archive exceeds 0xFFFFFFFF bytes)",
    );
  }

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  let cursor = 0;
  for (const entry of prepared) {
    writeLocalFileHeader(view, cursor, entry);
    bytes.set(entry.nameBytes, cursor + LOCAL_FILE_HEADER_SIZE);
    cursor += LOCAL_FILE_HEADER_SIZE + entry.nameBytes.length;
    bytes.set(entry.data, cursor);
    cursor += entry.data.length;
  }

  const centralOffset = cursor;
  for (const entry of prepared) {
    cursor = writeCentralDirectoryHeader(view, cursor, entry);
    bytes.set(entry.nameBytes, cursor);
    cursor += entry.nameBytes.length;
  }

  writeEndOfCentralDirectory(
    view,
    cursor,
    prepared.length,
    centralSize,
    centralOffset,
  );
  return bytes;
}

function writeLocalFileHeader(
  view: DataView,
  offset: number,
  entry: PreparedEntry,
): void {
  view.setUint32(offset, LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(offset + 4, VERSION_NEEDED_TO_EXTRACT, true);
  view.setUint16(offset + 6, UTF8_FILENAME_FLAG, true);
  view.setUint16(offset + 8, STORE_METHOD, true);
  view.setUint16(offset + 10, DOS_TIME, true);
  view.setUint16(offset + 12, DOS_DATE, true);
  view.setUint32(offset + 14, entry.crc, true);
  view.setUint32(offset + 18, entry.data.length, true);
  view.setUint32(offset + 22, entry.data.length, true);
  view.setUint16(offset + 26, entry.nameBytes.length, true);
  view.setUint16(offset + 28, 0, true); // extra field length
}

/** Write one central-directory header, returning the offset just past it. */
function writeCentralDirectoryHeader(
  view: DataView,
  offset: number,
  entry: PreparedEntry,
): number {
  view.setUint32(offset, CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(offset + 4, VERSION_MADE_BY, true);
  view.setUint16(offset + 6, VERSION_NEEDED_TO_EXTRACT, true);
  view.setUint16(offset + 8, UTF8_FILENAME_FLAG, true);
  view.setUint16(offset + 10, STORE_METHOD, true);
  view.setUint16(offset + 12, DOS_TIME, true);
  view.setUint16(offset + 14, DOS_DATE, true);
  view.setUint32(offset + 16, entry.crc, true);
  view.setUint32(offset + 20, entry.data.length, true);
  view.setUint32(offset + 24, entry.data.length, true);
  view.setUint16(offset + 28, entry.nameBytes.length, true);
  view.setUint16(offset + 30, 0, true); // extra field length
  view.setUint16(offset + 32, 0, true); // file comment length
  view.setUint16(offset + 34, 0, true); // disk number start
  view.setUint16(offset + 36, 0, true); // internal file attributes
  view.setUint32(offset + 38, 0, true); // external file attributes
  view.setUint32(offset + 42, entry.offset, true);
  return offset + CENTRAL_DIRECTORY_HEADER_SIZE;
}

function writeEndOfCentralDirectory(
  view: DataView,
  offset: number,
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): void {
  view.setUint32(offset, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(offset + 4, 0, true); // number of this disk
  view.setUint16(offset + 6, 0, true); // disk with the central directory
  view.setUint16(offset + 8, entryCount, true); // entries on this disk
  view.setUint16(offset + 10, entryCount, true); // total entries
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true); // archive comment length
}

/**
 * Parse a ZIP archive written by createZip (STORE entries only). Returns a
 * descriptive error for a malformed archive or an entry compressed with an
 * unsupported method.
 */
export function readZip(bytes: Uint8Array): Result<ZipEntry[], Error> {
  const eocdOffset = locateEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    return err(
      new Error(
        "not a ZIP archive: no end-of-central-directory record was found",
      ),
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (!hasRange(bytes.length, centralOffset, centralSize)) {
    return err(
      new Error(
        `malformed ZIP: central directory at ${centralOffset} (+${centralSize} bytes) lies outside the archive`,
      ),
    );
  }

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (!hasRange(bytes.length, cursor, CENTRAL_DIRECTORY_HEADER_SIZE)) {
      return err(
        new Error(
          `truncated ZIP: central directory entry ${index} is incomplete`,
        ),
      );
    }
    if (view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      return err(
        new Error(
          `malformed ZIP: bad central directory signature at entry ${index}`,
        ),
      );
    }

    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const variableLength = nameLength + extraLength + commentLength;
    if (
      !hasRange(
        bytes.length,
        cursor + CENTRAL_DIRECTORY_HEADER_SIZE,
        variableLength,
      )
    ) {
      return err(
        new Error(
          `truncated ZIP: central directory entry ${index} has out-of-range name or extra fields`,
        ),
      );
    }

    const nameStart = cursor + CENTRAL_DIRECTORY_HEADER_SIZE;
    const path = decoder.decode(
      bytes.subarray(nameStart, nameStart + nameLength),
    );
    cursor = nameStart + variableLength;

    if (method !== STORE_METHOD) {
      return err(
        new Error(
          `unsupported compression method ${method} for entry "${path}": only STORE (0) is supported`,
        ),
      );
    }
    if (compressedSize !== uncompressedSize) {
      return err(
        new Error(
          `malformed ZIP: STORE entry "${path}" has compressed size ${compressedSize} but uncompressed size ${uncompressedSize}`,
        ),
      );
    }

    const stored = readStoredEntry(
      bytes,
      view,
      localOffset,
      uncompressedSize,
      path,
    );
    if (!stored.ok) {
      return stored;
    }
    entries.push({ path, data: stored.value });
  }

  return ok(entries);
}

/** Read one STORE entry's payload, skipping the local header's own fields. */
function readStoredEntry(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  size: number,
  path: string,
): Result<Uint8Array, Error> {
  if (!hasRange(bytes.length, localOffset, LOCAL_FILE_HEADER_SIZE)) {
    return err(
      new Error(
        `malformed ZIP: local header offset ${localOffset} for entry "${path}" is beyond the archive`,
      ),
    );
  }
  if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    return err(
      new Error(
        `malformed ZIP: bad local file header signature for entry "${path}"`,
      ),
    );
  }

  // The local header repeats the name and extra lengths; they are the ones
  // that describe this file's payload, so they win over the central directory.
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart =
    localOffset + LOCAL_FILE_HEADER_SIZE + localNameLength + localExtraLength;
  if (!hasRange(bytes.length, dataStart, size)) {
    return err(
      new Error(
        `truncated ZIP: entry "${path}" declares ${size} bytes past the end of the archive`,
      ),
    );
  }
  return ok(bytes.slice(dataStart, dataStart + size));
}

/**
 * Find the end-of-central-directory record by scanning backwards. The record
 * sits within the last 64 KiB + 22 bytes even when the archive has a comment.
 */
function locateEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.length < END_OF_CENTRAL_DIRECTORY_SIZE) {
    return -1;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (
    let offset = bytes.length - END_OF_CENTRAL_DIRECTORY_SIZE;
    offset >= lowest;
    offset -= 1
  ) {
    if (
      view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      offset +
        END_OF_CENTRAL_DIRECTORY_SIZE +
        view.getUint16(offset + 20, true) ===
        bytes.length
    ) {
      return offset;
    }
  }
  return -1;
}

/** Whether `[start, start + length)` lies inside a buffer of `byteLength`. */
function hasRange(byteLength: number, start: number, length: number): boolean {
  if (start < 0 || length < 0) {
    return false;
  }
  return start + length <= byteLength;
}
