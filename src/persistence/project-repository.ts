/**
 * The PostgreSQL project repository (ADR-040).
 *
 * This is the *implementation* of a port that lives in the application layer
 * (`src/application/ports/project-repository.ts`), so the dependency points from
 * persistence to application rather than the reverse. The port's types are
 * re-exported here so existing callers can keep reaching for this module.
 *
 * Projects, memberships and resource records all live here, because they share
 * one invariant: a project's authority is its membership rows, and no query that
 * returns a project for a user may ignore them. Keeping the three together is
 * what makes "list the projects I can see" a single statement rather than three
 * that a caller has to remember to join.
 *
 * Resource *content* is not here — it is on the project volume, behind
 * `ProjectStorage`. This repository owns resource identity: the id, the
 * validated path, the type, and the revision that optimistic concurrency reads
 * and writes.
 */
import { slugify } from "../domain/project/server-project";
import type { ProjectRole } from "../domain/access/permissions";
import type { SqlClient, SqlValue } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";
import {
  toProjectRole,
  toResourceType,
  toServerProject,
  integer,
  text,
} from "./rows";
import { normalizeResourcePath } from "./resource-path";
import { isOk, type Result } from "../shared/result/result";
import type {
  NewResource,
  ProjectRepository,
  ResourceRecord,
  RevisionMismatch,
} from "../application/ports/project-repository";

export type {
  NewResource,
  ProjectRepository,
  ResourceRecord,
  RevisionMismatch,
};

export interface ProjectRepositoryOptions {
  newId?: IdGenerator;
}

/** Map a `resources` row onto the domain record. */
function toResourceRecord(row: Record<string, unknown>): ResourceRecord {
  return {
    id: text(row, "id"),
    projectId: text(row, "project_id"),
    path: text(row, "path"),
    type: toResourceType(row.type),
    revision: integer(row, "revision"),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(String(row.created_at)),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at
        : new Date(String(row.updated_at)),
  };
}

/**
 * The failure result for a stale write.
 *
 * Written as a factory with an explicit type, rather than through `err()`, so
 * the failure carries the {@link RevisionMismatch} the caller needs. The generic
 * `err()` helper defaults its error type to `Error`, which would erase it.
 */
function mismatch(
  expectedRevision: number,
  currentRevision: number,
): Result<ResourceRecord, RevisionMismatch> {
  return { ok: false, error: { expectedRevision, currentRevision } };
}

/** A slug that is free for this owner, derived from the name. */
async function freeSlug(
  client: SqlClient,
  ownerId: string,
  wanted: string,
): Promise<string> {
  const base = wanted === "" ? "project" : wanted;
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const existing = await client.query(
      "SELECT 1 FROM projects WHERE owner_id = $1 AND slug = $2",
      [ownerId, candidate],
    );
    if (existing.rows.length === 0) return candidate;
  }
  // 1000 projects with the same name is not a real scenario; failing loudly is
  // better than silently reusing a slug.
  throw new Error(`Could not find a free slug for "${wanted}".`);
}

/** The repository over a `SqlClient`. */
export function createProjectRepository(
  client: SqlClient,
  options: ProjectRepositoryOptions = {},
): ProjectRepository {
  const newId = options.newId ?? createIdGenerator();

  const findResource = async (
    projectId: string,
    resourceId: string,
  ): Promise<ResourceRecord | null> => {
    const result = await client.query(
      "SELECT * FROM resources WHERE project_id = $1 AND id = $2",
      [projectId, resourceId],
    );
    const row = result.rows[0];
    return row ? toResourceRecord(row) : null;
  };

  const roleOf = async (
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> => {
    const result = await client.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
      [projectId, userId],
    );
    const row = result.rows[0];
    return row ? toProjectRole(row.role) : null;
  };

  return {
    async create(input) {
      const name = input.name.trim();
      if (name === "") throw new Error("A project name is required.");
      const slug = await freeSlug(
        client,
        input.ownerId,
        input.slug ?? slugify(name),
      );
      const id = newId();

      return client.transaction(async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO projects (id, owner_id, name, slug)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [id, input.ownerId, name, slug],
        );
        await tx.query(
          `INSERT INTO project_members (project_id, user_id, role)
           VALUES ($1, $2, $3)`,
          [id, input.ownerId, "OWNER"],
        );
        return toServerProject(inserted.rows[0]);
      });
    },

    async findById(id) {
      const result = await client.query(
        "SELECT * FROM projects WHERE id = $1",
        [id],
      );
      const row = result.rows[0];
      return row ? toServerProject(row) : null;
    },

    async findBySlug(ownerId, slug) {
      const result = await client.query(
        "SELECT * FROM projects WHERE owner_id = $1 AND slug = $2",
        [ownerId, slug],
      );
      const row = result.rows[0];
      return row ? toServerProject(row) : null;
    },

    async listForUser(userId) {
      const result = await client.query(
        `SELECT p.*, m.role,
                (SELECT count(*)::int FROM resources r WHERE r.project_id = p.id) AS resource_count
           FROM projects p
           JOIN project_members m ON m.project_id = p.id
          WHERE m.user_id = $1
          ORDER BY p.created_at DESC, p.id DESC`,
        [userId],
      );
      return result.rows.map((row) => ({
        project: toServerProject(row),
        role: toProjectRole(row.role),
        resourceCount: integer(row, "resource_count"),
      }));
    },

    async update(id, changes) {
      const assignments: string[] = [];
      const params: SqlValue[] = [id];
      if (changes.name !== undefined) {
        const name = changes.name.trim();
        if (name === "") throw new Error("A project name is required.");
        params.push(name);
        assignments.push(`name = $${params.length}`);
      }
      if (changes.slug !== undefined) {
        params.push(changes.slug);
        assignments.push(`slug = $${params.length}`);
      }
      assignments.push("updated_at = now()");
      const result = await client.query(
        `UPDATE projects SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
        params,
      );
      const row = result.rows[0];
      if (!row) throw new Error(`No project with id ${id}.`);
      return toServerProject(row);
    },

    async delete(id) {
      await client.query("DELETE FROM projects WHERE id = $1", [id]);
    },

    roleOf,

    async setMember(projectId, userId, role) {
      const result = await client.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING *`,
        [projectId, userId, role],
      );
      const row = result.rows[0];
      return {
        projectId: text(row, "project_id"),
        userId: text(row, "user_id"),
        role: toProjectRole(row.role),
        createdAt:
          row.created_at instanceof Date
            ? row.created_at
            : new Date(String(row.created_at)),
      };
    },

    async removeMember(projectId, userId) {
      await client.query(
        "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2",
        [projectId, userId],
      );
    },

    async listMembers(projectId) {
      const result = await client.query(
        `SELECT * FROM project_members
          WHERE project_id = $1
          ORDER BY CASE role WHEN 'OWNER' THEN 0 WHEN 'EDITOR' THEN 1 ELSE 2 END,
                   created_at ASC`,
        [projectId],
      );
      return result.rows.map((row) => ({
        projectId: text(row, "project_id"),
        userId: text(row, "user_id"),
        role: toProjectRole(row.role),
        createdAt:
          row.created_at instanceof Date
            ? row.created_at
            : new Date(String(row.created_at)),
      }));
    },

    async listResources(projectId) {
      const result = await client.query(
        "SELECT * FROM resources WHERE project_id = $1 ORDER BY path ASC",
        [projectId],
      );
      return result.rows.map(toResourceRecord);
    },

    findResource,

    async findResourceByPath(projectId, path) {
      const normalized = normalizeResourcePath(path);
      const result = await client.query(
        "SELECT * FROM resources WHERE project_id = $1 AND path = $2",
        [projectId, normalized],
      );
      const row = result.rows[0];
      return row ? toResourceRecord(row) : null;
    },

    async createResource(projectId, resource) {
      const path = normalizeResourcePath(resource.path);
      const result = await client.query(
        `INSERT INTO resources (id, project_id, path, type)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [resource.id ?? newId(), projectId, path, resource.type],
      );
      return toResourceRecord(result.rows[0]);
    },

    async bumpRevision(projectId, resourceId, expectedRevision) {
      const result = await client.query(
        `UPDATE resources
            SET revision = revision + 1, updated_at = now()
          WHERE project_id = $1 AND id = $2 AND revision = $3
      RETURNING *`,
        [projectId, resourceId, expectedRevision],
      );
      const row = result.rows[0];
      if (row) return { ok: true, value: toResourceRecord(row) };

      const current = await findResource(projectId, resourceId);
      return mismatch(expectedRevision, current?.revision ?? 0);
    },

    async moveResource(projectId, resourceId, newPath, expectedRevision) {
      const path = normalizeResourcePath(newPath);
      const result = await client.query(
        `UPDATE resources
            SET path = $4, revision = revision + 1, updated_at = now()
          WHERE project_id = $1 AND id = $2 AND revision = $3
      RETURNING *`,
        [projectId, resourceId, expectedRevision, path],
      );
      const row = result.rows[0];
      if (row) return { ok: true, value: toResourceRecord(row) };

      const current = await findResource(projectId, resourceId);
      return mismatch(expectedRevision, current?.revision ?? 0);
    },

    async deleteResource(projectId, resourceId) {
      await client.query(
        "DELETE FROM resources WHERE project_id = $1 AND id = $2",
        [projectId, resourceId],
      );
    },
  };
}

/** Whether a bump result is the conflict case. */
export function isRevisionMismatch(
  result: Result<ResourceRecord, RevisionMismatch>,
): result is { ok: false; error: RevisionMismatch } {
  return !isOk(result);
}
