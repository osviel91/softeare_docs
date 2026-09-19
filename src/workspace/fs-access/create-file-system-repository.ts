/**
 * Production bridge from the File System Access API to the workspace repository
 * (Phase 5).
 *
 * The browser API lives in `window` and is unavailable under Node/jsdom, so this
 * module owns the only place that touches the real handles. It adapts them to
 * the framework-free {@link FsDirectoryHandle}/{@link FsFileHandle} interfaces
 * (see `fs-access-adapter.ts`) and exposes two entry points:
 *
 * - {@link supportsFileSystemAccess} — feature-detect whether the API exists.
 * - {@link openFileSystemRepository} — prompt the user to pick a folder and build
 *   a {@link WorkspaceRepository} over it, returning `null` when they cancel.
 *
 * Everything else in the workspace depends on the adapter interfaces, not these
 * concrete adapters, so this module stays isolated at the edge.
 */
import type { WorkspaceRepository } from "../WorkspaceRepository";
import type {
  FsDirectoryHandle,
  FsDirectoryPicker,
  FsEntryHandle,
  FsFileHandle,
  FsWritable,
} from "./fs-access-adapter";
import { createFileSystemWorkspaceRepository } from "./file-system-workspace-repository";

/** One shared decoder so repeated file reads stay cheap. */
const utf8 = new TextDecoder();

/** Adapt a native file handle to the adapter interface, decoding bytes as text. */
function toFileHandle(native: FileSystemFileHandle): FsFileHandle {
  return {
    kind: "file",
    name: native.name,
    async getFile(): Promise<string> {
      const file = await native.getFile();
      return utf8.decode(await file.arrayBuffer());
    },
    async createWritable(): Promise<FsWritable> {
      const writable = await native.createWritable();
      return {
        async write(chunk: Uint8Array): Promise<void> {
          // The native type wants `ArrayBuffer`-backed views; cast the chunk
          // (runtime accepts any typed array) to satisfy the lib's generics.
          await writable.write(chunk as unknown as FileSystemWriteChunkType);
        },
        async close(): Promise<void> {
          await writable.close();
        },
      };
    },
  };
}

/** Adapt a native directory handle to the adapter interface. */
function toDirectoryHandle(
  native: FileSystemDirectoryHandle,
): FsDirectoryHandle {
  return {
    kind: "directory",
    name: native.name,
    async entries(): Promise<Array<[string, FsEntryHandle]>> {
      const result: Array<[string, FsEntryHandle]> = [];
      for await (const entry of native.entries()) {
        const [name, handle] = entry as [string, FileSystemEntryHandle];
        result.push([
          name,
          handle.kind === "directory"
            ? toDirectoryHandle(handle as unknown as FileSystemDirectoryHandle)
            : toFileHandle(handle as unknown as FileSystemFileHandle),
        ]);
      }
      return result;
    },
    async getFileHandle(
      name: string,
      options?: { createIfNotExists?: boolean },
    ): Promise<FsFileHandle> {
      // The native lib names this option `create`; map ours onto it.
      const nativeOptions = options
        ? { create: options.createIfNotExists }
        : undefined;
      return toFileHandle(await native.getFileHandle(name, nativeOptions));
    },
    async getDirectoryHandle(name: string): Promise<FsDirectoryHandle> {
      return toDirectoryHandle(await native.getDirectoryHandle(name));
    },
    async removeEntry(name: string): Promise<void> {
      await native.removeEntry(name);
    },
  };
}

/** The only class that calls `window.showDirectoryPicker`. */
class RealFsDirectoryPicker implements FsDirectoryPicker {
  async pick(): Promise<FsDirectoryHandle | null> {
    if (
      typeof window === "undefined" ||
      typeof window.showDirectoryPicker !== "function"
    ) {
      throw new Error(
        "The File System Access API is not available in this browser",
      );
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker();
    } catch (error) {
      // A cancellation surfaces as an AbortError DOMException; treat it as "no".
      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }
      throw error;
    }
    return toDirectoryHandle(handle);
  }
}

/** True when the current browser exposes `window.showDirectoryPicker`. */
export function supportsFileSystemAccess(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function"
  );
}

/** Build the real directory picker (used by the UI's "Open folder" button). */
export function createFsDirectoryPicker(): FsDirectoryPicker {
  return new RealFsDirectoryPicker();
}

/** A folder the user opened: its repository plus the display name. */
export interface OpenedFolder {
  /** The workspace repository backed by the chosen folder. */
  repository: WorkspaceRepository;
  /** The folder's name, shown in the explorer header. */
  folderName: string;
}

/**
 * Prompt the user to choose a folder and build a repository over it.
 *
 * @param picker - The directory picker to drive. Defaults to the real one; tests
 *   inject a canned picker that resolves to a fake directory handle.
 * @returns The opened folder (repository + name), or `null` when the user cancels
 *   the picker.
 */
export async function openFileSystemRepository(
  picker: FsDirectoryPicker = createFsDirectoryPicker(),
): Promise<OpenedFolder | null> {
  const root = await picker.pick();
  if (!root) return null;
  return {
    repository: createFileSystemWorkspaceRepository(root),
    folderName: root.name,
  };
}
