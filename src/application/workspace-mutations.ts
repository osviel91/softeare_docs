/**
 * The single authoritative server mutation path.
 *
 * The server used to have two ways to change a resource: `ProjectCatalog`'s use
 * cases (called by the HTTP API and the remote MCP tools) and the
 * `ServerWorkspaceRepository` used by the shared documentation service. Both
 * claimed a revision and then wrote a file, and the two sequences were *almost*
 * the same — which is exactly the shape of a lost update. This module replaces
 * both with one implementation, so "update a resource" has exactly one meaning
 * for the API, for MCP and for the documentation service.
 *
 * ## The sequence
 *
 * ```
 * 1. authorize (the caller's credential AND role)
 * 2. stage the new bytes at a hidden path            (filesystem, private)
 * 3. claim: one transaction commits
 *      - the resource row change (insert / revision bump / path / delete)
 *      - a durable workspace_operations record
 *      - the business audit row
 *      - the idempotency record
 * 4. promote the staged bytes onto the resource      (atomic rename)
 * 5. finalize the operation (status completed, result stored)
 * ```
 *
 * Steps 3–5 are what close the check→write window: the revision is claimed
 * *before* any reader can observe the new content, an unfinished operation makes
 * the database refuse a second writer on the same resource, and the filesystem
 * step is a single atomic rename whose intent is already durable. A crash
 * anywhere leaves a record {@link WorkspaceMutationService.recover} can finish
 * deterministically.
 *
 * ## What a failed operation means
 *
 * A mutation that fails after the claim has already consumed a revision. That is
 * deliberate: a revision is a *claim counter*, not a content version, and
 * letting a stale writer reuse the number would reintroduce the race. The
 * document's bytes are either the old ones or the new ones, never a mixture.
 */
import type { ApplicationContext } from "./context";
import { actorIdOf, actorTypeOf, credentialIdOf } from "./context";
import { ApplicationError, conflict, invalid, notFound } from "./errors";
import type {
  ProjectRepository,
  ResourceRecord,
} from "./ports/project-repository";
import type {
  WorkspaceMutationIntent,
  WorkspaceOperationRecord,
  WorkspaceOperationRepository,
} from "./ports/workspace-operation-repository";
import type { ProjectStorage, StoredResource } from "./project-storage";
import { InvalidResourcePathError } from "./ports/resource-path";
import type { ServerProject } from "../domain/project/server-project";
import type { Permission } from "../domain/access/permissions";
import {
  createAuthorizationPolicy,
  type AuthorizationPolicy,
} from "./authorization";
import type { AuditAction } from "./ports/audit-repository";
import type { ResourceType } from "../domain/workspace/resource-id";
import type { ResourceMetadata } from "../domain/workspace/resource-metadata";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import { isOk } from "../shared/result/result";
import type { JsonValue } from "../shared/json/json-value";

/** How a resource is surfaced to a transport after a mutation. */
export interface ResourceView {
  id: string;
  projectId: string;
  path: string;
  type: ResourceType;
  revision: number;
}

/** The hidden directory staged bytes live in, relative to a project's root. */
export const STAGING_DIRECTORY = ".sdd-staging";

/** Where a project's files live. */
export type MutationStorageFactory = (projectId: string) => ProjectStorage;

/** What recovering unfinished operations did. */
export interface RecoveryReport {
  examined: number;
  completed: number;
  failed: number;
  errors: Array<{ operationId: string; message: string }>;
}

/** Options for the mutation service. */
export interface WorkspaceMutationOptions {
  projects: ProjectRepository;
  storage: MutationStorageFactory;
  operations: WorkspaceOperationRepository;
  policy?: AuthorizationPolicy<ServerProject>;
  newId?: IdGenerator;
  /**
   * Hash the bytes staged for an operation, so recovery can tell "the staged
   * file is the one this operation intended" from "a different file is here".
   * The deployment injects SHA-256; the fallback keeps the application layer
   * free of a runtime dependency and is only ever compared for equality.
   */
  hashContent?: (content: string) => string;
  /** Reported when an unfinished operation could not be driven to a conclusion. */
  onRecoveryFailure?: (
    error: unknown,
    operation: WorkspaceOperationRecord,
  ) => void;
  /**
   * Reported when the filesystem half of a mutation fails.
   *
   * A callback rather than a metrics import, because the application layer does
   * not depend on a host's observability library. The MCP host wires it to
   * `workspace_mutation_failures_total`.
   */
  onMutationFailure?: (reason: string) => void;
  /** Reported when a move's database half had to be undone. */
  onCompensation?: (reason: string) => void;
}

/** The ports a mutation runs against, shared by both adapters. */
export interface WorkspaceMutationService {
  createResource(
    context: ApplicationContext,
    projectId: string,
    input: {
      path: string;
      type: ResourceType;
      content: string;
      metadata?: ResourceMetadata;
      idempotencyKey?: string;
    },
  ): Promise<ResourceView>;

  updateResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input: {
      content: string;
      expectedRevision: number;
      metadata?: ResourceMetadata;
      idempotencyKey?: string;
    },
  ): Promise<ResourceView>;

  moveResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input: {
      path: string;
      expectedRevision: number;
      idempotencyKey?: string;
    },
  ): Promise<ResourceView>;

  deleteResource(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<void>;

  /** Drive every unfinished operation to completion, failure or compensation. */
  recover(limit?: number): Promise<RecoveryReport>;

  /** Delete journal and idempotency rows older than `before`. */
  purge(before: Date): Promise<{ operations: number; idempotency: number }>;
}

/** A small, dependency-free content digest used only for equality checks. */
function defaultHash(content: string): string {
  // 64-bit FNV-1a over UTF-16 code units, rendered as hex. Not a security hash:
  // it detects "is this the file we staged", nothing more.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= BigInt(content.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Map a resource row onto the transport view. */
function toView(record: ResourceRecord): ResourceView {
  return {
    id: record.id,
    projectId: record.projectId,
    path: record.path,
    type: record.type,
    revision: record.revision,
  };
}

/** Re-exported so a caller can name a refused write without importing errors. */
export { toView };

/** Reconstruct a view from a replayed idempotency result. */
function viewFromResult(
  result: JsonValue | null,
  fallback: { projectId: string },
): ResourceView | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const value = result as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.path !== "string") {
    return null;
  }
  return {
    id: value.id,
    projectId:
      typeof value.projectId === "string"
        ? value.projectId
        : fallback.projectId,
    path: value.path,
    type: (typeof value.type === "string"
      ? value.type
      : "sequence-diagram") as ResourceType,
    revision: typeof value.revision === "number" ? value.revision : 0,
  };
}

/** Run a path-addressed operation, reporting a refused path as `invalid`. */
async function withPath<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InvalidResourcePathError) {
      throw invalid(error.message, { kind: "invalid_path" });
    }
    throw error;
  }
}

/** Build the single authoritative mutation service. */
export function createWorkspaceMutationService(
  options: WorkspaceMutationOptions,
): WorkspaceMutationService {
  const { projects, storage, operations } = options;
  const policy =
    options.policy ?? createAuthorizationPolicy<ServerProject>(projects);
  const newId = options.newId ?? createIdGenerator();
  const hashContent = options.hashContent ?? defaultHash;

  const require = async (
    context: ApplicationContext,
    projectId: string,
    permission: Permission,
  ): Promise<void> => {
    await policy.requirePermission(context, projectId, permission);
  };

  /** The audit entry a mutation commits with its row change. */
  const auditFor = (
    context: ApplicationContext,
    action: AuditAction,
    projectId: string,
    resourceId: string | null,
  ): WorkspaceMutationIntent["audit"] => ({
    action,
    subjectUserId: context.principal.subjectUserId,
    actorType: actorTypeOf(context.principal),
    actorId: actorIdOf(context.principal),
    credentialId: credentialIdOf(context.principal),
    authType: context.principal.authType,
    projectId,
    resourceId,
    requestId: context.requestId,
    detail: {},
  });

  /** The hidden path an operation's new bytes are staged at. */
  const stagedPathFor = (operationId: string): string =>
    `${STAGING_DIRECTORY}/${operationId}`;

  /** Write the intended bytes to the staging area. */
  const stage = async (
    store: ProjectStorage,
    operationId: string,
    content: string,
  ): Promise<StoredResource> => {
    const written = await store.write(stagedPathFor(operationId), content);
    if (!isOk(written)) {
      throw invalid(
        `The document could not be staged for writing: ${written.error.message}`,
      );
    }
    return written.value;
  };

  /** Remove a staged file, ignoring the case where it is already gone. */
  const discardStaged = async (
    store: ProjectStorage,
    operationId: string,
  ): Promise<void> => {
    await store.remove(stagedPathFor(operationId)).catch(() => undefined);
  };

  /**
   * The filesystem half of an operation.
   *
   * Shared by the live path and by recovery, so "what completing this operation
   * means" is defined once. Returns `true` when the operation is now settled and
   * `false` when it is not (and recovery must try again).
   */
  const runFilesystemStep = async (
    store: ProjectStorage,
    operation: WorkspaceOperationRecord,
  ): Promise<boolean> => {
    switch (operation.operation) {
      case "create":
      case "update": {
        if (!operation.targetPath) return false;
        if (operation.stagedPath) {
          const promoted = await store.promote({
            from: operation.stagedPath,
            to: operation.targetPath,
          });
          if (isOk(promoted)) return true;
          // A missing staging file with the target already in place means the
          // promote happened before a crash; verify and accept it.
          const present = await store.read(operation.targetPath);
          if (
            isOk(present) &&
            present.value !== null &&
            operation.contentHash !== null &&
            hashContent(present.value.content) === operation.contentHash
          ) {
            return true;
          }
          return false;
        }
        return false;
      }
      case "move": {
        if (!operation.sourcePath || !operation.targetPath) return false;
        const [source, target] = await Promise.all([
          store.read(operation.sourcePath),
          store.read(operation.targetPath),
        ]);
        const sourceExists = isOk(source) && source.value !== null;
        const targetExists = isOk(target) && target.value !== null;
        if (sourceExists && !targetExists) {
          const moved = await store.move({
            from: operation.sourcePath,
            to: operation.targetPath,
          });
          return isOk(moved);
        }
        // Target in place and source gone is the completed state. Both present
        // or neither present is ambiguous, and recovery refuses to guess.
        return targetExists && !sourceExists;
      }
      case "delete": {
        if (!operation.targetPath) return true;
        const removed = await store.remove(operation.targetPath);
        return isOk(removed);
      }
    }
  };

  /**
   * Complete an operation whose filesystem step has run.
   *
   * Finalizing can itself fail (the database is momentarily unavailable). The
   * intent is already durable, so recovery will retry; the caller is told the
   * mutation could not be confirmed rather than that it did not happen.
   */
  const finalize = async (
    operation: WorkspaceOperationRecord,
    result: JsonValue | null,
  ): Promise<void> => {
    await operations.finalize(operation.id, result);
  };

  /** Undo a move's database half when the file could not be moved. */
  const compensateMove = async (
    operation: WorkspaceOperationRecord,
    reason: string,
  ): Promise<void> => {
    options.onCompensation?.(reason);
    if (operation.operation !== "move" || !operation.sourcePath) {
      await operations.settle(operation.id, "failed", reason);
      return;
    }
    try {
      await operations.restore(operation.id, reason);
    } catch {
      // The restore could not be recorded; leave the operation unfinished so
      // recovery keeps trying rather than pretending it was cleaned up.
      await operations
        .settle(operation.id, "compensating", reason)
        .catch(() => undefined);
    }
  };

  /** The live path: stage, claim, filesystem step, finalize. */
  const run = async (params: {
    context: ApplicationContext;
    projectId: string;
    operation: WorkspaceMutationIntent["operation"];
    resourceId: string;
    sourcePath?: string | null;
    targetPath: string;
    content?: string;
    resourceType?: ResourceType;
    metadata?: ResourceMetadata;
    expectedRevision: number | null;
    idempotencyKey?: string;
    auditAction: AuditAction;
    /** The success result a retry replays. */
    resultFor: (view: ResourceView) => JsonValue;
    /** Build the view returned to the caller. */
    viewFor: (
      view: ResourceView,
      operation: WorkspaceOperationRecord,
    ) => ResourceView;
  }): Promise<ResourceView> => {
    const store = storage(params.projectId);
    const operationId = newId();
    let staged: StoredResource | null = null;

    if (params.content !== undefined) {
      staged = await stage(store, operationId, params.content);
    }

    let claim;
    try {
      claim = await operations.claim({
        operationId,
        projectId: params.projectId,
        resourceId: params.resourceId,
        operation: params.operation,
        sourcePath: params.sourcePath ?? null,
        targetPath: params.targetPath,
        stagedPath: staged?.path ?? null,
        contentHash:
          params.content === undefined ? null : hashContent(params.content),
        expectedRevision: params.expectedRevision,
        ...(params.resourceType === undefined
          ? {}
          : { resourceType: params.resourceType }),
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
        audit: auditFor(
          params.context,
          params.auditAction,
          params.projectId,
          params.resourceId,
        ),
        idempotencyKey: params.idempotencyKey ?? null,
      });
    } catch (error) {
      // Nothing was committed, so the staged bytes are garbage.
      await discardStaged(store, operationId);
      throw error;
    }

    if (claim.kind === "replayed") {
      await discardStaged(store, operationId);
      const replayed = viewFromResult(claim.result, {
        projectId: params.projectId,
      });
      if (replayed === null) {
        throw new ApplicationError(
          "internal",
          "The stored result of this idempotent operation could not be read.",
        );
      }
      return replayed;
    }

    const operation = claim.operation;
    const completed = await runFilesystemStep(store, operation);
    if (!completed) {
      // The database is already committed; only the filesystem half failed. For
      // a content operation the staged bytes are now garbage and must not be
      // left on the volume — the journal's intent is the only record of them.
      if (
        operation.operation === "create" ||
        operation.operation === "update"
      ) {
        await discardStaged(store, operation.id);
      }
      await compensateMove(operation, "The filesystem step did not complete.");
      throw new ApplicationError(
        "unavailable",
        "The document could not be written; the operation was rolled back. Retry.",
      );
    }

    const view: ResourceView = {
      id: params.resourceId,
      projectId: params.projectId,
      path: params.targetPath,
      type:
        params.resourceType ??
        (await typeOf(params.projectId, params.resourceId)),
      revision: operation.resultingRevision ?? params.expectedRevision ?? 1,
    };
    await finalize(operation, params.resultFor(view));
    return params.viewFor(view, operation);
  };

  /** The type of an existing resource, for a view after an update or move. */
  const typeOf = async (
    projectId: string,
    resourceId: string,
  ): Promise<ResourceType> => {
    const record = await projects.findResource(projectId, resourceId);
    return record?.type ?? "sequence-diagram";
  };

  /**
   * Reconstruct the result a retry should replay, after recovery finished an
   * operation whose original caller never saw an answer.
   */
  const replayResultFor = async (
    operation: WorkspaceOperationRecord,
  ): Promise<JsonValue | null> => {
    if (operation.resourceId === null) return null;
    if (operation.operation === "delete") {
      return { deleted: true, resourceId: operation.resourceId } as JsonValue;
    }
    const record = await projects.findResource(
      operation.projectId,
      operation.resourceId,
    );
    return record === null ? null : (toView(record) as unknown as JsonValue);
  };

  return {
    async createResource(context, projectId, input) {
      await require(context, projectId, "resource:create");
      // With an idempotency key the journal decides: a replay must reach the
      // stored result rather than being refused by an up-front "path is taken"
      // check, which is exactly the retry the key exists to make safe.
      if (input.idempotencyKey === undefined) {
        const existing = await withPath(() =>
          projects.findResourceByPath(projectId, input.path),
        );
        if (existing) {
          throw conflict(
            `A resource already exists at "${existing.path}" (id: ${existing.id}).`,
            { reason: "path_taken" },
          );
        }
      }
      const resourceId = newId();
      return run({
        context,
        projectId,
        operation: "create",
        resourceId,
        targetPath: input.path,
        content: input.content,
        resourceType: input.type,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        expectedRevision: null,
        auditAction: "resource.created",
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
        resultFor: (view) => view as unknown as JsonValue,
        viewFor: (view) => view,
      });
    },

    async updateResource(context, projectId, resourceId, input) {
      await require(context, projectId, "resource:update");
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      return run({
        context,
        projectId,
        operation: "update",
        resourceId,
        sourcePath: record.path,
        targetPath: record.path,
        content: input.content,
        resourceType: record.type,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        expectedRevision: input.expectedRevision,
        auditAction: "resource.updated",
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
        resultFor: (view) => view as unknown as JsonValue,
        viewFor: (view) => view,
      });
    },

    async moveResource(context, projectId, resourceId, input) {
      await require(context, projectId, "resource:move");
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      // A stale caller is refused before anything is staged or claimed; the
      // journal's conditional update is still the authority for the race.
      if (record.revision !== input.expectedRevision) {
        throw conflict(
          `Resource ${resourceId} changed since it was read: expected revision ${input.expectedRevision}, current revision ${record.revision}. Re-read it and retry.`,
          {
            expectedRevision: input.expectedRevision,
            currentRevision: record.revision,
          },
        );
      }
      const occupant = await withPath(() =>
        projects.findResourceByPath(projectId, input.path),
      );
      if (occupant && occupant.id !== resourceId) {
        throw conflict(
          `A resource already exists at "${occupant.path}" (id: ${occupant.id}).`,
          { reason: "path_taken" },
        );
      }
      return run({
        context,
        projectId,
        operation: "move",
        resourceId,
        sourcePath: record.path,
        targetPath: input.path,
        content: undefined,
        resourceType: record.type,
        expectedRevision: input.expectedRevision,
        auditAction: "resource.moved",
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
        resultFor: (view) => view as unknown as JsonValue,
        viewFor: (view) => view,
      });
    },

    async deleteResource(context, projectId, resourceId, input = {}) {
      await require(context, projectId, "resource:delete");
      const record = await projects.findResource(projectId, resourceId);
      if (!record) throw notFound(`No resource with id ${resourceId}.`);
      const store = storage(projectId);
      const operationId = newId();
      const claim = await operations.claim({
        operationId,
        projectId,
        resourceId,
        operation: "delete",
        sourcePath: record.path,
        targetPath: record.path,
        stagedPath: null,
        contentHash: null,
        expectedRevision: input.expectedRevision ?? null,
        audit: auditFor(context, "resource.deleted", projectId, resourceId),
        idempotencyKey: input.idempotencyKey ?? null,
      });
      if (claim.kind === "replayed") return;
      const operation = claim.operation;
      const completed = await runFilesystemStep(store, operation);
      if (!completed) {
        // The row is gone; there is nothing to restore, but the file may still
        // exist. Leaving the operation unfinished makes recovery remove it.
        await operations
          .settle(
            operation.id,
            "compensating",
            "The file could not be removed.",
          )
          .catch(() => undefined);
        throw new ApplicationError(
          "unavailable",
          "The resource was deleted but its file could not be removed. The server will retry.",
        );
      }
      await finalize(operation, { deleted: true, resourceId } as JsonValue);
    },

    async recover(limit = 100) {
      const report: RecoveryReport = {
        examined: 0,
        completed: 0,
        failed: 0,
        errors: [],
      };
      const unfinished = await operations.unfinished(limit);
      for (const listed of unfinished) {
        report.examined += 1;
        try {
          await operations.markProcessing(listed.id);
          const operation = (await operations.find(listed.id)) ?? listed;
          const store = storage(operation.projectId);
          const done = await runFilesystemStep(store, operation);
          if (done) {
            await finalize(operation, await replayResultFor(operation));
            report.completed += 1;
          } else {
            await operations.settle(
              operation.id,
              "failed",
              "Recovery could not determine a consistent state for this operation.",
            );
            options.onMutationFailure?.("recovery_inconsistent");
            report.failed += 1;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          report.errors.push({ operationId: listed.id, message });
          (options.onRecoveryFailure ?? (() => {}))(error, listed);
        }
      }
      return report;
    },

    async purge(before) {
      const operationsPurged = await operations.purgeCompleted(before);
      const idempotencyPurged = await operations.purgeIdempotency(before);
      return { operations: operationsPurged, idempotency: idempotencyPurged };
    },
  };
}
