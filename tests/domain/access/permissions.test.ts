/**
 * The capability vocabulary.
 *
 * These tests pin the two properties the authorization work depends on: a role
 * is interpreted in exactly one place, and every credential mechanism maps onto
 * the same permission set before any use case sees it.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILES,
  ALL_PERMISSIONS,
  ALL_PROJECT_ROLES,
  OAUTH_SCOPE_TO_PERMISSION,
  PERMISSIONS_BY_ROLE,
  isPermission,
  isProjectRole,
  permissionsOfOAuthScopes,
  permissionsOfRole,
} from "../../../src/domain/access/permissions";

describe("role permissions", () => {
  it("gives every role a distinct, non-empty capability set", () => {
    const sets = ALL_PROJECT_ROLES.map(
      (role) => new Set(PERMISSIONS_BY_ROLE[role]),
    );
    for (const set of sets) expect(set.size).toBeGreaterThan(0);
    expect(sets[0].size).toBeGreaterThan(sets[1].size);
    expect(sets[1].size).toBeGreaterThan(sets[2].size);
  });

  it("lets a viewer read but not write", () => {
    const viewer = permissionsOfRole("VIEWER");
    expect(viewer).toContain("resource:read");
    expect(viewer).not.toContain("resource:write");
    expect(viewer).not.toContain("project:write");
    expect(viewer).not.toContain("project:admin");
  });

  it("lets an editor write resources but not administer the project", () => {
    const editor = permissionsOfRole("EDITOR");
    expect(editor).toContain("resource:write");
    expect(editor).toContain("project:write");
    expect(editor).not.toContain("project:admin");
  });

  it("reserves project:admin for an owner", () => {
    const owners = ALL_PROJECT_ROLES.filter((role) =>
      PERMISSIONS_BY_ROLE[role].includes("project:admin"),
    );
    expect(owners).toEqual(["OWNER"]);
  });

  it("returns a fresh array, so a caller cannot mutate the table", () => {
    const first = permissionsOfRole("VIEWER");
    first.push("project:admin");
    expect(permissionsOfRole("VIEWER")).not.toContain("project:admin");
  });

  it("gives every role the read capabilities a listing needs", () => {
    for (const role of ALL_PROJECT_ROLES) {
      expect(PERMISSIONS_BY_ROLE[role]).toContain("project:read");
      expect(PERMISSIONS_BY_ROLE[role]).toContain("resource:read");
      expect(PERMISSIONS_BY_ROLE[role]).toContain("diagram:render");
    }
  });
});

describe("agent profiles", () => {
  it("keeps a read-only agent unable to write", () => {
    const scopes = AGENT_PROFILES.READ_ONLY_AGENT;
    expect(scopes).toContain("mcp:read");
    expect(scopes).not.toContain("mcp:write");
    expect(scopes).not.toContain("resource:write");
  });

  it("lets a documentation agent write documents but not administer", () => {
    const scopes = AGENT_PROFILES.DOCUMENTATION_AGENT;
    expect(scopes).toContain("resource:write");
    expect(scopes).not.toContain("project:admin");
    expect(scopes).not.toContain("project:write");
  });

  it("makes the only administrative profile explicit", () => {
    expect(AGENT_PROFILES.PROJECT_ADMIN).toEqual(ALL_PERMISSIONS);
  });
});

describe("vocabulary guards", () => {
  it("recognises permissions and roles and rejects anything else", () => {
    expect(isPermission("resource:write")).toBe(true);
    expect(isPermission("resource:destroy")).toBe(false);
    expect(isPermission(42)).toBe(false);
    expect(isProjectRole("EDITOR")).toBe(true);
    expect(isProjectRole("editor")).toBe(false);
  });
});

describe("OAuth scope mapping", () => {
  it("maps the docs.* namespace onto application permissions", () => {
    expect(
      permissionsOfOAuthScopes(["docs.resources.read", "docs.resources.write"]),
    ).toEqual(["resource:read", "resource:write"]);
  });

  it("drops unknown scopes instead of widening access", () => {
    expect(permissionsOfOAuthScopes(["docs.projects.admin", "openid"])).toEqual(
      ["project:admin"],
    );
  });

  it("keeps every mapped target inside the permission vocabulary", () => {
    for (const permission of Object.values(OAUTH_SCOPE_TO_PERMISSION)) {
      expect(ALL_PERMISSIONS).toContain(permission);
    }
  });

  it("does not map any OAuth scope onto a role-shaped value", () => {
    for (const key of Object.keys(OAUTH_SCOPE_TO_PERMISSION)) {
      expect(isProjectRole(key)).toBe(false);
    }
  });
});
