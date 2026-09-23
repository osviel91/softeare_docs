import type { ApplicationContext } from "./context";
import { forbidden, notFound, invalid } from "./errors";
import type { WorkspaceRepository } from "./ports/workspace-repository";
import type {
  ServerWorkspace,
  WorkspaceMember,
  WorkspaceRole,
} from "../domain/workspace/server-workspace";

export interface WorkspaceService {
  createWorkspace(
    context: ApplicationContext,
    name: string,
  ): Promise<ServerWorkspace>;
  renameWorkspace(
    context: ApplicationContext,
    workspaceId: string,
    name: string,
  ): Promise<ServerWorkspace>;
  deleteWorkspace(
    context: ApplicationContext,
    workspaceId: string,
  ): Promise<void>;
  listWorkspaces(context: ApplicationContext): Promise<ServerWorkspace[]>;
  listMembers(
    context: ApplicationContext,
    workspaceId: string,
  ): Promise<WorkspaceMember[]>;
  setMember(
    context: ApplicationContext,
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember>;
  removeMember(
    context: ApplicationContext,
    workspaceId: string,
    userId: string,
  ): Promise<void>;
}

export function createWorkspaceService(
  repository: WorkspaceRepository,
): WorkspaceService {
  const requireAdmin = async (
    context: ApplicationContext,
    workspaceId: string,
  ): Promise<void> => {
    const role = await repository.roleOf(
      workspaceId,
      context.principal.subjectUserId,
    );
    if (role === null) throw notFound(`No workspace with id ${workspaceId}.`);
    if (role !== "ADMIN")
      throw forbidden("Workspace administrator access is required.");
  };

  const workspaceFor = async (
    context: ApplicationContext,
    workspaceId: string,
  ) => {
    const workspace = (
      await repository.listForUser(context.principal.subjectUserId)
    ).find((entry) => entry.id === workspaceId);
    if (!workspace) throw notFound(`No workspace with id ${workspaceId}.`);
    return workspace;
  };

  const workspaceName = (name: string): string => {
    const trimmed = name.trim();
    if (trimmed === "") throw invalid("A workspace name is required.");
    return trimmed;
  };

  return {
    createWorkspace(context, name) {
      return repository.create({
        ownerId: context.principal.subjectUserId,
        name: workspaceName(name),
      });
    },

    async renameWorkspace(context, workspaceId, name) {
      await requireAdmin(context, workspaceId);
      return repository.rename(
        workspaceId,
        workspaceName(name),
        context.principal.subjectUserId,
      );
    },

    async deleteWorkspace(context, workspaceId) {
      const workspace = await workspaceFor(context, workspaceId);
      if (workspace.ownerId !== context.principal.subjectUserId) {
        throw forbidden("Only the workspace owner can delete it.");
      }
      if (workspace.isDefault) {
        throw invalid("Your default workspace cannot be deleted.");
      }
      await repository.delete(workspaceId);
    },

    listWorkspaces(context) {
      return repository.listForUser(context.principal.subjectUserId);
    },

    async listMembers(context, workspaceId) {
      const role = await repository.roleOf(
        workspaceId,
        context.principal.subjectUserId,
      );
      if (role === null) throw notFound(`No workspace with id ${workspaceId}.`);
      return repository.listMembers(workspaceId);
    },

    async setMember(context, workspaceId, userId, role) {
      await requireAdmin(context, workspaceId);
      const members = await repository.listMembers(workspaceId);
      const target = members.find((member) => member.userId === userId);
      if (
        target?.role === "ADMIN" &&
        role !== "ADMIN" &&
        members.filter((member) => member.role === "ADMIN").length === 1
      ) {
        throw invalid("A workspace must keep at least one administrator.");
      }
      return repository.setMember(workspaceId, userId, role);
    },

    async removeMember(context, workspaceId, userId) {
      await requireAdmin(context, workspaceId);
      if (userId === context.principal.subjectUserId) {
        throw invalid("You cannot remove yourself from a workspace.");
      }
      const members = await repository.listMembers(workspaceId);
      const target = members.find((member) => member.userId === userId);
      if (
        target?.role === "ADMIN" &&
        members.filter((member) => member.role === "ADMIN").length === 1
      ) {
        throw invalid("A workspace must keep at least one administrator.");
      }
      await repository.removeMember(workspaceId, userId);
    },
  };
}
