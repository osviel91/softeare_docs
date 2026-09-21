/**
 * The authorization model (ADR-042).
 *
 * The decision function is tested exhaustively, because it is small enough to be
 * and because everything else depends on it being right. The policy is tested for
 * the three properties the mission cares about: a viewer cannot write, an editor
 * cannot administer, and a principal the policy cannot resolve is refused rather
 * than admitted.
 */
import { describe, expect, it } from "vitest";
import {
  authorize,
  grantedPermissions,
  roleAllows,
} from "../../src/domain/access/authorize";
import {
  ALL_PERMISSIONS,
  ALL_PROJECT_ROLES,
  PERMISSIONS_BY_ROLE,
  type Permission,
  type ProjectRole,
} from "../../src/domain/access/permissions";
import {
  createAuthorizationPolicy,
  credentialAllowsProject,
  restrictionOf,
} from "../../src/application/authorization";
import { ApplicationError } from "../../src/application/errors";
import type { ApplicationContext } from "../../src/application/context";

/** A context for a user with no credential restriction. */
function contextFor(
  userId: string,
  projectIds?: readonly string[],
): ApplicationContext {
  return {
    requestId: "req-1",
    principal: {
      userId,
      authType: "session",
      scopes: ALL_PERMISSIONS,
      ...(projectIds === undefined ? {} : { projectIds }),
    },
  };
}

/** A repository stub with one project and one membership. */
function repository(options: {
  projectId?: string;
  members?: Record<string, ProjectRole>;
  fail?: boolean;
}) {
  const projectId = options.projectId ?? "p1";
  const members = options.members ?? { u1: "OWNER" };
  return {
    async findById(id: string) {
      if (options.fail) throw new Error("database unavailable");
      return id === projectId ? { id } : null;
    },
    async roleOf(id: string, userId: string) {
      if (options.fail) throw new Error("database unavailable");
      if (id !== projectId) return null;
      return members[userId] ?? null;
    },
  };
}

describe("authorize", () => {
  it("allows exactly the permissions the role grants", () => {
    for (const role of ALL_PROJECT_ROLES) {
      for (const permission of ALL_PERMISSIONS) {
        const decision = authorize({ role, required: permission });
        expect(decision.allowed).toBe(roleAllows(role, permission));
        if (!decision.allowed) expect(decision.missing).toBe(permission);
      }
    }
  });

  it("refuses every permission when the caller has no role", () => {
    for (const permission of ALL_PERMISSIONS) {
      const decision = authorize({ role: null, required: permission });
      expect(decision.allowed).toBe(false);
    }
  });

  it("never allows an administrative permission to a viewer or an editor", () => {
    for (const role of ["VIEWER", "EDITOR"] as const) {
      expect(authorize({ role, required: "project:admin" }).allowed).toBe(
        false,
      );
    }
    expect(
      authorize({ role: "OWNER", required: "project:admin" }).allowed,
    ).toBe(true);
  });

  it("keeps a viewer read-only", () => {
    for (const permission of ["resource:write", "project:write"] as const) {
      expect(authorize({ role: "VIEWER", required: permission }).allowed).toBe(
        false,
      );
    }
    for (const permission of [
      "project:read",
      "resource:read",
      "diagram:render",
      "project:validate",
      "project:export",
    ] as const) {
      expect(authorize({ role: "VIEWER", required: permission }).allowed).toBe(
        true,
      );
    }
  });

  it("exposes what a role grants, without a second table", () => {
    for (const role of ALL_PROJECT_ROLES) {
      expect(grantedPermissions(role)).toEqual(PERMISSIONS_BY_ROLE[role]);
    }
  });
});

describe("credential restriction", () => {
  it("treats an absent or empty list as unrestricted", () => {
    expect(restrictionOf(contextFor("u1").principal)).toBeNull();
    expect(restrictionOf(contextFor("u1", []).principal)).toBeNull();
    expect(credentialAllowsProject(contextFor("u1").principal, "p1")).toBe(
      true,
    );
  });

  it("narrows a restricted credential to its projects", () => {
    const principal = contextFor("u1", ["p1"]).principal;
    expect(credentialAllowsProject(principal, "p1")).toBe(true);
    expect(credentialAllowsProject(principal, "p2")).toBe(false);
  });
});

describe("the policy", () => {
  it("grants a member the permissions their role carries", async () => {
    const policy = createAuthorizationPolicy(
      repository({ members: { u1: "EDITOR" } }),
    );
    const outcome = await policy.decide(
      contextFor("u1"),
      "p1",
      "resource:write",
    );
    // An allowed outcome also hands back the project it resolved, so a use case
    // does not read the same row twice.
    expect(outcome).toMatchObject({ allowed: true, role: "EDITOR" });
    expect(outcome.allowed && outcome.project.id).toBe("p1");
  });

  it("refuses a viewer's write with `forbidden`, distinguishing it from invisible", async () => {
    const policy = createAuthorizationPolicy(
      repository({ members: { u1: "VIEWER" } }),
    );
    const outcome = await policy.decide(
      contextFor("u1"),
      "p1",
      "resource:write",
    );
    expect(outcome).toEqual({
      allowed: false,
      reason: "forbidden",
      role: "VIEWER",
      missing: "resource:write",
    });
    await expect(
      policy.requirePermission(contextFor("u1"), "p1", "resource:write"),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("reports a project the principal is not a member of as not found", async () => {
    const policy = createAuthorizationPolicy(
      repository({ members: { u2: "OWNER" } }),
    );
    const outcome = await policy.decide(contextFor("u1"), "p1", "project:read");
    expect(outcome).toEqual({
      allowed: false,
      reason: "not_found",
      role: null,
      missing: "project:read",
    });
    await expect(
      policy.requirePermission(contextFor("u1"), "p1", "project:read"),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("reports a restricted credential's other project as not found, not forbidden", async () => {
    const policy = createAuthorizationPolicy(
      repository({ members: { u1: "OWNER" } }),
    );
    const restricted = contextFor("u1", ["p-other"]);
    const outcome = await policy.decide(restricted, "p1", "project:read");
    expect(outcome).toEqual({
      allowed: false,
      reason: "restricted",
      role: null,
      missing: "project:read",
    });
    // The message must not reveal that the project exists.
    try {
      await policy.requirePermission(restricted, "p1", "project:read");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).message).toBe(
        "No project with id p1.",
      );
    }
  });

  it("refuses a credential that does not carry the permission, whatever the role", async () => {
    // The read-only agent case: an OWNER in the project, but the token itself was
    // never granted a write capability.
    const policy = createAuthorizationPolicy(
      repository({ members: { u1: "OWNER" } }),
    );
    const readOnly = contextFor("u1");
    const restricted = {
      ...readOnly,
      principal: {
        ...readOnly.principal,
        authType: "pat" as const,
        scopes: ["resource:read", "project:read"] as const,
      },
    };
    const outcome = await policy.decide(restricted, "p1", "resource:write");
    expect(outcome).toEqual({
      allowed: false,
      reason: "scope",
      role: null,
      missing: "resource:write",
    });
    await expect(
      policy.requirePermission(restricted, "p1", "resource:write"),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });

    // The same credential may still read.
    expect(
      (await policy.decide(restricted, "p1", "resource:read")).allowed,
    ).toBe(true);
  });

  it("checks the credential before membership, so a token cannot probe projects", async () => {
    const policy = createAuthorizationPolicy(repository({ members: {} }));
    const readOnly = contextFor("u1");
    const restricted = {
      ...readOnly,
      principal: {
        ...readOnly.principal,
        authType: "pat" as const,
        scopes: ["resource:read"] as const,
      },
    };
    const outcome = await policy.decide(restricted, "p1", "resource:write");
    expect(outcome.allowed).toBe(false);
    expect(outcome.allowed === false && outcome.reason).toBe("scope");
  });

  it("fails closed when membership cannot be read", async () => {
    const policy = createAuthorizationPolicy(repository({ fail: true }));
    const outcome = await policy.decide(
      contextFor("u1"),
      "p1",
      "resource:write",
    );
    expect(outcome.allowed).toBe(false);
    await expect(
      policy.requirePermission(contextFor("u1"), "p1", "resource:write"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a project that does not exist", async () => {
    const policy = createAuthorizationPolicy(repository({}));
    await expect(
      policy.requirePermission(contextFor("u1"), "missing", "project:read"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers hasRole without throwing", async () => {
    const policy = createAuthorizationPolicy(
      repository({ members: { u1: "OWNER" } }),
    );
    expect(await policy.hasRole(contextFor("u1"), "p1", ["OWNER"])).toBe(true);
    expect(await policy.hasRole(contextFor("u1"), "p1", ["EDITOR"])).toBe(
      false,
    );
    expect(await policy.hasRole(contextFor("u1"), "missing", ["OWNER"])).toBe(
      false,
    );
    expect(
      await policy.hasRole(contextFor("u1", ["p-other"]), "p1", ["OWNER"]),
    ).toBe(false);
  });

  it("accepts an injected policy, so a use case cannot smuggle in its own rule", async () => {
    const seen: Array<{ projectId: string; permission: Permission }> = [];
    const policy = createAuthorizationPolicy(repository({}));
    const wrapper = {
      ...policy,
      async requirePermission(
        _context: ApplicationContext,
        projectId: string,
        permission: Permission,
      ) {
        seen.push({ projectId, permission });
        return { allowed: true as const, role: "OWNER" as ProjectRole };
      },
    };
    const outcome = await wrapper.requirePermission(
      contextFor("u1"),
      "p1",
      "project:admin",
    );
    expect(outcome.role).toBe("OWNER");
    expect(seen).toEqual([{ projectId: "p1", permission: "project:admin" }]);
  });
});
