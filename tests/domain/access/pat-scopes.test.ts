/**
 * The personal-access-token scope model (Phase 5, mission item 4).
 *
 * The scope vocabulary is small on purpose, so the interesting assertions are
 * about *composition*: which fine-grained permissions a coarse scope expands to,
 * and — the security question — that a read-only token is refused a write even
 * when its owner's role would allow one.
 */
import { describe, expect, it } from "vitest";
import {
  PAT_SCOPES,
  permissionsOfPatScopes,
  isPatScope,
} from "../../../src/domain/access/permissions";
import { credentialGrants } from "../../../src/application/authorization";
import type { Principal } from "../../../src/application/context";

/** A principal carrying exactly the permissions the given scopes expand to. */
function principalWith(scopes: readonly string[]): Principal {
  return {
    userId: "user-1",
    authType: "pat",
    scopes: permissionsOfPatScopes(scopes),
  };
}

describe("PAT scope vocabulary", () => {
  it("is exactly two coarse scopes", () => {
    expect([...PAT_SCOPES]).toEqual(["projects:read", "projects:write"]);
  });

  it("knows only its own scope names", () => {
    expect(isPatScope("projects:read")).toBe(true);
    expect(isPatScope("projects:write")).toBe(true);
    expect(isPatScope("resource:write")).toBe(false);
    expect(isPatScope("")).toBe(false);
    expect(isPatScope(undefined)).toBe(false);
  });
});

describe("scope expansion", () => {
  it("gives projects:read the reading permissions and no writing ones", () => {
    const permissions = permissionsOfPatScopes(["projects:read"]);
    expect(permissions).toContain("project:read");
    expect(permissions).toContain("resource:read");
    expect(permissions).toContain("mcp:read");
    expect(permissions).not.toContain("resource:write");
    expect(permissions).not.toContain("project:write");
    expect(permissions).not.toContain("mcp:write");
  });

  it("never grants project:admin, even with projects:write", () => {
    expect(permissionsOfPatScopes(["projects:write"])).not.toContain(
      "project:admin",
    );
  });

  it("makes projects:write a superset of projects:read", () => {
    const read = new Set(permissionsOfPatScopes(["projects:read"]));
    const write = new Set(permissionsOfPatScopes(["projects:write"]));
    for (const permission of read) expect(write.has(permission)).toBe(true);
    expect(write.has("resource:write")).toBe(true);
  });

  it("deduplicates permissions when both scopes are granted", () => {
    const permissions = permissionsOfPatScopes([
      "projects:read",
      "projects:write",
    ]);
    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it("drops an unknown scope rather than inventing a permission", () => {
    const permissions = permissionsOfPatScopes([
      "projects:read",
      "resource:admin",
    ]);
    expect(permissions).toContain("project:read");
    expect(permissions).not.toContain("resource:admin");
  });
});

describe("a read-only credential cannot write", () => {
  it("does not carry the capability the policy checks for a write", () => {
    const principal = principalWith(["projects:read"]);
    expect(credentialGrants(principal, "resource:read")).toBe(true);
    expect(credentialGrants(principal, "resource:write")).toBe(false);
    expect(credentialGrants(principal, "project:admin")).toBe(false);
  });

  it("does carry the write capability with projects:write", () => {
    const principal = principalWith(["projects:write"]);
    expect(credentialGrants(principal, "resource:write")).toBe(true);
  });
});
