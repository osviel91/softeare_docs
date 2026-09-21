/**
 * The filesystem content store, and the server's real path boundary (ADR-040).
 *
 * A project's documents live in a directory on a persistent volume:
 *
 * ```
 * /data/projects/<project-id>/
 *   project.json        the identity record (ADR-020), written by the service
 *   diagrams/           .seq and .eventseq files
 *   docs/               .md files
 * ```
 *
 * Three defences stand between a request and `node:fs`, in this order:
 *
 * 1. **Structural** — {@link normalizeResourcePath} rejects absolute paths,
 *    traversal segments, backslashes, NULs and encoded variants *before* any
 *    filesystem call.
 * 2. **Resolved** — every path is resolved and then checked against the
 *    project's canonical root, so a symlink pointing out of the directory is
 *    refused even though its *text* was legal. The parent directory is created
 *    and re-checked before a write, which closes the "create a symlinked parent
 *    then write through it" race.
 * 3. **Permission** — a project directory is created with mode `0700`; the
 *    server is the only reader it needs.
 *
 * Nothing here logs a path a client supplied, and nothing here trusts one.
 */
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ProjectStorage,
  StoredResource,
} from "../application/project-storage";
import { resourceTypeOfName } from "../domain/workspace/resource-id";
import { err, isOk, ok, type Result } from "../shared/result/result";
import {
  InvalidResourcePathError,
  normalizeResourcePath,
  resourceFileName,
} from "./resource-path";

/** Options for a volume-backed project store. */
export interface FsProjectStorageOptions {
  /** The absolute directory this project's documents live in. */
  root: string;
}

/** Whether a path segment is hidden (and therefore not a resource). */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/** Whether a filesystem error means "this path does not exist". */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Every ancestor of a path, deepest first, ending just inside `root`. */
function ancestorsInside(root: string, target: string): string[] {
  const found: string[] = [];
  let current = path.dirname(target);
  while (current !== root && current.startsWith(root + path.sep)) {
    found.push(current);
    current = path.dirname(current);
  }
  return found;
}

/** Resolve the project root, creating it when it is missing. */
async function ensureRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}

/**
 * Resolve `relative` inside `root`, refusing anything that escapes it.
 *
 * Two checks, because either alone is insufficient. The *textual* resolution
 * catches `..`; the *canonical* resolution follows every existing component with
 * `realpath` — the final one included — so a symlink pointing out of the project
 * is refused even though its textual path was a legal project-relative one.
 * Missing components are expected on a create; the existing components above
 * them are still checked.
 */
async function resolveInsideRoot(
  root: string,
  relative: string,
): Promise<string> {
  const canonicalRoot = await ensureRoot(root);
  const target = path.resolve(canonicalRoot, relative);
  const prefix = canonicalRoot.endsWith(path.sep)
    ? canonicalRoot
    : canonicalRoot + path.sep;
  if (target !== canonicalRoot && !target.startsWith(prefix)) {
    throw new InvalidResourcePathError(relative, "the path leaves the project");
  }
  for (const directory of ancestorsInside(canonicalRoot, target)) {
    let canonical: string;
    try {
      canonical = await realpath(directory);
    } catch (error) {
      if (isAbsent(error)) continue;
      throw error;
    }
    if (canonical !== canonicalRoot && !canonical.startsWith(prefix)) {
      throw new InvalidResourcePathError(
        relative,
        "the path's directory leaves the project",
      );
    }
  }
  // The final component is checked too. A symlinked *file* whose textual path is
  // a legal project-relative one would otherwise be followed straight out of the
  // project by `readFile`, and the ancestor walk would never see it because the
  // link itself sits directly inside the root. A missing component is a create.
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(target);
  } catch (error) {
    if (isAbsent(error)) return target;
    throw error;
  }
  if (
    canonicalTarget !== canonicalRoot &&
    !canonicalTarget.startsWith(prefix)
  ) {
    throw new InvalidResourcePathError(relative, "the path leaves the project");
  }
  return target;
}

/** Recursively collect resource files under a directory, relative to a root. */
async function collectResourcePaths(
  root: string,
  directory: string,
  found: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectResourcePaths(root, absolute, found);
      continue;
    }
    // A symlink is not followed for a listing: it is not a resource this
    // project owns, and following one could walk out of the project entirely.
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    found.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
}

/** The filesystem content store for one project. */
export function createFsProjectStorage(
  options: FsProjectStorageOptions,
): ProjectStorage {
  const root = path.resolve(options.root);

  const storage: ProjectStorage = {
    root,

    async list(): Promise<Result<StoredResource[], Error>> {
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const paths: string[] = [];
        await collectResourcePaths(root, root, paths);
        paths.sort();
        const resources: StoredResource[] = [];
        for (const relative of paths) {
          const content = await readFile(path.join(root, relative), "utf8");
          resources.push({
            path: relative,
            type: resourceTypeOfName(relative),
            content,
          });
        }
        return ok(resources);
      } catch (error) {
        return err(asError(error));
      }
    },

    async read(
      relative: string,
    ): Promise<Result<StoredResource | null, Error>> {
      try {
        const normalized = normalizeResourcePath(relative);
        const absolute = await resolveInsideRoot(root, normalized);
        const content = await readFile(absolute, "utf8");
        return ok({
          path: normalized,
          type: resourceTypeOfName(normalized),
          content,
        });
      } catch (error) {
        if (isMissing(error)) return ok(null);
        return err(asError(error));
      }
    },

    async write(
      relative: string,
      content: string,
    ): Promise<Result<StoredResource, Error>> {
      try {
        const normalized = normalizeResourcePath(relative);
        const absolute = await resolveInsideRoot(root, normalized);
        const parent = path.dirname(absolute);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        // Re-check after creating directories: a `mkdir` cannot follow a link
        // that did not exist, but the check costs one syscall and removes the
        // question entirely.
        await resolveInsideRoot(root, normalized);
        await writeFileAtomically(absolute, content);
        return ok({
          path: normalized,
          type: resourceTypeOfName(normalized),
          content,
        });
      } catch (error) {
        return err(asError(error));
      }
    },

    async remove(relative: string): Promise<Result<void, Error>> {
      try {
        const normalized = normalizeResourcePath(relative);
        const absolute = await resolveInsideRoot(root, normalized);
        await rm(absolute, { force: true });
        return ok(undefined);
      } catch (error) {
        return err(asError(error));
      }
    },

    async move(move): Promise<Result<StoredResource, Error>> {
      try {
        const from = normalizeResourcePath(move.from);
        const to = normalizeResourcePath(move.to);
        if (from === to) {
          const existing = await storage.read(to);
          if (!isOk(existing)) return existing;
          if (existing.value === null) {
            return err(new Error(`Nothing is stored at ${to}.`));
          }
          return ok(existing.value);
        }
        const source = await resolveInsideRoot(root, from);
        const destination = await resolveInsideRoot(root, to);
        if (await exists(destination)) {
          return err(
            new Error(`Cannot move ${from} to ${to}: ${to} already exists.`),
          );
        }
        await mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        await rename(source, destination);
        const content = await readFile(destination, "utf8");
        return ok({
          path: to,
          type: resourceTypeOfName(to),
          content,
        });
      } catch (error) {
        return err(asError(error));
      }
    },

    async promote(move): Promise<Result<StoredResource, Error>> {
      try {
        const from = normalizeResourcePath(move.from);
        const to = normalizeResourcePath(move.to);
        const source = await resolveInsideRoot(root, from);
        const destination = await resolveInsideRoot(root, to);
        await mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        // `rename` replaces an existing destination atomically, which is exactly
        // the semantics the operation journal's completion step needs.
        await rename(source, destination);
        const content = await readFile(destination, "utf8");
        return ok({
          path: to,
          type: resourceTypeOfName(to),
          content,
        });
      } catch (error) {
        return err(asError(error));
      }
    },

    async exists(relative: string): Promise<boolean> {
      try {
        const normalized = normalizeResourcePath(relative);
        const absolute = await resolveInsideRoot(root, normalized);
        return await exists(absolute);
      } catch {
        return false;
      }
    },
  };

  return storage;
}

/** Whether a filesystem call failed because the path is absent. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Normalise an unknown thrown value into an `Error`. */
function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/** Whether a path exists, without following a final symlink. */
async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a file's contents in one step.
 *
 * A reader either sees the previous file or the new one. The temporary name
 * lives beside the target so the rename stays on one filesystem, and it is
 * removed when the write fails.
 */
async function writeFileAtomically(
  target: string,
  content: string,
): Promise<void> {
  if (await isDirectory(target)) {
    throw new Error(
      `Cannot write ${resourceFileName(target)}: it is a directory.`,
    );
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Whether a path is (or links to) a directory. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** Whether the storage root is readable and writable, for a startup check. */
export async function assertProjectVolumeUsable(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await access(root, constants.R_OK | constants.W_OK);
}
