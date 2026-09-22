import { describe, expect, it } from "vitest";
import { createWorkspaceService } from "../../src/application/workspace-service";
import type { ApplicationContext } from "../../src/application/context";
import type {
  ServerWorkspace,
  WorkspaceMember,
  WorkspaceRole,
} from "../../src/domain/workspace/server-workspace";
import type { WorkspaceRepository } from "../../src/application/ports/workspace-repository";

const workspace: ServerWorkspace = {
  id: "w1",
  name: "Personal Workspace",
  role: "ADMIN",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function context(userId: string): ApplicationContext {
  return {
    requestId: "test",
    principal: {
      subjectUserId: userId,
      actor: { kind: "user", userId },
      authType: "session",
      scopes: [],
    },
  };
}

function repository(): WorkspaceRepository {
  const members: WorkspaceMember[] = [
    {
      workspaceId: "w1",
      userId: "admin",
      displayName: "Ada",
      email: "ada@example.test",
      role: "ADMIN",
      createdAt: new Date(0),
    },
    {
      workspaceId: "w1",
      userId: "editor",
      displayName: "Grace",
      email: "grace@example.test",
      role: "EDITOR",
      createdAt: new Date(0),
    },
  ];
  return {
    listForUser: async (userId) => userId === "admin" || userId === "editor" ? [{ ...workspace, role: userId === "admin" ? "ADMIN" : "EDITOR" }] : [],
    listMembers: async () => members,
    roleOf: async (_workspaceId, userId) => members.find((member) => member.userId === userId)?.role ?? null,
    setMember: async (_workspaceId, userId, role: WorkspaceRole) => {
      const member = members.find((entry) => entry.userId === userId);
      if (!member) throw new Error("missing member");
      member.role = role;
      return member;
    },
    removeMember: async (_workspaceId, userId) => {
      const index = members.findIndex((member) => member.userId === userId);
      if (index >= 0) members.splice(index, 1);
    },
  };
}

describe("workspace service", () => {
  it("allows members to list and only admins to manage membership", async () => {
    const service = createWorkspaceService(repository());
    await expect(service.listMembers(context("editor"), "w1")).resolves.toHaveLength(2);
    await expect(service.setMember(context("editor"), "w1", "editor", "VIEWER"))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(service.setMember(context("admin"), "w1", "editor", "VIEWER"))
      .resolves.toMatchObject({ role: "VIEWER" });
  });

  it("prevents an admin from removing themselves", async () => {
    const service = createWorkspaceService(repository());
    await expect(service.removeMember(context("admin"), "w1", "admin"))
      .rejects.toMatchObject({ code: "invalid" });
  });
});
