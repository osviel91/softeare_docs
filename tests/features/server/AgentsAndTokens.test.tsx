/**
 * The agents and access-token screen (ADR-043, Phase 5E).
 *
 * The security-relevant claims are asserted here rather than only in the API
 * suite: the plaintext is shown once and never stored, rotation surfaces a new
 * secret, the example MCP configuration carries a placeholder instead of the
 * real token, and revoking takes an explicit confirmation.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerApiClient } from "../../../src/workspace/server/api-client";
import AgentsAndTokens from "../../../src/features/server/AgentsAndTokens";
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
const ROTATED = "sdm_pat_fedcba9876543210.ROTATEDSECRETalsoNeverPersist";

const AGENT = {
  id: "a1",
  name: "Hermes Documentation",
  description: "Maintains the docs.",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  disabledAt: null,
  disabled: false,
  credentialCount: 1,
  activeCredentialCount: 1,
};

function credentialRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    agentId: "a1",
    name: "MacMini",
    prefix: "0123456789abcdef",
    scopes: ["project:read", "resource:read"],
    allowedProjectIds: null,
    createdAt: new Date(0).toISOString(),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    status: "active",
    ...overrides,
  };
}

/** A fake agents API, plus the requests it saw. */
function fakeApi(
  projects = [
    {
      id: "p1",
      workspaceId: "w1",
      name: "OSIRIS",
      slug: "osiris",
      ownerId: "u1",
      role: "OWNER",
      resourceCount: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ],
) {
  const calls: string[] = [];
  const bodies: { path: string; body: unknown }[] = [];
  let revoked = false;
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://app.test");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    if (typeof init?.body === "string") {
      bodies.push({ path: url.pathname, body: JSON.parse(init.body) });
    }
    if (url.pathname === "/api/agents" && method === "GET") {
      return reply(200, {
        agents: [AGENT],
        scopes: [
          "project:read",
          "resource:read",
          "resource:write",
          "diagram:render",
          "project:search",
          "project:validate",
        ],
        defaultScopes: [
          "project:read",
          "resource:read",
          "diagram:render",
          "project:search",
          "project:validate",
        ],
      });
    }
    if (url.pathname === "/api/agents" && method === "POST") {
      return reply(201, { agent: AGENT });
    }
    if (url.pathname === "/api/agents/a1/credentials" && method === "GET") {
      return reply(200, {
        credentials: [
          credentialRecord(
            revoked
              ? { status: "revoked", revokedAt: new Date(0).toISOString() }
              : {},
          ),
        ],
        scopes: ["project:read", "resource:read", "resource:write"],
        defaultScopes: ["project:read", "resource:read"],
      });
    }
    if (url.pathname === "/api/agents/a1/credentials" && method === "POST") {
      return reply(201, { secret: SECRET, credential: credentialRecord() });
    }
    if (
      url.pathname === "/api/agents/a1/credentials/c1/rotate" &&
      method === "POST"
    ) {
      return reply(201, {
        secret: ROTATED,
        credential: credentialRecord({ id: "c2" }),
        replacedCredentialId: "c1",
      });
    }
    if (
      url.pathname === "/api/agents/a1/credentials/c1" &&
      method === "DELETE"
    ) {
      revoked = true;
      return reply(204);
    }
    if (url.pathname === "/api/agents/a1" && method === "DELETE") {
      return reply(200, {
        agent: {
          ...AGENT,
          disabled: true,
          disabledAt: new Date(0).toISOString(),
        },
      });
    }
    if (url.pathname === "/api/agents/a1/enable" && method === "POST") {
      return reply(200, { agent: AGENT });
    }
    if (url.pathname === "/api/projects") {
      return reply(200, { projects });
    }
    if (url.pathname === "/api/workspaces") {
      return reply(200, {
        workspaces: [
          {
            id: "w1",
            ownerId: "u1",
            name: "Personal",
            isDefault: true,
            role: "ADMIN",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      });
    }
    return reply(404, { error: { code: "not_found" } });
  };
  return { fetch, calls, bodies, isRevoked: () => revoked };
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

function setup(api: ReturnType<typeof fakeApi>, auth: AuthHook = session()) {
  const client = new ServerApiClient({ fetch: api.fetch });
  return render(
    <AgentsAndTokens client={client} auth={auth} onBack={() => {}} />,
  );
}

/** Expand the one agent's credential panel. */
async function expandAgent(): Promise<void> {
  await screen.findByTestId("agent-a1");
  await userEvent.click(screen.getByTestId("agent-credentials-a1"));
  await screen.findByTestId("agent-credentials-panel-a1");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agents screen", () => {
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
    await userEvent.click(screen.getByTestId("agents-signin"));
    expect(auth.signIn).toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it("lists agents with their status and credential counts", async () => {
    const api = fakeApi();
    setup(api);
    expect(await screen.findByTestId("agent-name-a1")).toHaveTextContent(
      "Hermes Documentation",
    );
    expect(screen.getByTestId("agent-status-a1")).toHaveTextContent("active");
    expect(screen.getByTestId("agent-a1")).toHaveTextContent("1 credentials");
  });

  it("creates an agent", async () => {
    const api = fakeApi();
    setup(api);
    await screen.findByTestId("agent-a1");
    await userEvent.click(screen.getByTestId("agent-create"));
    await waitFor(() => expect(api.calls).toContain("POST /api/agents"));
  });

  it("lists credential metadata and never a secret", async () => {
    const api = fakeApi();
    setup(api);
    await expandAgent();
    expect(screen.getByTestId("credential-c1")).toHaveTextContent("MacMini");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("shows that an unrestricted credential inherits all server projects", async () => {
    const api = fakeApi();
    setup(api);
    await expandAgent();
    expect(
      screen.getByTestId("credential-project-access-c1"),
    ).toHaveTextContent("All accessible server projects");
  });

  it("explains server-project access when none exist", async () => {
    const api = fakeApi([]);
    setup(api);
    await expandAgent();
    expect(
      await screen.findByTestId("credential-projects-empty"),
    ).toHaveTextContent(
      "Local browser and folder projects are not available to remote MCP",
    );
  });

  it("restricts a new credential to selected server projects", async () => {
    const api = fakeApi();
    setup(api);
    await expandAgent();
    await userEvent.click(screen.getByTestId("credential-project-p1"));
    await userEvent.click(screen.getByTestId("credential-create-a1"));
    await screen.findByTestId("credential-secret");
    expect(api.bodies).toContainEqual({
      path: "/api/agents/a1/credentials",
      body: expect.objectContaining({ allowedProjectIds: ["p1"] }),
    });
  });

  it("creates a credential, shows the secret once and copies it", async () => {
    const api = fakeApi();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setup(api);
    await expandAgent();

    await userEvent.click(screen.getByTestId("credential-create-a1"));
    const secret = await screen.findByTestId("credential-secret");
    expect(secret).toHaveValue(SECRET);

    await userEvent.click(screen.getByTestId("credential-copy"));
    expect(writeText).toHaveBeenCalledWith(SECRET);

    await userEvent.click(screen.getByTestId("credential-dismiss"));
    await waitFor(() =>
      expect(screen.queryByTestId("credential-secret")).toBeNull(),
    );
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("never persists the plaintext in storage or the URL", async () => {
    const api = fakeApi();
    setup(api);
    await expandAgent();
    await userEvent.click(screen.getByTestId("credential-create-a1"));
    await screen.findByTestId("credential-secret");

    expect(window.localStorage?.length ?? 0).toBe(0);
    expect(window.sessionStorage?.length ?? 0).toBe(0);
    expect(window.location.href).not.toContain(SECRET);
  });

  it("rotates a credential and shows the replacement secret", async () => {
    const api = fakeApi();
    setup(api);
    await expandAgent();
    await userEvent.click(screen.getByTestId("credential-rotate-c1"));
    const secret = await screen.findByTestId("credential-secret");
    expect(secret).toHaveValue(ROTATED);
    expect(api.calls).toContain("POST /api/agents/a1/credentials/c1/rotate");
  });

  it("revokes only after an explicit confirmation", async () => {
    const api = fakeApi();
    setup(api);
    await expandAgent();
    await userEvent.click(screen.getByTestId("credential-revoke-c1"));
    expect(api.isRevoked()).toBe(false);
    await userEvent.click(screen.getByTestId("credential-revoke-confirm-c1"));
    await waitFor(() => expect(api.isRevoked()).toBe(true));
    expect(api.calls).toContain("DELETE /api/agents/a1/credentials/c1");
  });

  it("disables an agent, invalidating all of its credentials", async () => {
    const api = fakeApi();
    setup(api);
    await screen.findByTestId("agent-a1");
    await userEvent.click(screen.getByTestId("agent-toggle-a1"));
    await waitFor(() => expect(api.calls).toContain("DELETE /api/agents/a1"));
  });

  it("shows the remote MCP endpoint with a placeholder, never a token", async () => {
    const api = fakeApi();
    setup(api);
    await screen.findByTestId("agent-a1");
    expect(screen.getByTestId("mcp-endpoint").textContent).toMatch(/\/mcp$/);
    const example = screen.getByTestId("mcp-config-example").textContent ?? "";
    expect(example).toContain("<YOUR_PAT>");
    expect(example).not.toContain(SECRET);
  });
});
