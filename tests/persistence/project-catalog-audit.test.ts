/**
 * Audit reliability (mission item 18).
 *
 * The audit trail is written *after* the mutation it describes, on a store that
 * takes part in no shared transaction with the volume. Two properties follow, and
 * both are asserted here rather than assumed:
 *
 * 1. **A failed audit write must not be reported as a failed mutation.** The
 *    change has already committed; telling the caller it did not happen is worse
 *    than a missing row, because they will retry and create a second one. The
 *    failure is reported to an injected observer instead.
 * 2. **The trail never carries a document's contents or a credential.** An audit
 *    row is long-lived and widely readable; the document is neither.
 *
 * The durable fix for the first property is a transactional outbox, so the row
 * and the change commit together. That is Phase 6 work — see
 * `docs/plan/server-migration-4.md`.
 */
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProjectCatalog } from "../../src/application/project-catalog";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { createProjectRepository } from "../../src/persistence/project-repository";
import { createUserRepository } from "../../src/persistence/user-repository";
import { createAuditRepository } from "../../src/persistence/audit-repository";
import type { AuditRepository } from "../../src/application/ports/audit-repository";
import type { ApplicationContext } from "../../src/application/context";
import type { Permission } from "../../src/domain/access/permissions";
import type { SqlClient } from "../../src/persistence/sql-client";
import { openTestDatabase, closeTestDatabase } from "./test-database";

let client: SqlClient;
let volume: string;

beforeAll(async () => {
  client = await openTestDatabase();
  volume = await mkdtemp(path.join(tmpdir(), "sd-audit-"));
});

afterAll(async () => {
  await closeTestDatabase(client);
  await rm(volume, { recursive: true, force: true });
});

const ALL_SCOPES: Permission[] = [
  "project:read",
  "project:write",
  "project:admin",
  "resource:read",
  "resource:write",
  "diagram:render",
  "project:validate",
  "project:export",
  "mcp:read",
  "mcp:write",
];

/** A context owning a fresh project, over the given audit store. */
async function owner(audit?: AuditRepository, onAuditFailure?: () => void) {
  const users = createUserRepository(client);
  const catalog = createProjectCatalog({
    projects: createProjectRepository(client),
    audit,
    storage: (projectId) =>
      createFsProjectStorage({ root: path.join(volume, projectId) }),
    ...(onAuditFailure === undefined ? {} : { onAuditFailure }),
  });
  const user = await users.findOrCreateByExternalIdentity({
    issuer: "https://idp.test",
    subject: `audit-${Math.random().toString(36).slice(2)}`,
    displayName: "Audit User",
    email: null,
  });
  const context: ApplicationContext = {
    requestId: "req-audit",
    principal: { userId: user.id, authType: "session", scopes: ALL_SCOPES },
  };
  const listing = await catalog.createProject(context, { name: "Audited" });
  return { catalog, context, projectId: listing.project.id };
}

describe("an audit write that fails", () => {
  it("does not turn a committed mutation into a reported failure", async () => {
    const failure = new Error("the audit store is down");
    const observer = vi.fn();
    const broken: AuditRepository = {
      record: () => Promise.reject(failure),
      recordAll: () => Promise.reject(failure),
      listForProject: () => Promise.resolve([]),
      listForUser: () => Promise.resolve([]),
    };
    const { catalog, context, projectId } = await owner(broken, observer);

    // The project creation itself already went through the broken audit store;
    // the resource write is the mutation under test.
    const created = await catalog.createResource(context, projectId, {
      path: "checkout.seq",
      type: "sequence-diagram",
      content: "title Checkout",
    });

    expect(created.path).toBe("checkout.seq");
    // The mutation is readable afterwards: it really committed.
    const read = await catalog.readResource(context, projectId, created.id);
    expect(read.content).toBe("title Checkout");
    // And the audit failure was reported rather than swallowed.
    expect(observer).toHaveBeenCalled();
    expect(observer.mock.calls.at(-1)?.[0]).toBe(failure);
  });
});

describe("the audit trail's contents", () => {
  it("records what changed without recording the document or a credential", async () => {
    const audit = createAuditRepository(client);
    const { catalog, context, projectId } = await owner(audit);
    const secret = "SEKRIT-DOCUMENT-CONTENT";

    const created = await catalog.createResource(context, projectId, {
      path: "checkout.seq",
      type: "sequence-diagram",
      content: secret,
    });
    await catalog.updateResource(context, projectId, created.id, {
      content: `${secret} v2`,
      expectedRevision: created.revision,
    });
    await catalog.deleteResource(context, projectId, created.id);

    const rows = await audit.listForProject(projectId, 50);
    const actions = rows.map((row) => row.action);
    expect(actions).toContain("project.created");
    expect(actions).toContain("resource.created");
    expect(actions).toContain("resource.updated");
    expect(actions).toContain("resource.deleted");

    // Nothing in the trail may carry the document's bytes, the session token, or
    // the cookie: an audit row outlives the request and is read by operators.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sid_");
    expect(serialized).not.toContain("sdm_session");
  });
});
