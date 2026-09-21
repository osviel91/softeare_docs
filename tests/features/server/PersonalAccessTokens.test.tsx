/**
 * The personal access token screen (Phase 5E).
 *
 * The security-relevant claims are asserted here rather than only in the API
 * suite: the plaintext is shown once and never stored, the example MCP
 * configuration carries a placeholder instead of the real token, and revoking
 * takes an explicit confirmation. The rest is ordinary UI behaviour.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerApiClient } from "../../../src/workspace/server/api-client";
import PersonalAccessTokens from "../../../src/features/server/PersonalAccessTokens";
import type { AuthHook } from "../../../src/features/server/use-auth";

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

const SECRET = "sdm_pat_0123456789abcdef.SECRETVALUEthatshouldneverpersist";

/** A token as the API renders it. */
function tokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "My agent",
    prefix: "0123456789abcdef",
    scopes: ["projects:read"],
    projectIds: null,
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revoked: false,
    ...overrides,
  };
}

/** A fake token API, plus the recorded requests. */
function fakeApi() {
  const calls: string[] = [];
  const revoked = new Set<string>();
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://app.test");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/tokens" && method === "GET") {
      return reply(200, {
        tokens: [
          tokenRecord(),
          tokenRecord({
            id: "t2",
            name: "Retired",
            revoked: true,
            revokedAt: new Date(0).toISOString(),
          }),
        ],
        scopes: ["projects:read", "projects:write"],
      });
    }
    if (url.pathname === "/api/tokens" && method === "POST") {
      return reply(201, { secret: SECRET, token: tokenRecord({ id: "t3" }) });
    }
    if (url.pathname === "/api/tokens/t1" && method === "DELETE") {
      revoked.add("t1");
      return reply(204);
    }
    if (url.pathname === "/api/tokens/t1" && method === "PATCH") {
      return reply(200, { token: tokenRecord({ name: "Renamed" }) });
    }
    return reply(404, { error: { code: "not_found" } });
  };
  return { fetch, calls, revoked };
}

/** An authenticated browser session. */
function session(): AuthHook {
  return {
    status: "authenticated",
    user: {
      id: "u1",
      displayName: "Ada",
      email: null,
      authType: "session",
      scopes: [],
    },
    signIn: vi.fn(),
    signOut: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  };
}

/** Build the component over a fake API. */
function setup(api: ReturnType<typeof fakeApi>, auth: AuthHook = session()) {
  const client = new ServerApiClient({ fetch: api.fetch });
  return render(
    <PersonalAccessTokens client={client} auth={auth} onBack={() => {}} />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("access token screen", () => {
  it("asks an anonymous visitor to sign in", async () => {
    const api = fakeApi();
    const auth: AuthHook = {
      status: "anonymous",
      user: null,
      signIn: vi.fn(),
      signOut: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    };
    setup(api, auth);
    await userEvent.click(screen.getByTestId("tokens-signin"));
    expect(auth.signIn).toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it("lists token metadata and never a secret", async () => {
    const api = fakeApi();
    setup(api);
    expect(await screen.findByTestId("token-name-t1")).toHaveTextContent(
      "My agent",
    );
    expect(screen.getByTestId("token-name-t2")).toHaveTextContent("revoked");
    // The retired token offers no revoke action.
    expect(screen.queryByTestId("token-revoke-t2")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("creates a token, shows the secret once and copies it", async () => {
    const api = fakeApi();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setup(api);

    await screen.findByTestId("token-name-t1");
    await userEvent.clear(screen.getByTestId("token-name"));
    await userEvent.type(screen.getByTestId("token-name"), "Docs agent");
    await userEvent.click(screen.getByTestId("token-scope-projects:write"));
    await userEvent.click(screen.getByTestId("token-create"));

    const secret = await screen.findByTestId("token-secret");
    expect(secret).toHaveValue(SECRET);

    await userEvent.click(screen.getByTestId("token-copy"));
    expect(writeText).toHaveBeenCalledWith(SECRET);

    // Dismissing removes it from the DOM for good.
    await userEvent.click(screen.getByTestId("token-dismiss"));
    await waitFor(() =>
      expect(screen.queryByTestId("token-secret")).toBeNull(),
    );
  });

  it("never persists the plaintext in storage or the URL", async () => {
    const api = fakeApi();
    setup(api);
    await screen.findByTestId("token-name-t1");
    await userEvent.click(screen.getByTestId("token-create"));
    await screen.findByTestId("token-secret");

    expect(window.localStorage?.length ?? 0).toBe(0);
    expect(window.sessionStorage?.length ?? 0).toBe(0);
    expect(window.location.href).not.toContain(SECRET);
    expect(JSON.stringify(window.localStorage ?? {})).not.toContain(SECRET);
    expect(JSON.stringify(window.sessionStorage ?? {})).not.toContain(SECRET);
  });

  it("revokes only after an explicit confirmation", async () => {
    const api = fakeApi();
    setup(api);
    await screen.findByTestId("token-name-t1");

    await userEvent.click(screen.getByTestId("token-revoke-t1"));
    // The first click arms the action; nothing has been sent yet.
    expect(api.revoked.has("t1")).toBe(false);
    await userEvent.click(screen.getByTestId("token-revoke-confirm-t1"));
    await waitFor(() => expect(api.revoked.has("t1")).toBe(true));
    expect(api.calls).toContain("DELETE /api/tokens/t1");
  });

  it("shows the remote MCP endpoint with a placeholder, never a token", async () => {
    const api = fakeApi();
    setup(api);
    await screen.findByTestId("token-name-t1");
    const endpoint = screen.getByTestId("mcp-endpoint");
    expect(endpoint.textContent).toMatch(/\/mcp$/);
    const example = screen.getByTestId("mcp-config-example").textContent ?? "";
    expect(example).toContain("<YOUR_PAT>");
    expect(example).not.toContain(SECRET);
  });
});
