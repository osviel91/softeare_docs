/**
 * Project isolation, end to end (mission Phase 3, item 21).
 *
 * The migration's central security claim is that a user's project is reachable
 * only through their own membership: two people with two projects must not be
 * able to see, read, write, move, delete, administer, or *join* each other's.
 * `tests/api/projects.test.ts` asserts the happy paths and a few refusals;
 * `tests/persistence/project-catalog.test.ts` asserts the use cases in
 * isolation. What was missing is the explicit, address-by-address integration
 * test for the isolation boundary itself — and an assertion that the boundary
 * holds when the HTTP layer is removed entirely.
 *
 * Three properties are what this file exists to pin down:
 *
 * 1. **Symmetry.** Every refusal is asserted in *both* directions. An isolation
 *    guarantee with one owner in it proves nothing about the other.
 * 2. **Two layers, one answer.** Each case goes through the real route table
 *    *and* calls the same catalog use case with a hand-built
 *    {@link ApplicationContext}. If a controller ever forgot to enforce
 *    something, the direct call still fails — and if the catalog ever grew a
 *    hole, the HTTP status would move. Testing both is what makes the claim
 *    about the application layer, not about endpoint wiring.
 * 3. **Error kind, not just status.** A non-member is `not_found`/404 (the
 *    project is invisible), while a member whose role is too weak is
 *    `forbidden`/403 (the project is visible, the act is not). That distinction
 *    is the mission's scenario 4, and collapsing it would either leak the
 *    existence of private projects or hide a fixable permission problem.
 *
 * The identity provider is the local, real-crypto test provider, and sessions
 * are minted exactly as `projects.test.ts` does, so no network or external IdP
 * is involved and the tests are deterministic.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../apps/api/config";
import { closeApp, createApp, type AppDependencies } from "../../apps/api/app";
import { createRouter } from "../../apps/api/routes";
import {
  SESSION_COOKIE,
  SESSION_SCOPES,
  createSessionToken,
  hashSessionToken,
} from "../../apps/api/context";
import {
  parseCookies,
  parseQuery,
  type ServerRequest,
} from "../../apps/api/http/http";
import {
  createAuthorizationPolicy,
  type AuthorizationPolicy,
} from "../../src/application/authorization";
import { ApplicationError } from "../../src/application/errors";
import type { ApplicationContext } from "../../src/application/context";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import { createTestProvider, type TestProvider } from "./test-provider";

let dependencies: AppDependencies;
let volume: string;
let provider: TestProvider;
let router: ReturnType<typeof createRouter>;
/**
 * The policy built directly over the same repository the app uses.
 *
 * The catalog already has a policy inside it; building a second one here is the
 * point — it lets a test assert the decision *without* any use case, route, or
 * transport between the principal and the answer.
 */
let policy: AuthorizationPolicy;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "sd-project-isolation-"));
  provider = await createTestProvider();
  dependencies = await createApp(
    loadConfig(
      {
        NODE_ENV: "test",
        COOKIE_SECRET: "i".repeat(48),
        PUBLIC_URL: "http://localhost:4000",
        PROJECT_VOLUME: volume,
        PGLITE_DIR: "memory://",
        OIDC_ISSUER: provider.issuer,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_REDIRECT_URI: provider.redirectUri,
      },
      { oidcFetch: provider.fetch },
    ),
  );
  router = createRouter(dependencies);
  policy = createAuthorizationPolicy(dependencies.projects);
});

afterAll(async () => {
  await closeApp(dependencies);
  await rm(volume, { recursive: true, force: true });
});

/** A signed-in user, with the cookie that identifies them. */
interface SignedIn {
  cookie: string;
  userId: string;
  token: string;
}

/** A user, their project, and the one resource inside it. */
interface OwnedProject {
  owner: SignedIn;
  projectId: string;
  resourceId: string;
  resourcePath: string;
  resourceContent: string;
}

/** One side of the relationship under test, plus the positive control. */
interface Direction {
  /** The user acting, who belongs to no project but `own`. */
  member: SignedIn;
  /** The project the member owns, used to prove the refusals are not just errors. */
  own: OwnedProject;
  /** The project the member must not reach, owned by the other user. */
  other: OwnedProject;
}

let subjectCounter = 0;

/**
 * A signed-in user, created through the real identity path.
 *
 * The repository maps `(issuer, subject)` to an internal user and the session
 * repository stores only a hash, so this is the same identity the API resolves
 * from a cookie — not a principal invented for the test.
 */
async function signIn(): Promise<SignedIn> {
  subjectCounter += 1;
  const user = await dependencies.users.findOrCreateByExternalIdentity({
    issuer: provider.issuer,
    subject: `isolation-subject-${subjectCounter}`,
    displayName: `Isolation User ${subjectCounter}`,
    email: null,
  });
  const sessionId = crypto.randomUUID();
  const token = createSessionToken(sessionId);
  await dependencies.sessions.create({
    id: sessionId,
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + 600_000),
  });
  return {
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    userId: user.id,
    token,
  };
}

/** Build a request, as the Node adapter would. */
function request(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown } = {},
): ServerRequest {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const queryIndex = url.indexOf("?");
  return {
    method,
    path: queryIndex === -1 ? url : url.slice(0, queryIndex),
    query: parseQuery(queryIndex === -1 ? "" : url.slice(queryIndex)),
    headers,
    cookies: parseCookies(headers.cookie),
    body: options.body === undefined ? null : JSON.stringify(options.body),
  };
}

/** Call a route and parse its JSON body. */
async function call(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await router.handle(request(method, url, options));
  return {
    status: response.status,
    body: response.body === "" ? null : JSON.parse(response.body),
  };
}

/**
 * The context a session would produce for this user.
 *
 * Built from the API's own `SESSION_SCOPES` rather than a list retyped here, so
 * a direct use-case call carries exactly the authority the cookie carries. The
 * only thing removed is the transport.
 */
function contextFor(
  userId: string,
  requestId = "req-isolation",
): ApplicationContext {
  return {
    requestId,
    principal: {
      subjectUserId: userId,
      actor: { kind: "user", userId },
      authType: "session",
      scopes: SESSION_SCOPES,
    },
  };
}

/** The `ApplicationError` a call rejects with, failing the test if it resolves. */
async function failureOf(work: Promise<unknown>): Promise<ApplicationError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApplicationError) return error;
    throw error;
  }
  throw new Error("Expected the call to fail, but it succeeded.");
}

/** Create a project with one resource, through the real routes. */
async function createOwnedProject(
  owner: SignedIn,
  name: string,
  file: { path: string; content: string },
): Promise<OwnedProject> {
  const created = await call("POST", "/api/projects", {
    cookie: owner.cookie,
    body: { name },
  });
  if (created.status !== 201) {
    throw new Error(`Could not create "${name}": ${created.status}`);
  }
  const projectId = created.body.project.id as string;
  const resource = await call("POST", `/api/projects/${projectId}/resources`, {
    cookie: owner.cookie,
    body: {
      path: file.path,
      type: "sequence-diagram",
      content: file.content,
    },
  });
  if (resource.status !== 201) {
    throw new Error(`Could not create the resource: ${resource.status}`);
  }
  return {
    owner,
    projectId,
    resourceId: resource.body.resource.id as string,
    resourcePath: file.path,
    resourceContent: file.content,
  };
}

const SECRET_A = "participant A\nA -> B: A's private diagram\n";
const SECRET_B = "participant B\nB -> A: B's private diagram\n";

let projectA: OwnedProject;
let projectB: OwnedProject;

/** Both directions, so no assertion depends on which user is "the owner". */
function directions(): Direction[] {
  return [
    { member: projectA.owner, own: projectA, other: projectB },
    { member: projectB.owner, own: projectB, other: projectA },
  ];
}

beforeAll(async () => {
  const otherA = await signIn();
  const otherB = await signIn();
  projectA = await createOwnedProject(otherA, "Project A", {
    path: "private/a.seq",
    content: SECRET_A,
  });
  projectB = await createOwnedProject(otherB, "Project B", {
    path: "private/b.seq",
    content: SECRET_B,
  });
});

describe("two owners, two projects: neither can reach the other's", () => {
  it("lists each owner's own project and never the other's", async () => {
    for (const { member, own, other } of directions()) {
      const listed = await call("GET", "/api/projects", {
        cookie: member.cookie,
      });
      expect(listed.status).toBe(200);
      const ids = listed.body.projects.map((entry: any) => entry.id);
      expect(ids).toContain(own.projectId);
      expect(ids).not.toContain(other.projectId);

      // The use case gives the same answer with no request in the way, so the
      // boundary is membership and not the listing route.
      const direct = await dependencies.catalog.listProjects(
        contextFor(member.userId),
      );
      expect(direct.map((entry) => entry.project.id)).toContain(own.projectId);
      expect(direct.map((entry) => entry.project.id)).not.toContain(
        other.projectId,
      );
    }
  });

  it("answers 404/not_found for the other's project, never 403", async () => {
    // A 403 would confirm the project exists; a non-member must not be able to
    // tell an existing project from one that was never created.
    for (const { member, other } of directions()) {
      const response = await call("GET", `/api/projects/${other.projectId}`, {
        cookie: member.cookie,
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("not_found");

      const failure = await failureOf(
        dependencies.catalog.getProject(
          contextFor(member.userId),
          other.projectId,
        ),
      );
      expect(failure).toBeInstanceOf(ApplicationError);
      expect(failure.code).toBe("not_found");
      expect(failure.status).toBe(404);
    }
  });

  it("cannot list the other's resources", async () => {
    for (const { member, other } of directions()) {
      const response = await call(
        "GET",
        `/api/projects/${other.projectId}/resources`,
        { cookie: member.cookie },
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("not_found");

      await expect(
        dependencies.catalog.listResources(
          contextFor(member.userId),
          other.projectId,
        ),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
    }

    // Positive control: each owner still lists exactly their own resource, so
    // the refusals above are about membership and not a broken listing.
    for (const { member, own } of directions()) {
      const response = await call(
        "GET",
        `/api/projects/${own.projectId}/resources`,
        { cookie: member.cookie },
      );
      expect(response.status).toBe(200);
      expect(response.body.resources.map((entry: any) => entry.id)).toEqual([
        own.resourceId,
      ]);
    }
  });

  it("cannot create a resource in the other's project", async () => {
    for (const { member, other } of directions()) {
      const response = await call(
        "POST",
        `/api/projects/${other.projectId}/resources`,
        {
          cookie: member.cookie,
          body: {
            path: "intruder.seq",
            type: "sequence-diagram",
            content: "planted",
          },
        },
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("not_found");

      await expect(
        dependencies.catalog.createResource(
          contextFor(member.userId),
          other.projectId,
          {
            path: "intruder.seq",
            type: "sequence-diagram",
            content: "planted",
          },
        ),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });

      // Nothing was written where the intruder aimed.
      const ownerView = await call(
        "GET",
        `/api/projects/${other.projectId}/resources`,
        { cookie: other.owner.cookie },
      );
      expect(
        ownerView.body.resources.map((entry: any) => entry.path),
      ).not.toContain("intruder.seq");
    }
  });

  it("cannot read the other's resource, even under a project the caller owns", async () => {
    for (const { member, own, other } of directions()) {
      const direct = await call(
        "GET",
        `/api/projects/${other.projectId}/resources/${other.resourceId}`,
        { cookie: member.cookie },
      );
      expect(direct.status).toBe(404);
      expect(direct.body.error.code).toBe("not_found");

      // A resource id is not an address. Placing the other project's resource id
      // under a project the caller *does* own must resolve to nothing, because
      // every repository query is scoped by `project_id`.
      const substituted = await call(
        "GET",
        `/api/projects/${own.projectId}/resources/${other.resourceId}`,
        { cookie: member.cookie },
      );
      expect(substituted.status).toBe(404);

      await expect(
        dependencies.catalog.readResource(
          contextFor(member.userId),
          other.projectId,
          other.resourceId,
        ),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });

      // Positive control: the owner can still read the very same resource.
      const ownerView = await call(
        "GET",
        `/api/projects/${other.projectId}/resources/${other.resourceId}`,
        { cookie: other.owner.cookie },
      );
      expect(ownerView.status).toBe(200);
      expect(ownerView.body.content).toBe(other.resourceContent);
    }
  });

  it("cannot update the other's resource, and its content is untouched", async () => {
    for (const { member, own, other } of directions()) {
      const attempted = await call(
        "PUT",
        `/api/projects/${other.projectId}/resources/${other.resourceId}`,
        {
          cookie: member.cookie,
          body: { content: "tampered by the other owner", expectedRevision: 1 },
        },
      );
      expect(attempted.status).toBe(404);
      expect(attempted.body.error.code).toBe("not_found");

      await expect(
        dependencies.catalog.updateResource(
          contextFor(member.userId),
          other.projectId,
          other.resourceId,
          { content: "tampered by the other owner", expectedRevision: 1 },
        ),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });

      // The same write aimed at the caller's *own* project with the other
      // project's resource id must fail too, or a mistyped id would cross the
      // boundary through the one project the caller is allowed to write.
      const substituted = await call(
        "PUT",
        `/api/projects/${own.projectId}/resources/${other.resourceId}`,
        {
          cookie: member.cookie,
          body: { content: "tampered", expectedRevision: 1 },
        },
      );
      expect(substituted.status).toBe(404);

      const ownerView = await call(
        "GET",
        `/api/projects/${other.projectId}/resources/${other.resourceId}`,
        { cookie: other.owner.cookie },
      );
      expect(ownerView.status).toBe(200);
      expect(ownerView.body.resource.revision).toBe(1);
      expect(ownerView.body.content).toBe(other.resourceContent);
    }
  });

  it("cannot move the other's resource, and its path is untouched", async () => {
    for (const { member, other } of directions()) {
      const attempted = await call(
        "POST",
        `/api/projects/${other.projectId}/resources/${other.resourceId}/move`,
        {
          cookie: member.cookie,
          body: { path: "stolen/moved.seq", expectedRevision: 1 },
        },
      );
      expect(attempted.status).toBe(404);
      expect(attempted.body.error.code).toBe("not_found");

      await expect(
        dependencies.catalog.moveResource(
          contextFor(member.userId),
          other.projectId,
          other.resourceId,
          { path: "stolen/moved.seq", expectedRevision: 1 },
        ),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });

      const ownerView = await call(
        "GET",
        `/api/projects/${other.projectId}/resources/${other.resourceId}`,
        { cookie: other.owner.cookie },
      );
      expect(ownerView.status).toBe(200);
      expect(ownerView.body.resource.path).toBe(other.resourcePath);
      expect(ownerView.body.resource.revision).toBe(1);
    }
  });

  it("cannot delete the other's resource", async () => {
    for (const { member, other } of directions()) {
      const attempted = await call(
        "DELETE",
        `/api/projects/${other.projectId}/resources/${other.resourceId}`,
        { cookie: member.cookie },
      );
      expect(attempted.status).toBe(404);
      expect(attempted.body.error.code).toBe("not_found");

      await expect(
        dependencies.catalog.deleteResource(
          contextFor(member.userId),
          other.projectId,
          other.resourceId,
        ),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });

      const ownerView = await call(
        "GET",
        `/api/projects/${other.projectId}/resources/${other.resourceId}`,
        { cookie: other.owner.cookie },
      );
      expect(ownerView.status).toBe(200);
      expect(ownerView.body.content).toBe(other.resourceContent);
    }
  });

  it("cannot administer the other's project or join it by force", async () => {
    for (const { member, other } of directions()) {
      const attempts: Array<[string, string, unknown]> = [
        ["PATCH", `/api/projects/${other.projectId}`, { name: "Taken over" }],
        ["DELETE", `/api/projects/${other.projectId}`, undefined],
        // Self-escalation is the sharpest case: adding yourself as OWNER must be
        // exactly as impossible as reading the project, or isolation is one
        // request away from being gone.
        [
          "PUT",
          `/api/projects/${other.projectId}/members/${member.userId}`,
          { role: "OWNER" },
        ],
      ];
      for (const [method, url, body] of attempts) {
        const response = await call(
          method,
          url,
          body === undefined
            ? { cookie: member.cookie }
            : { cookie: member.cookie, body },
        );
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("not_found");
      }

      // The direct use cases refuse the same escalation through the catalog.
      for (const work of [
        dependencies.catalog.setMember(
          contextFor(member.userId),
          other.projectId,
          member.userId,
          "OWNER",
        ),
        dependencies.catalog.deleteProject(
          contextFor(member.userId),
          other.projectId,
        ),
        dependencies.catalog.updateProject(
          contextFor(member.userId),
          other.projectId,
          { name: "Taken over" },
        ),
        dependencies.catalog.removeMember(
          contextFor(member.userId),
          other.projectId,
          other.owner.userId,
        ),
      ]) {
        const failure = await failureOf(work);
        expect(failure.code).toBe("not_found");
        expect(failure.status).toBe(404);
      }

      // The failed escalation changed nothing: the project still exists, the
      // owner still owns it, and the intruder is still a non-member.
      const stillOwned = await call("GET", `/api/projects/${other.projectId}`, {
        cookie: other.owner.cookie,
      });
      expect(stillOwned.status).toBe(200);
      expect(stillOwned.body.project.ownerId).toBe(other.owner.userId);

      const stillHidden = await call(
        "GET",
        `/api/projects/${other.projectId}`,
        { cookie: member.cookie },
      );
      expect(stillHidden.status).toBe(404);
    }
  });

  it("leaves both projects with exactly their own single resource", async () => {
    // A summary after every intrusion above: the bytes on the volume and the
    // rows in PostgreSQL are both exactly as the owners left them.
    for (const { own } of directions()) {
      const listed = await call(
        "GET",
        `/api/projects/${own.projectId}/resources`,
        { cookie: own.owner.cookie },
      );
      expect(listed.body.resources).toEqual([
        {
          id: own.resourceId,
          projectId: own.projectId,
          path: own.resourcePath,
          type: "sequence-diagram",
          revision: 1,
        },
      ]);
      const read = await call(
        "GET",
        `/api/projects/${own.projectId}/resources/${own.resourceId}`,
        { cookie: own.owner.cookie },
      );
      expect(read.body.content).toBe(own.resourceContent);
    }
  });
});

describe("the guarantee does not depend on the HTTP wiring", () => {
  it("the catalog refuses every operation for a non-member", async () => {
    for (const { member, other } of directions()) {
      const context = contextFor(member.userId);
      const failures = await Promise.all([
        failureOf(dependencies.catalog.getProject(context, other.projectId)),
        failureOf(
          dependencies.catalog.describeAccess(context, other.projectId),
        ),
        failureOf(dependencies.catalog.listResources(context, other.projectId)),
        failureOf(
          dependencies.catalog.readResource(
            context,
            other.projectId,
            other.resourceId,
          ),
        ),
        failureOf(
          dependencies.catalog.updateResource(
            context,
            other.projectId,
            other.resourceId,
            { content: "x", expectedRevision: 1 },
          ),
        ),
        failureOf(
          dependencies.catalog.moveResource(
            context,
            other.projectId,
            other.resourceId,
            { path: "x.seq", expectedRevision: 1 },
          ),
        ),
        failureOf(
          dependencies.catalog.deleteResource(
            context,
            other.projectId,
            other.resourceId,
          ),
        ),
        failureOf(
          dependencies.catalog.createResource(context, other.projectId, {
            path: "intruder.seq",
            type: "sequence-diagram",
            content: "x",
          }),
        ),
        failureOf(
          dependencies.catalog.updateProject(context, other.projectId, {
            name: "Taken over",
          }),
        ),
        failureOf(
          dependencies.catalog.setMember(
            context,
            other.projectId,
            member.userId,
            "OWNER",
          ),
        ),
        failureOf(dependencies.catalog.deleteProject(context, other.projectId)),
      ]);
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(ApplicationError);
        expect(failure.code).toBe("not_found");
        expect(failure.status).toBe(404);
      }

      // The advisory question agrees with the enforced answer, so a UI built on
      // it cannot talk a caller into an operation the catalog will refuse.
      expect(
        await dependencies.catalog.can(
          context,
          other.projectId,
          "project:read",
        ),
      ).toBe(false);
      expect(
        await dependencies.catalog.can(
          context,
          other.projectId,
          "resource:update",
        ),
      ).toBe(false);
    }
  });
});

describe("the policy alone refuses a stranger, with no route in the way", () => {
  it("reports every permission as not_found, so nothing can be probed", async () => {
    for (const { member, other } of directions()) {
      const context = contextFor(member.userId);
      for (const permission of ALL_PERMISSIONS) {
        const outcome = await policy.decide(
          context,
          other.projectId,
          permission,
        );
        expect(outcome.allowed).toBe(false);
        if (!outcome.allowed) {
          // `not_found`, never `forbidden`: even a permission the caller's role
          // would grant in their own project must not confirm this one exists.
          expect(outcome.reason).toBe("not_found");
          expect(outcome.role).toBeNull();
          expect(outcome.missing).toBe(permission);
        }
      }
      await expect(
        policy.requirePermission(context, other.projectId, "resource:update"),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
    }
  });

  it("keeps a project-restricted credential blind to every other project", async () => {
    // A PAT limited to Project A is answered exactly as a project that does not
    // exist when it addresses Project B, so the credential cannot be used to
    // enumerate project ids.
    const restricted: ApplicationContext = {
      requestId: "req-restricted-isolation",
      principal: {
        subjectUserId: projectA.owner.userId,
        actor: {
          kind: "agent",
          agentId: "agent-isolation",
          credentialId: "credential-isolation",
        },
        authType: "pat",
        scopes: [...ALL_PERMISSIONS],
        allowedProjectIds: [projectA.projectId],
      },
    };
    const outcome = await policy.decide(
      restricted,
      projectB.projectId,
      "project:read",
    );
    expect(outcome).toEqual({
      allowed: false,
      reason: "restricted",
      role: null,
      missing: "project:read",
    });
    const failure = await failureOf(
      policy.requirePermission(restricted, projectB.projectId, "project:read"),
    );
    expect(failure.code).toBe("not_found");
    expect(failure.status).toBe(404);

    // The restriction narrows access rather than breaking it: the same
    // credential still reaches the project it names.
    expect(
      (await policy.decide(restricted, projectA.projectId, "project:read"))
        .allowed,
    ).toBe(true);
  });
});

describe("no membership and the wrong role are refused differently", () => {
  // Mission scenario 4: an outsider must not learn that the project exists,
  // while a reader who is genuinely a member is told plainly that this role
  // cannot write. Collapsing the two into one status would either leak
  // existence or hide a fixable permission problem.
  let owner: SignedIn;
  let viewer: SignedIn;
  let stranger: SignedIn;
  let projectId: string;
  let resourceId: string;

  beforeAll(async () => {
    owner = await signIn();
    viewer = await signIn();
    stranger = await signIn();
    const project = await createOwnedProject(owner, "Shared with a viewer", {
      path: "docs/shared.seq",
      content: "participant A\nA -> B: shared\n",
    });
    projectId = project.projectId;
    resourceId = project.resourceId;
    const added = await call(
      "PUT",
      `/api/projects/${projectId}/members/${viewer.userId}`,
      { cookie: owner.cookie, body: { role: "VIEWER" } },
    );
    expect(added.status).toBe(204);
  });

  it("hides the project from a non-member and shows it to a viewer", async () => {
    const hidden = await call("GET", `/api/projects/${projectId}`, {
      cookie: stranger.cookie,
    });
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("not_found");

    const visible = await call("GET", `/api/projects/${projectId}`, {
      cookie: viewer.cookie,
    });
    expect(visible.status).toBe(200);
    expect(visible.body.project.role).toBe("VIEWER");

    // The same contrast at the use-case layer: a viewer resolves to a role, a
    // stranger resolves to nothing.
    await expect(
      dependencies.catalog.getProject(contextFor(stranger.userId), projectId),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (
        await dependencies.catalog.getProject(
          contextFor(viewer.userId),
          projectId,
        )
      ).role,
    ).toBe("VIEWER");
  });

  it("lets a viewer read but refuses every mutation with 403/forbidden", async () => {
    const read = await call(
      "GET",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie: viewer.cookie },
    );
    expect(read.status).toBe(200);
    expect(read.body.content).toContain("shared");

    const listed = await call("GET", `/api/projects/${projectId}/resources`, {
      cookie: viewer.cookie,
    });
    expect(listed.status).toBe(200);

    const mutations: Array<[string, string, unknown]> = [
      [
        "POST",
        `/api/projects/${projectId}/resources`,
        { path: "planted.seq", type: "sequence-diagram", content: "x" },
      ],
      [
        "PUT",
        `/api/projects/${projectId}/resources/${resourceId}`,
        { content: "changed", expectedRevision: 1 },
      ],
      [
        "POST",
        `/api/projects/${projectId}/resources/${resourceId}/move`,
        { path: "moved.seq", expectedRevision: 1 },
      ],
      [
        "DELETE",
        `/api/projects/${projectId}/resources/${resourceId}`,
        undefined,
      ],
      ["PATCH", `/api/projects/${projectId}`, { name: "Renamed" }],
      [
        "PUT",
        `/api/projects/${projectId}/members/${stranger.userId}`,
        { role: "VIEWER" },
      ],
    ];
    for (const [method, url, body] of mutations) {
      const response = await call(
        method,
        url,
        body === undefined
          ? { cookie: viewer.cookie }
          : { cookie: viewer.cookie, body },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("forbidden");
    }

    // The catalog agrees without a request, and reports the missing permission
    // rather than a bare refusal.
    expect(
      await dependencies.catalog.can(
        contextFor(viewer.userId),
        projectId,
        "resource:read",
      ),
    ).toBe(true);
    expect(
      await dependencies.catalog.can(
        contextFor(viewer.userId),
        projectId,
        "resource:update",
      ),
    ).toBe(false);
    const failure = await failureOf(
      dependencies.catalog.updateResource(
        contextFor(viewer.userId),
        projectId,
        resourceId,
        { content: "changed", expectedRevision: 1 },
      ),
    );
    expect(failure.code).toBe("forbidden");
    expect(failure.status).toBe(403);

    // A refused write changes nothing, so a viewer's 403 is not a partial write.
    const after = await call(
      "GET",
      `/api/projects/${projectId}/resources/${resourceId}`,
      { cookie: owner.cookie },
    );
    expect(after.body.content).toContain("shared");
    expect(after.body.resource.revision).toBe(1);
  });

  it("distinguishes a stranger's 404 from a viewer's 403 on the very same write", async () => {
    const asStranger = await call(
      "PUT",
      `/api/projects/${projectId}/resources/${resourceId}`,
      {
        cookie: stranger.cookie,
        body: { content: "changed", expectedRevision: 1 },
      },
    );
    expect(asStranger.status).toBe(404);
    expect(asStranger.body.error.code).toBe("not_found");

    const asViewer = await call(
      "PUT",
      `/api/projects/${projectId}/resources/${resourceId}`,
      {
        cookie: viewer.cookie,
        body: { content: "changed", expectedRevision: 1 },
      },
    );
    expect(asViewer.status).toBe(403);
    expect(asViewer.body.error.code).toBe("forbidden");
  });
});

describe("an unauthenticated request is refused before any project is looked up", () => {
  it("maps a missing session to a typed unauthorized failure, not an unknown project", async () => {
    // `unauthorized`/401 is this codebase's name for AUTHENTICATION_REQUIRED:
    // the request proved no identity at all, which is a different fact from
    // being signed in and refused. The typed code is asserted, not just the
    // status, so a future status remap cannot silently change the meaning.
    const protectedRoutes: ReadonlyArray<[string, string]> = [
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["GET", `/api/projects/${projectA.projectId}`],
      ["GET", `/api/projects/${projectA.projectId}/resources`],
      [
        "GET",
        `/api/projects/${projectA.projectId}/resources/${projectA.resourceId}`,
      ],
      [
        "PUT",
        `/api/projects/${projectA.projectId}/resources/${projectA.resourceId}`,
      ],
      [
        "POST",
        `/api/projects/${projectA.projectId}/resources/${projectA.resourceId}/move`,
      ],
      [
        "DELETE",
        `/api/projects/${projectA.projectId}/resources/${projectA.resourceId}`,
      ],
      ["DELETE", `/api/projects/${projectA.projectId}`],
    ];

    for (const [method, url] of protectedRoutes) {
      const response = await router.handle(
        request(method, url, {
          body: { content: "x", expectedRevision: 1, path: "x.seq" },
        }),
      );
      const body = response.body === "" ? null : JSON.parse(response.body);
      expect(response.status).toBe(401);
      expect(body.error.code).toBe("unauthorized");
      expect(response.headers.map((header) => header.name)).toContain(
        "www-authenticate",
      );
    }

    // The anonymous attempts left Project A exactly as it was.
    const intact = await call(
      "GET",
      `/api/projects/${projectA.projectId}/resources/${projectA.resourceId}`,
      { cookie: projectA.owner.cookie },
    );
    expect(intact.status).toBe(200);
    expect(intact.body.content).toBe(SECRET_A);
    expect(intact.body.resource.revision).toBe(1);
  });
});
