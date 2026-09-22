/**
 * Row mapping for the server tables (ADR-040).
 *
 * Repositories keep SQL's `snake_case` inside these functions and return the
 * domain's `camelCase` outside them, so no `snake_case` property escapes into
 * the application layer. `timestamptz` columns arrive as `Date` from both
 * drivers, and a `text[]` column arrives as a string array; anything else is
 * normalised here rather than defended against at every call site.
 */
import type { ServerProject } from "../domain/project/server-project";
import type { User } from "../domain/user/user";
import type { ProjectRole } from "../domain/access/permissions";
import type { ResourceType } from "../domain/workspace/resource-id";
import type { SqlRow } from "./sql-client";
import { isProjectRole } from "../domain/access/permissions";

/** Read a required string column. */
function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Expected a text value in column "${column}".`);
  }
  return value;
}

/** Read a nullable string column. */
function textOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

/** Read a `timestamptz` column as a `Date`. */
function timestamp(row: SqlRow, column: string): Date {
  const value = row[column];
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  throw new Error(`Expected a timestamp in column "${column}".`);
}

/** Read a nullable `timestamptz` column. */
function timestampOrNull(row: SqlRow, column: string): Date | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return null;
}

/** Read an integer column. */
function integer(row: SqlRow, column: string): number {
  const value = row[column];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number in column "${column}".`);
  }
  return parsed;
}

/** Map a `users` row onto the domain record. */
export function toUser(row: SqlRow): User {
  return {
    id: text(row, "id"),
    identityIssuer: text(row, "identity_issuer"),
    identitySubject: text(row, "identity_subject"),
    displayName: text(row, "display_name"),
    email: textOrNull(row, "email"),
    status: text(row, "status") as User["status"],
    platformAdmin: row.platform_admin === true || row.platform_admin === "true",
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

/** Map a `projects` row onto the domain record. */
export function toServerProject(row: SqlRow): ServerProject {
  return {
    id: text(row, "id"),
    ownerId: text(row, "owner_id"),
    name: text(row, "name"),
    slug: text(row, "slug"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

/** Map a `project_members.role` column, refusing a value the code cannot mean. */
export function toProjectRole(value: unknown): ProjectRole {
  if (!isProjectRole(value)) {
    throw new Error(`Unknown project role in the database: ${String(value)}`);
  }
  return value;
}

/** Map a `resources.type` column. */
export function toResourceType(value: unknown): ResourceType {
  if (
    value === "sequence-diagram" ||
    value === "event-flow" ||
    value === "markdown-document"
  ) {
    return value;
  }
  throw new Error(`Unknown resource type in the database: ${String(value)}`);
}

/** Read a `text[]` column. */
export function textArray(row: SqlRow, column: string): string[] {
  const value = row[column];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string" && value !== "") {
    return value.replace(/^\{|\}$/g, "").split(",");
  }
  return [];
}

/** Read a nullable `uuid[]` column. */
export function uuidArrayOrNull(row: SqlRow, column: string): string[] | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return textArray(row, column);
}

/** Read a `jsonb` column as a plain object. */
export function jsonObject(
  row: SqlRow,
  column: string,
): Record<string, unknown> {
  const value = row[column];
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return {};
}

export { integer, text, textOrNull, timestamp, timestampOrNull };
