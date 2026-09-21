/**
 * The server-workspace hooks (Phase 4A).
 *
 * `useAuth` decides whether the app may offer server projects at all, and
 * `useServerWorkspaces` decides which one the editor is bound to. Both are
 * security-relevant rather than cosmetic: a viewer's repository must be
 * genuinely read-only, and losing the session must close whatever it had open.
 * These are the properties asserted here.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ServerApiClient } from "../../../src/workspace/server/api-client";
import { useAuth } from "../../../src/features/server/use-auth";
import type { AuthState } from "../../../src/features/server/use-auth";
import { useServerWorkspaces } from "../../../src/features/server/use-server-workspaces";
import { supportsForcedWrite } from "../../../src/workspace/server/server-workspace-repository";

/** A response the client can read. */
function reply(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? "" : JSON.stringify(body);
    },
  } as unknown as Response;
}

/** The project every listing serves. */
const PROJECT = {
  id: "p1",
  name: "Payments",
  slug: "payments",
  ownerId: "u1",
  role: "OWNER",
  resourceCount: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/** What the fake API should answer with. */
interface FakeOptions {
  signedIn?: boolean;
  /** What `/access` grants; defaults to a full writer. */
  permissions?: string[];
  /** Make `/api/me` fail, as an unreachable API would. */
  meFails?: boolean;
  /** Make `/api/projects` fail. */
  listFails?: boolean;
}

/** A fake API as a `fetch`, plus the recorded requests. */
function fakeApi(options: FakeOptions = {}) {
  const calls: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://app.test");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
    if (url.pathname === "/api/me") {
      if (options.meFails) throw new Error("ECONNREFUSED");
      return reply(200, {
        user: options.signedIn
          ? {
              id: "u1",
              displayName: "Ada",
              email: null,
              authType: "session",
              scopes: [],
            }
          : null,
      });
    }
    if (url.pathname === "/api/projects" && (init?.method ?? "GET") === "GET") {
      if (options.listFails) return reply(500, { error: { code: "internal" } });
      return reply(200, { projects: options.signedIn ? [PROJECT] : [] });
    }
    if (url.pathname === "/api/projects" && init?.method === "POST") {
      return reply(201, { project: PROJECT });
    }
    if (url.pathname === "/api/projects/p1/access") {
      return reply(200, {
        projectId: "p1",
        role: "OWNER",
        permissions: options.permissions ?? ["project:read", "resource:update"],
      });
    }
    if (url.pathname === "/auth/logout") return reply(204);
    return reply(404, { error: { code: "not_found" } });
  };
  return { fetch, calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("useAuth", () => {
  it("reports loading before it reports anonymous", async () => {
    const api = fakeApi();
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useAuth(client));

    expect(result.current.status).toBe("loading");
    await waitFor(() => {
      expect(result.current.status).toBe("anonymous");
    });
    expect(result.current.user).toBeNull();
  });

  it("reports the signed-in user", async () => {
    const api = fakeApi({ signedIn: true });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useAuth(client));

    await waitFor(() => {
      expect(result.current.status).toBe("authenticated");
    });
    expect(result.current.user?.displayName).toBe("Ada");
  });

  it("treats an unreachable API as anonymous rather than as a broken app", async () => {
    const api = fakeApi({ meFails: true });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useAuth(client));

    await waitFor(() => {
      expect(result.current.status).toBe("anonymous");
    });
  });

  it("revokes the session on sign-out and becomes anonymous", async () => {
    const api = fakeApi({ signedIn: true });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useAuth(client));
    await waitFor(() => {
      expect(result.current.status).toBe("authenticated");
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(api.calls).toContain("POST /auth/logout");
    expect(result.current.status).toBe("anonymous");
    expect(result.current.user).toBeNull();
  });
});

describe("useServerWorkspaces", () => {
  /** The authenticated auth state, as the hook receives it. */
  const signedIn = {
    status: "authenticated" as const,
    user: {
      id: "u1",
      displayName: "Ada",
      email: null,
      authType: "session",
      scopes: [],
    },
  };

  it("lists the caller's projects once authenticated", async () => {
    const api = fakeApi({ signedIn: true });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useServerWorkspaces(client, signedIn));

    await waitFor(() => {
      expect(result.current.projects).toHaveLength(1);
    });
    expect(result.current.projects[0].name).toBe("Payments");
  });

  it("reports a failed listing instead of an empty list", async () => {
    const api = fakeApi({ signedIn: true, listFails: true });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useServerWorkspaces(client, signedIn));

    await waitFor(() => {
      expect(result.current.projectsError).not.toBeNull();
    });
    expect(result.current.projects).toHaveLength(0);
  });

  it("opens a project into a writable repository when the role allows it", async () => {
    const api = fakeApi({ signedIn: true, permissions: ["resource:update"] });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useServerWorkspaces(client, signedIn));
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    await act(async () => {
      await result.current.openProject(PROJECT);
    });

    expect(result.current.active?.project.id).toBe("p1");
    expect(result.current.active?.writable).toBe(true);
    expect(supportsForcedWrite(result.current.active!.repository)).toBe(true);
  });

  it("opens a read-only repository when the role carries no write capability", async () => {
    const api = fakeApi({ signedIn: true, permissions: ["project:read"] });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useServerWorkspaces(client, signedIn));
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    await act(async () => {
      await result.current.openProject(PROJECT);
    });

    expect(result.current.active?.writable).toBe(false);
    // The policy is enforced by the repository, not only by hiding a button.
    const refused =
      await result.current.active!.repository.createEmptyDiagram("p1");
    expect(refused.ok).toBe(false);
  });

  it("creates a project and opens it", async () => {
    const api = fakeApi({ signedIn: true });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result } = renderHook(() => useServerWorkspaces(client, signedIn));

    await act(async () => {
      await result.current.createProject("Payments");
    });

    expect(api.calls).toContain("POST /api/projects");
    expect(result.current.active?.project.id).toBe("p1");
  });

  it("closes the open binding when the session ends", async () => {
    const api = fakeApi({ signedIn: true });
    const client = new ServerApiClient({ fetch: api.fetch });
    const { result, rerender } = renderHook(
      ({ auth }: { auth: AuthState }) => useServerWorkspaces(client, auth),
      { initialProps: { auth: signedIn as AuthState } },
    );
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    await act(async () => {
      await result.current.openProject(PROJECT);
    });
    expect(result.current.active).not.toBeNull();

    rerender({ auth: { status: "anonymous", user: null } });

    // A stale repository would keep issuing requests that can only fail, and
    // would leave one person's project on screen for the next person.
    await waitFor(() => {
      expect(result.current.active).toBeNull();
    });
    expect(result.current.projects).toHaveLength(0);
  });
});
