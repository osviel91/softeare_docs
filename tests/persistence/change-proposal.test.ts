// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { ApplicationContext } from "../../src/application/context";
import { createChangeProposalService } from "../../src/application/change-proposal-service";
import { ApplicationError } from "../../src/application/errors";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createWorkspaceRepository } from "../../src/persistence/workspace-repository";
import { createChangeProposalRepository } from "../../src/persistence/change-proposal-repository";
import type { SqlClient } from "../../src/persistence/sql-client";
import { closeTestDatabase, openTestDatabase } from "./test-database";
import { createWorkspaceOperationRepository } from "../../src/persistence/workspace-operation-repository";
import { createWorkspaceMutationService } from "../../src/application/workspace-mutations";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { hashWorkspaceContent } from "../../src/persistence/server-runtime";
import { migrate } from "../../src/persistence/migrate";

let client: SqlClient;
let projects: ReturnType<typeof createProjectRepository>;
let proposals: ReturnType<typeof createChangeProposalRepository>;
let volume: string;

beforeAll(async () => {
  client = await openTestDatabase();
  projects = createProjectRepository(client);
  proposals = createChangeProposalRepository(client);
  volume = await mkdtemp(path.join(tmpdir(), "sd-proposals-"));
});

afterAll(async () => {
  await closeTestDatabase(client);
  await rm(volume, { recursive: true, force: true });
});

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
  it("merges a fresh proposal through one canonical revision", async () => {
    const { context, projectId, resourceId } = await fixture();
    const mutations = createWorkspaceMutationService({
      projects,
      storage: (id) => createFsProjectStorage({ root: path.join(volume, id) }),
      operations: createWorkspaceOperationRepository(client),
      hashContent: hashWorkspaceContent,
    });
    const service = createChangeProposalService({
      proposals,
      projects,
      mutations,
    });
    const proposal = await service.create(context, projectId, resourceId, {
      title: "Merge me",
    });
    const open = await service.open(context, proposal.id, proposal.version);
    await service.update(context, proposal.id, {
      expectedVersion: open.version,
      proposedContent: "merged content",
    });
    await client.query(
      "ALTER TABLE change_proposals DROP CONSTRAINT IF EXISTS change_proposals_status_known",
    );
    await client.query(
      "ALTER TABLE change_proposals ADD CONSTRAINT change_proposals_status_known CHECK (status IN ('draft', 'open', 'closed'))",
    );
    await client.query("DELETE FROM schema_migrations WHERE version = 14");
    expect((await migrate(client)).applied).toEqual([14]);
    const result = await service.merge(context, proposal.id);

    expect(result.resource.revision).toBe(2);
    expect(result.proposal.status).toBe("merged");
    expect(result.proposal.mergedRevision).toBe(2);
    expect(result.proposal.mergedAt).toBeTruthy();
    expect(result.proposal.mergeActor).toEqual({
      kind: "user",
      userId: context.principal.subjectUserId,
      subjectUserId: context.principal.subjectUserId,
    });
    expect(
      (await projects.listRevisions(resourceId)).map((r) => r.revision),
    ).toEqual([1, 2]);
    const revisions = await client.query(
      "SELECT revision FROM resource_revisions WHERE resource_id = $1 AND revision = 2",
      [resourceId],
    );
    expect(revisions.rows).toHaveLength(1);
    const operations = await client.query(
      "SELECT resource_id FROM workspace_operations WHERE resource_id = $1",
      [resourceId],
    );
    expect(operations.rows).toHaveLength(1);
    const audits = await client.query(
      "SELECT resource_id FROM audit_events WHERE resource_id = $1",
      [resourceId],
    );
    expect(audits.rows.length).toBeGreaterThan(0);
    expect((await proposals.get(proposal.id))?.author).toEqual(proposal.author);
  });

  it("preserves current content when a stale proposal changes metadata", async () => {
    const { context, projectId, resourceId } = await fixture();
    const mutations = createWorkspaceMutationService({
      projects,
      storage: (id) => createFsProjectStorage({ root: path.join(volume, id) }),
      operations: createWorkspaceOperationRepository(client),
      hashContent: hashWorkspaceContent,
    });
    const service = createChangeProposalService({
      proposals,
      projects,
      mutations,
    });
    const proposal = await service.create(context, projectId, resourceId, {
      title: "Stale metadata",
    });
    const open = await service.open(context, proposal.id, proposal.version);
    await service.update(context, proposal.id, {
      expectedVersion: open.version,
      proposedMetadata: { tags: ["proposal"] },
    });
    await client.query("UPDATE resources SET revision = 2 WHERE id = $1", [
      resourceId,
    ]);
    await client.query(
      `INSERT INTO resource_revisions
         (resource_id, revision, content, type, metadata, authorship)
       VALUES ($1, 2, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        resourceId,
        "canonical current",
        "markdown-document",
        "{}",
        JSON.stringify({ kind: "system" }),
      ],
    );
    const result = await service.merge(context, proposal.id);
    const revision = await projects.getRevision(
      resourceId,
      result.resource.revision,
    );

    expect(revision?.content).toBe("canonical current");
    expect(revision?.metadata).toEqual({ tags: ["proposal"] });
  });

  it("rejects conflicts without changing canonical state or closing the proposal", async () => {
    const { context, projectId, resourceId } = await fixture();
    const mutations = createWorkspaceMutationService({
      projects,
      storage: (id) => createFsProjectStorage({ root: path.join(volume, id) }),
      operations: createWorkspaceOperationRepository(client),
      hashContent: hashWorkspaceContent,
    });
    const service = createChangeProposalService({
      proposals,
      projects,
      mutations,
    });
    const proposal = await service.create(context, projectId, resourceId, {
      title: "Conflict",
    });
    const open = await service.open(context, proposal.id, proposal.version);
    await service.update(context, proposal.id, {
      expectedVersion: open.version,
      proposedContent: "proposal current",
    });
    await client.query("UPDATE resources SET revision = 2 WHERE id = $1", [
      resourceId,
    ]);
    await client.query(
      `INSERT INTO resource_revisions
         (resource_id, revision, content, type, metadata, authorship)
       VALUES ($1, 2, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        resourceId,
        "canonical current",
        "markdown-document",
        "{}",
        JSON.stringify({ kind: "system" }),
      ],
    );

    await expect(service.merge(context, proposal.id)).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "merge_analysis" },
    });
    expect((await projects.findResourceById(resourceId))?.revision).toBe(2);
    expect((await proposals.get(proposal.id))?.status).toBe("open");
    expect(
      (await projects.listRevisions(resourceId)).map((r) => r.revision),
    ).toEqual([1, 2]);
  });
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
    expect(await service.list(context, projectId, otherResourceId)).toEqual([]);

    const open = await service.open(context, proposal.id, 1);
    expect(open.status).toBe("open");
    expect(open.version).toBe(2);
    await expect(service.close(context, proposal.id, 1)).rejects.toMatchObject({
      code: "conflict",
    });
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

  it("compares base to candidate and reports canonical staleness without mutating", async () => {
    const { context, projectId, resourceId } = await fixture();
    const service = createChangeProposalService({ proposals, projects });
    const proposal = await service.create(context, projectId, resourceId, {
      title: "Diff me",
    });
    await service.update(context, proposal.id, {
      expectedVersion: proposal.version,
      proposedContent: "candidate",
    });

    await client.query("UPDATE resources SET revision = 2 WHERE id = $1", [
      resourceId,
    ]);
    await client.query(
      `INSERT INTO resource_revisions
         (resource_id, revision, content, type, metadata, authorship)
       VALUES ($1, 2, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        resourceId,
        "canonical",
        "markdown-document",
        "{}",
        JSON.stringify({ kind: "system" }),
      ],
    );

    const beforeProposal = await proposals.get(proposal.id);
    const beforeRevisionCount = await client.query(
      "SELECT count(*) AS count FROM resource_revisions WHERE resource_id = $1",
      [resourceId],
    );
    const diff = await service.diff(context, proposal.id);
    expect(diff.baseRevision).toBe(1);
    expect(diff.currentRevision).toBe(2);
    expect(diff.stale).toBe(true);
    expect(diff.source.changed).toBe(true);
    expect((await proposals.get(proposal.id))?.version).toBe(
      beforeProposal?.version,
    );
    expect(
      (
        await client.query(
          "SELECT count(*) AS count FROM resource_revisions WHERE resource_id = $1",
          [resourceId],
        )
      ).rows[0].count,
    ).toBe(beforeRevisionCount.rows[0].count);

    const beforeProposalAfterDiff = await proposals.get(proposal.id);
    const analysis = await service.analyzeMerge(context, proposal.id);
    expect(analysis.stale).toBe(true);
    expect((await proposals.get(proposal.id))?.version).toBe(
      beforeProposalAfterDiff?.version,
    );
    expect(
      (
        await client.query(
          "SELECT count(*) AS count FROM resource_revisions WHERE resource_id = $1",
          [resourceId],
        )
      ).rows[0].count,
    ).toBe(beforeRevisionCount.rows[0].count);
  });
});
