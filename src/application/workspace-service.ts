import type { ApplicationContext } from "./context";
import { forbidden, notFound, invalid } from "./errors";
import type { WorkspaceRepository } from "./ports/workspace-repository";
import type {
  ServerWorkspace,
  WorkspaceMember,
  WorkspaceRole,
} from "../domain/workspace/server-workspace";

export interface WorkspaceService {
  listWorkspaces(context: ApplicationContext): Promise<ServerWorkspace[]>;
  listMembers(context: ApplicationContext, workspaceId: string): Promise<WorkspaceMember[]>;
  setMember(context: ApplicationContext, workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember>;
  removeMember(context: ApplicationContext, workspaceId: string, userId: string): Promise<void>;
}

export function createWorkspaceService(repository: WorkspaceRepository): WorkspaceService {
  const requireAdmin = async (context: ApplicationContext, workspaceId: string): Promise<void> => {
    const role = await repository.roleOf(workspaceId, context.principal.subjectUserId);
    if (role === null) throw notFound(`No workspace with id ${workspaceId}.`);
    if (role !== "ADMIN") throw forbidden("Workspace administrator access is required.");
  };

  return {
    listWorkspaces(context) {
      return repository.listForUser(context.principal.subjectUserId);
    },

    async listMembers(context, workspaceId) {
      const role = await repository.roleOf(workspaceId, context.principal.subjectUserId);
      if (role === null) throw notFound(`No workspace with id ${workspaceId}.`);
      return repository.listMembers(workspaceId);
    },

    async setMember(context, workspaceId, userId, role) {
      await requireAdmin(context, workspaceId);
      return repository.setMember(workspaceId, userId, role);
    },

    async removeMember(context, workspaceId, userId) {
      await requireAdmin(context, workspaceId);
      if (userId === context.principal.subjectUserId) {
        throw invalid("You cannot remove yourself from a workspace.");
      }
      const members = await repository.listMembers(workspaceId);
      const target = members.find((member) => member.userId === userId);
      if (target?.role === "ADMIN" && members.filter((member) => member.role === "ADMIN").length === 1) {
        throw invalid("A workspace must keep at least one administrator.");
      }
      await repository.removeMember(workspaceId, userId);
    },
  };
}
