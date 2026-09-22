import type {
  ServerWorkspace,
  WorkspaceMember,
  WorkspaceRole,
} from "../../domain/workspace/server-workspace";

export interface WorkspaceRepository {
  listForUser(userId: string): Promise<ServerWorkspace[]>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  roleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  setMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
}
