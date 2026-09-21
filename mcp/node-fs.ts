/**
 * A Node filesystem implementation of the workspace's {@link FsDirectoryHandle}
 * contract.
 *
 * The browser repository was written against a tiny handle interface precisely
 * so a second backend could be dropped underneath it, and this is that backend:
 * `createFileSystemWorkspaceRepository(createNodeDirectoryHandle(root))` yields
 * the same `WorkspaceRepository` the app uses, with no browser API. The MCP
 * server therefore creates and edits real projects through the *same* domain
 * code paths the UI does, instead of growing a parallel filesystem layer.
 *
 * Two details make this a faithful stand-in for the File System Access API:
 *
 * - `getDirectoryHandle` **creates** a missing directory. That is the contract
 *   the repository relies on (`createProject` and saving into a fresh project
 *   both resolve parents without passing `createIfNotExists`), and it is what
 *   the in-memory test double does.
 * - `getFileHandle` creates a file only when asked, and throws otherwise, so
 *   "does this exist?" stays answerable by catching.
 *
 * Because an agent can name anything, every entry name is validated here: a
 * handle addresses a *single* entry, never a path, so `..`, separators, and NUL
 * are rejected before they reach `path.join`. That check is the server's
 * directory-traversal boundary.
 */
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  FsDirectoryHandle,
  FsEntryHandle,
  FsFileHandle,
  FsWritable,
} from "../src/workspace/fs-access/fs-access-adapter";

/** A file name a handle may address: one segment, never a path. */
const ENTRY_NAME = /^[^/\\\0]+$/;

/** Reject a name that would address something other than a direct child. */
function assertEntryName(name: string): void {
  if (name === "" || name === "." || name === ".." || !ENTRY_NAME.test(name)) {
    throw new Error(
      `invalid entry name ${JSON.stringify(name)}: a handle addresses one file or directory name, not a path`,
    );
  }
}

/** `stat` that answers `null` instead of throwing when the path is absent. */
async function statOrNull(target: string) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

/** A writable that buffers chunks and replaces the file's contents on close. */
function createNodeWritable(absPath: string): FsWritable {
  const chunks: Uint8Array[] = [];
  let closed = false;
  return {
    async write(chunk: Uint8Array): Promise<void> {
      if (closed) throw new Error("cannot write: the file is already closed");
      chunks.push(chunk);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      await writeFile(absPath, merged);
    },
  };
}

/** Adapt an absolute path to the framework-free file-handle interface. */
function nodeFileHandle(absPath: string, name: string): FsFileHandle {
  return {
    kind: "file",
    name,
    async getFile(): Promise<string> {
      return readFile(absPath, "utf8");
    },
    async createWritable(): Promise<FsWritable> {
      return createNodeWritable(absPath);
    },
  };
}

/** Adapt an absolute path to the framework-free directory-handle interface. */
function nodeDirectoryHandle(absPath: string, name: string): FsDirectoryHandle {
  return {
    kind: "directory",
    name,

    async entries(): Promise<Array<[string, FsEntryHandle]>> {
      const entries = await readdir(absPath, { withFileTypes: true });
      return entries.map((entry): [string, FsEntryHandle] => {
        const child = path.join(absPath, entry.name);
        return [
          entry.name,
          entry.isDirectory()
            ? nodeDirectoryHandle(child, entry.name)
            : nodeFileHandle(child, entry.name),
        ];
      });
    },

    async getFileHandle(
      file: string,
      options?: { createIfNotExists?: boolean },
    ): Promise<FsFileHandle> {
      assertEntryName(file);
      const target = path.join(absPath, file);
      const info = await statOrNull(target);
      if (info?.isDirectory()) {
        throw new Error(`"${file}" is a directory, not a file`);
      }
      if (!info) {
        if (!options?.createIfNotExists) {
          throw new Error(`no such file: ${file}`);
        }
        await writeFile(target, "");
      }
      return nodeFileHandle(target, file);
    },

    async getDirectoryHandle(
      directory: string,
      options?: { createIfNotExists?: boolean },
    ): Promise<FsDirectoryHandle> {
      assertEntryName(directory);
      const target = path.join(absPath, directory);
      const info = await statOrNull(target);
      if (info && !info.isDirectory()) {
        throw new Error(`"${directory}" is a file, not a directory`);
      }
      // A missing directory is created unless the caller explicitly said not
      // to, matching the contract the repository is written against.
      if (!info && options?.createIfNotExists !== false) {
        await mkdir(target, { recursive: true });
      }
      if (!info && options?.createIfNotExists === false) {
        throw new Error(`no such directory: ${directory}`);
      }
      return nodeDirectoryHandle(target, directory);
    },

    async removeEntry(entry: string): Promise<void> {
      assertEntryName(entry);
      await rm(path.join(absPath, entry), { recursive: true, force: true });
    },
  };
}

/**
 * Open a directory on the local filesystem as an {@link FsDirectoryHandle}.
 *
 * @param root - The workspace directory. It must already exist; creating it
 *   silently would turn a typo in `--workspace` into an empty workspace.
 */
export function createNodeDirectoryHandle(root: string): FsDirectoryHandle {
  const resolved = path.resolve(root);
  return nodeDirectoryHandle(resolved, path.basename(resolved));
}

/** The absolute path a name would resolve to, rejecting anything outside `root`. */
export function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const prefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep;
  if (target !== resolvedRoot && !target.startsWith(prefix)) {
    throw new Error(
      `path ${JSON.stringify(relativePath)} escapes the workspace root`,
    );
  }
  return target;
}

/** Read a UTF-8 text file, or `null` when it does not exist. */
export async function readTextFileOrNull(
  absPath: string,
): Promise<string | null> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

/** Write a UTF-8 text file, creating its parent directories as needed. */
export async function writeTextFile(
  absPath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, content, "utf8");
}
