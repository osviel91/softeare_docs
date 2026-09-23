/**
 * A minimal, framework-free view over the pieces of the File System Access API
 * that the workspace needs.
 *
 * The real File System Access API (`window.showDirectoryPicker`,
 * `FileSystemDirectoryHandle`, `FileSystemFileHandle`, …) is browser-only and
 * unavailable in jsdom. The repository therefore depends only on the tiny
 * interfaces below, which model each handle as a plain async object. That keeps
 * the whole layer testable in isolation: tests inject a fake directory tree
 * backed by Maps instead of the browser API, and the production code only ever
 * touches the real handles through {@link RealFileSystemFactory}.
 *
 * Every interface carries a `kind` discriminator so a directory handle and a
 * file handle can be told apart after enumeration — the File System Access API
 * returns both from the same `entries()` result.
 */

/** The kind of an entry returned by directory enumeration. */
export type FsEntryKind = "file" | "directory";

/** A writable stream created by {@link FsFileHandle.createWritable}. */
export interface FsWritable {
  /** Append `chunk` to the file. May be called multiple times before close. */
  write(chunk: Uint8Array): Promise<void>;
  /** Flush and release the file. Call once after all writes. */
  close(): Promise<void>;
}

/** A file handle from the File System Access API. */
export interface FsFileHandle {
  readonly kind: "file";
  /** The file's name (no path separators). */
  readonly name: string;
  /** Read the file's bytes as UTF-8 text. */
  getFile(): Promise<string>;
  /** Open the file for writing, replacing its current contents. */
  createWritable(): Promise<FsWritable>;
}

/** A directory handle from the File System Access API. */
export interface FsDirectoryHandle {
  readonly kind: "directory";
  /** The directory's name (no path separators). */
  readonly name: string;
  /** Every entry (files and subdirectories) in this directory. */
  entries(): Promise<Array<[string, FsEntryHandle]>>;
  /** Fetch a file handle by name. With `createIfNotExists`, the file is created empty if absent. */
  getFileHandle(
    name: string,
    options?: { createIfNotExists?: boolean },
  ): Promise<FsFileHandle>;
  /** Fetch a subdirectory handle by name, creating it lazily on first access. */
  getDirectoryHandle(
    name: string,
    options?: { createIfNotExists?: boolean },
  ): Promise<FsDirectoryHandle>;
  /** Remove a file or subdirectory by name (no-op when absent). */
  removeEntry(name: string): Promise<void>;
}

/** Any entry returned by directory enumeration. */
export type FsEntryHandle = FsFileHandle | FsDirectoryHandle;

/** True when `handle` is a directory handle. */
export function isDirectory(
  handle: FsEntryHandle,
): handle is FsDirectoryHandle {
  return handle.kind === "directory";
}

/**
 * Opens a directory picker and returns the folder the user chose, or `null`
 * when they cancelled. The repository never calls this directly; it goes
 * through a {@link FsDirectoryPicker} so tests can supply a canned handle.
 */
export interface FsDirectoryPicker {
  pick(): Promise<FsDirectoryHandle | null>;
}
