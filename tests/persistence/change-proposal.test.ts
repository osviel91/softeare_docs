// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { ApplicationContext } from "../../src/application/context";
import { createChangeProposalService } from "../../src/application/change-proposal-service";
import { ApplicationError } from "../../src/application/errors";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createChangeProposalRepository } from "../../src/persistence/change-proposal-repository";
import type { SqlClient } from "../../src/persistence/sql-client";
import { closeTestDatabase, openTestDatabase } from "./test-database";

let client: SqlClient;
let projects: ReturnType<typeof createProjectRepository>;
let proposals: ReturnType<typeof createChangeProposalRepository>;

beforeAll(async () => {
  client = await openTestDatabase();
  projects = createProjectRepository(client);
  proposals = createChangeProposalRepository(client);
});

afterAll(async () => closeTestDatabase(client));

function contextFor(userId: string): ApplicationContext {
  return {
    requestId: "proposal-test",
    principal: {
      subjectUserId: userId,
      actor: { kind: "user", userId },
      authType: "session",
      scopes: [...ALL_PERMISSIONS],
    },
  };
}

async function fixture(): Promise<{
  context: ApplicationContext;
  projectId: string;
  resourceId: string;
  otherResourceId: string;
}> {
  const user = await client.query(
    `INSERT INTO users (id, display_name, status)
     VALUES (gen_random_uuid(), 'Proposal Tester', 'ACTIVE') RETURNING id`,
  );
  const userId = String(user.rows[0].id);
  const workspace = await createWorkspaceRepository(client).create({
    ownerId: userId,
    name: "Proposal Workspace",
  });
  const project = await projects.create({
    ownerId: userId,
    workspaceId: workspace.id,
    name: "Proposals",
  });
  const first = await projects.createResource(project.id, {
    path: "one.md",
    type: "markdown-document",
    metadata: { tags: ["one"] },
  });
  const second = await projects.createResource(project.id, {
    path: "two.md",
    type: "markdown-document",
  });
  for (const resource of [first, second]) {
    await client.query(
      `INSERT INTO resource_revisions
         (resource_id, revision, content, type, metadata, authorship)
       VALUES ($1, 1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        resource.id,
        resource.id === first.id ? "immutable base" : "other base",
        resource.type,
        JSON.stringify(resource.metadata ?? {}),
        JSON.stringify({ kind: "system" }),
      ],
    );
  }
  return {
    context: contextFor(userId),
    projectId: project.id,
    resourceId: first.id,
    otherResourceId: second.id,
  };
}

describe("change proposals", () => {
  it("isolates immutable base state and enforces proposal-local lifecycle versions", async () => {
    const { context, projectId, resourceId, otherResourceId } = await fixture();
    const service = createChangeProposalService({ proposals, projects });
    const proposal = await service.create(context, projectId, resourceId, {
      title: "Improve document",
    });

    expect(proposal.proposedContent).toBe("immutable base");
    expect(proposal.proposedMetadata).toEqual({ tags: ["one"] });
    expect(proposal.status).toBe("draft");
    expect(proposal.version).toBe(1);
    expect((await service.list(context, projectId, otherResourceId))).toEqual([]);

    const open = await service.open(context, proposal.id, 1);
    expect(open.status).toBe("open");
    expect(open.version).toBe(2);
    await expect(
      service.close(context, proposal.id, 1),
    ).rejects.toMatchObject({ code: "conflict" });
    const closed = await service.close(context, proposal.id, 2);
    expect(closed.status).toBe("closed");
    expect(closed.version).toBe(3);
    await expect(
      service.update(context, proposal.id, {
        expectedVersion: 3,
        proposedContent: "too late",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("makes proposals unavailable when their resource is deleted", async () => {
    const { context, projectId, resourceId } = await fixture();
    const service = createChangeProposalService({ proposals, projects });
    const proposal = await service.create(context, projectId, resourceId, {
      title: "Delete me with the resource",
    });
    await projects.deleteResource(projectId, resourceId);
    await expect(service.get(context, proposal.id)).rejects.toBeInstanceOf(
      ApplicationError,
    );
  });
});
