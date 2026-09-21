/**
 * The capability vocabulary.
 *
 * These tests pin the two properties the authorization work depends on: a role
 * is interpreted in exactly one place, and every credential mechanism maps onto
 * the same permission set before any use case sees it.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  ALL_PROJECT_ROLES,
  ADMIN_PERMISSIONS,
  CREDENTIAL_PROFILES,
  CREDENTIAL_SCOPES,
  DEFAULT_CREDENTIAL_SCOPES,
  OAUTH_SCOPE_TO_PERMISSION,
  PERMISSIONS_BY_ROLE,
  RESOURCE_WRITE_SCOPE,
  isCredentialScope,
  isPermission,
  isProjectRole,
  permissionsOfCredentialScopes,
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
    expect(viewer).not.toContain("resource:create");
    expect(viewer).not.toContain("resource:update");
    expect(viewer).not.toContain("project:create");
    expect(viewer).not.toContain("project:delete");
  });

  it("lets an editor write resources but not administer the project", () => {
    const editor = permissionsOfRole("EDITOR");
    expect(editor).toContain("resource:update");
    expect(editor).toContain("resource:delete");
    expect(editor).not.toContain("project:delete");
    expect(editor).not.toContain("project:members:write");
    expect(editor).not.toContain("agent:manage");
    expect(editor).not.toContain("credential:manage");
  });

  it("reserves the administrative capabilities for an owner", () => {
    for (const permission of ADMIN_PERMISSIONS) {
      const holders = ALL_PROJECT_ROLES.filter((role) =>
        PERMISSIONS_BY_ROLE[role].includes(permission),
      );
      expect(holders).toEqual(["OWNER"]);
    }
  });

  it("returns a fresh array, so a caller cannot mutate the table", () => {
    const first = permissionsOfRole("VIEWER");
    first.push("project:delete");
    expect(permissionsOfRole("VIEWER")).not.toContain("project:delete");
  });

  it("gives every role the read capabilities a listing needs", () => {
    for (const role of ALL_PROJECT_ROLES) {
      expect(PERMISSIONS_BY_ROLE[role]).toContain("project:read");
      expect(PERMISSIONS_BY_ROLE[role]).toContain("resource:read");
      expect(PERMISSIONS_BY_ROLE[role]).toContain("diagram:render");
    }
  });
});

describe("credential scopes", () => {
  it("keeps the read-only profile unable to change anything", () => {
    const permissions = permissionsOfCredentialScopes(
      DEFAULT_CREDENTIAL_SCOPES,
    );
    expect(permissions).toContain("project:read");
    expect(permissions).toContain("resource:read");
    expect(permissions).not.toContain("resource:create");
    expect(permissions).not.toContain("resource:update");
    expect(permissions).not.toContain("resource:delete");
    expect(permissions).not.toContain("project:delete");
  });

  it("offers no administrative scope by default", () => {
    for (const permission of ADMIN_PERMISSIONS) {
      expect(DEFAULT_CREDENTIAL_SCOPES).not.toContain(permission);
    }
  });

  it("expands resource:write into the four resource mutations", () => {
    expect(permissionsOfCredentialScopes([RESOURCE_WRITE_SCOPE])).toEqual([
      "resource:create",
      "resource:update",
      "resource:move",
      "resource:delete",
    ]);
  });

  it("lets a documentation profile write but not administer", () => {
    const permissions = permissionsOfCredentialScopes(
      CREDENTIAL_PROFILES.DOCUMENTATION,
    );
    expect(permissions).toContain("resource:update");
    expect(permissions).not.toContain("project:delete");
    expect(permissions).not.toContain("agent:manage");
  });

  it("drops an unknown scope instead of widening access", () => {
    expect(
      permissionsOfCredentialScopes(["resource:read", "resource:destroy"]),
    ).toEqual(["resource:read"]);
  });
});

describe("vocabulary guards", () => {
  it("recognises permissions and roles and rejects anything else", () => {
    expect(isPermission("resource:update")).toBe(true);
    expect(isPermission("resource:destroy")).toBe(false);
    expect(isPermission(42)).toBe(false);
    expect(isProjectRole("EDITOR")).toBe(true);
    expect(isProjectRole("editor")).toBe(false);
  });

  it("recognises the credential shorthand as a scope but not a permission", () => {
    expect(isCredentialScope(RESOURCE_WRITE_SCOPE)).toBe(true);
    expect(isCredentialScope("resource:read")).toBe(true);
    expect(isCredentialScope("nope")).toBe(false);
    expect(isPermission(RESOURCE_WRITE_SCOPE)).toBe(false);
    expect(CREDENTIAL_SCOPES).toContain(RESOURCE_WRITE_SCOPE);
  });
});

describe("OAuth scope mapping", () => {
  it("maps the docs.* namespace onto application permissions", () => {
    expect(
      permissionsOfOAuthScopes(["docs.resources.read", "docs.resources.write"]),
    ).toEqual(["resource:read", "resource:update"]);
  });

  it("drops unknown scopes instead of widening access", () => {
    expect(
      permissionsOfOAuthScopes(["docs.projects.unknown", "openid"]),
    ).toEqual([]);
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
