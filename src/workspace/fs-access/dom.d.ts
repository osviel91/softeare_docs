/**
 * Ambient declarations for File System Access API members that the installed
 * TypeScript DOM lib (this checkout ships an older `lib.dom.d.ts`) does not yet
 * describe. Real browsers implement them, so this file only teaches the compiler
 * about the API — it adds no runtime behavior and is erased at build time.
 *
 * See https://developer.mozilla.org/docs/Web/API/File_System_Access_API.
 */

/** A file or directory entry returned by {@link FileSystemDirectoryHandle.entries}. */
type FileSystemEntryHandle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface FileSystemDirectoryHandle {
  /**
   * Iterate over every entry (files and subdirectories) in this directory, as
   * an async sequence of `[name, handle]` pairs.
   */
  entries(): AsyncIterableIterator<[string, FileSystemEntryHandle]>;
}

interface Window {
  /**
   * Show a native folder picker, resolving to the chosen directory handle.
   * Must be called from a user activation (for example a click handler).
   */
  showDirectoryPicker(
    options?: ShowDirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>;
}

/** Options accepted by {@link Window.showDirectoryPicker}. */
interface ShowDirectoryPickerOptions {
  /** A previously granted directory id to open the picker at, if known. */
  id?: string;
}
