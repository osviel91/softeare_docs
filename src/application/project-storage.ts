/**
 * The server's content store: one project's documents on a volume (ADR-040).
 *
 * This port is deliberately *path-addressed and dumb*. It knows how to read,
 * write, move and delete a file at a validated project-relative path, and
 * nothing about diagrams, projects or permissions. Everything above it —
 * revisions, authorization, indexing, validation — is application behaviour, so
 * replacing this volume with object storage later changes one adapter and no use
 * case.
 *
 * Two properties every implementation must uphold, because the layers above
 * assume them:
 *
 * 1. **Paths are validated by the implementation.** The caller passes a
 *    project-relative path; the implementation normalises it (see
 *    `normalizeResourcePath`) and refuses anything that would leave the project
 *    directory. A caller cannot opt out of the check.
 * 2. **Writes are atomic.** A reader sees the old bytes or the new bytes, never
 *    a half-written file, which is what makes an in-flight render safe.
 */
import type { ResourceType } from "../domain/workspace/resource-id";
import type { Result } from "../shared/result/result";

/** One stored document: its path, bytes, and which kind it is. */
export interface StoredResource {
  /** The validated project-relative path, `/`-separated. */
  path: string;
  type: ResourceType;
  /** The document's text (`.seq`, `.eventseq` or `.md`). */
  content: string;
}

/** Where a stored resource lives, and what should happen to it. */
export interface ResourceMove {
  /** The current, validated project-relative path. */
  from: string;
  /** The wanted, validated project-relative path. */
  to: string;
}

/** The content store for one project's storage directory. */
export interface ProjectStorage {
  /**
   * Every document under the project directory, in a stable (path-sorted)
   * order. Hidden paths — a leading dot on any segment — are not resources.
   */
  list(): Promise<Result<StoredResource[], Error>>;

  /** Read one document, or `null` when it does not exist. */
  read(path: string): Promise<Result<StoredResource | null, Error>>;

  /**
   * Create or replace a document, creating parent directories as needed.
   *
   * The stored type is derived from the path's extension, exactly as {@link list}
   * and {@link read} derive it, so there is one rule for what a file *is* rather
   * than a caller-supplied value that could disagree with the name.
   */
  write(path: string, content: string): Promise<Result<StoredResource, Error>>;

  /** Remove a document. Removing one that is already gone succeeds. */
  remove(path: string): Promise<Result<void, Error>>;

  /**
   * Move a document, keeping its bytes.
   *
   * Implementations refuse to overwrite an existing destination, because a move
   * that silently destroys a sibling is a data-loss bug, not a convenience.
   */
  move(move: ResourceMove): Promise<Result<StoredResource, Error>>;

  /**
   * Atomically move `from` onto `to`, replacing whatever is at `to`.
   *
   * This is the completion step of the workspace operation journal:
   * the new bytes are written to a hidden staging path first and committed to
   * the resource's real path only after the database has durably recorded the
   * intent. Unlike {@link move}, it is *meant* to overwrite — the target is the
   * document being updated — and the replacement is atomic, so a reader sees the
   * old bytes or the new ones and never a half-written file.
   */
  promote(move: ResourceMove): Promise<Result<StoredResource, Error>>;

  /** Whether a document exists at this path. */
  exists(path: string): Promise<boolean>;

  /** The absolute directory this store is rooted at, for diagnostics only. */
  readonly root: string;
}
