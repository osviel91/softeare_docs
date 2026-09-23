/** Server-side workspace and membership models. */

export type WorkspaceRole = "ADMIN" | "EDITOR" | "VIEWER";

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "ADMIN" || value === "EDITOR" || value === "VIEWER";
}

export interface ServerWorkspace {
  id: string;
  ownerId: string;
  name: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  role: WorkspaceRole;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: WorkspaceRole;
  createdAt: Date;
}
