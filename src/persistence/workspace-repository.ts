import type { WorkspaceRepository } from "../application/ports/workspace-repository";
import type { WorkspaceRole } from "../domain/workspace/server-workspace";
import type { SqlClient } from "./sql-client";
import { toServerWorkspace, toWorkspaceMember, toWorkspaceRole } from "./rows";

export function createWorkspaceRepository(client: SqlClient): WorkspaceRepository {
  return {
    async listForUser(userId) {
      const result = await client.query(
        `SELECT w.*, m.role
           FROM workspaces w
           JOIN workspace_members m ON m.workspace_id = w.id
          WHERE m.user_id = $1
          ORDER BY w.created_at ASC, w.id ASC`,
        [userId],
      );
      return result.rows.map(toServerWorkspace);
    },

    async listMembers(workspaceId) {
      const result = await client.query(
        `SELECT m.workspace_id, m.user_id, m.role, m.created_at,
                u.display_name, u.email
           FROM workspace_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1
          ORDER BY CASE m.role WHEN 'ADMIN' THEN 0 WHEN 'EDITOR' THEN 1 ELSE 2 END,
                   m.created_at ASC`,
        [workspaceId],
      );
      return result.rows.map(toWorkspaceMember);
    },

    async roleOf(workspaceId, userId) {
      const result = await client.query(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, userId],
      );
      const row = result.rows[0];
      return row ? toWorkspaceRole(row.role) : null;
    },

    async setMember(workspaceId, userId, role: WorkspaceRole) {
      const result = await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING workspace_id, user_id, role, created_at`,
        [workspaceId, userId, role],
      );
      const user = await client.query(
        "SELECT display_name, email FROM users WHERE id = $1",
        [userId],
      );
      return toWorkspaceMember({ ...result.rows[0], ...user.rows[0] });
    },

    async removeMember(workspaceId, userId) {
      await client.query(
        "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, userId],
      );
    },
  };
}
