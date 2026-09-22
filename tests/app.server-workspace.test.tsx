/**
 * The browser working against an authenticated server project (Phase 4A).
 *
 * The Playwright suite drives the same flow through a real browser, a real API
 * and a real identity provider — but it is slow, and it is the only place that
 * flow is exercised. This test runs the *shell* against a fake HTTP API in jsdom,
 * which is what lets it assert the things the E2E run cannot see: which request
 * the editor issued, with which `expectedRevision`, and what the conflict dialog
 * did to the buffer.
 *
 * The fake speaks the API's real envelopes, so the adapter and the client are the
 * production ones; only the socket is missing.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

/** The project the fake API serves. */
const PROJECT = {
  id: "p1",
  name: "Payments",
  slug: "payments",
  ownerId: "u1",
  role: "OWNER",
  resourceCount: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/** The one resource the fake API holds. */
interface FakeResource {
  id: string;
  projectId: string;
  path: string;
  type: "sequence-diagram" | "event-flow" | "markdown-document";
  revision: number;
  content: string;
}

/** What the fake API should answer with, per test. */
interface FakeState {
  signedIn: boolean;
  resources: Map<string, FakeResource>;
  /** Every request the shell made, for asserting the wire. */
  calls: Array<{ method: string; path: string; body: unknown }>;
  /** Answer the next write with a conflict at this revision, once. */
  conflictAt: number | null;
  /** Make the next write fail at the transport, as an offline browser would. */
  networkFails: boolean;
}

const state: FakeState = {
  signedIn: false,
  resources: new Map(),
  calls: [],
  conflictAt: null,
  networkFails: false,
};

/** A response the API client can read: it only uses `ok`, `status`, `text`. */
function reply(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? "" : JSON.stringify(body);
    },
  } as unknown as Response;
}

/** The error envelope the API uses. */
function refuse(status: number, code: string, details?: unknown): Response {
  return reply(status, {
    error: {
      code,
      message: `refused: ${code}`,
      ...(details === undefined ? {} : { details }),
    },
  });
}

/** The wire view of a resource. */
function view(resource: FakeResource) {
  return {
    id: resource.id,
    projectId: resource.projectId,
    path: resource.path,
    type: resource.type,
    revision: resource.revision,
  };
}

/** The fake API, as a `fetch` implementation. */
function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://app.test");
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
  state.calls.push({ method, path, body });

  if (path === "/api/me") {
    return Promise.resolve(
      reply(200, {
        user: state.signedIn
          ? {
              id: "u1",
              displayName: "Ada",
              email: "ada@example.test",
              authType: "session",
              scopes: [],
            }
          : null,
      }),
    );
  }
  if (path === "/api/projects") {
    return Promise.resolve(
      reply(200, { projects: state.signedIn ? [PROJECT] : [] }),
    );
  }
  if (path === "/api/projects/p1/access") {
    return Promise.resolve(
      reply(200, {
        projectId: "p1",
        role: "OWNER",
        permissions: [
          "project:read",
          "resource:read",
          "resource:update",
          "project:delete",
        ],
      }),
    );
  }
  if (path === "/api/projects/p1/resources") {
    return Promise.resolve(
      reply(200, { resources: [...state.resources.values()].map(view) }),
    );
  }
  const one = /^\/api\/projects\/p1\/resources\/([^/]+)$/.exec(path);
  if (one) {
    const resource = state.resources.get(one[1]);
    if (!resource) return Promise.resolve(refuse(404, "not_found"));
    if (method === "GET") {
      return Promise.resolve(
        reply(200, { resource: view(resource), content: resource.content }),
      );
    }
    if (method === "PUT") {
      const revision = body?.expectedRevision as number;
      if (state.networkFails) {
        // The transport failed, so nothing was refused: the client must report a
        // retryable error rather than a server verdict.
        state.networkFails = false;
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      if (state.conflictAt !== null) {
        const current = state.conflictAt;
        state.conflictAt = null;
        return Promise.resolve(
          refuse(409, "conflict", {
            expectedRevision: revision,
            currentRevision: current,
          }),
        );
      }
      if (revision !== resource.revision) {
        return Promise.resolve(
          refuse(409, "conflict", {
            expectedRevision: revision,
            currentRevision: resource.revision,
          }),
        );
      }
      resource.content = String(body?.content ?? "");
      resource.revision += 1;
      return Promise.resolve(reply(200, { resource: view(resource) }));
    }
  }
  const move = /^\/api\/projects\/p1\/resources\/([^/]+)\/move$/.exec(path);
  if (move && method === "POST") {
    const resource = state.resources.get(move[1]);
    if (!resource) return Promise.resolve(refuse(404, "not_found"));
    const revision = body?.expectedRevision as number;
    if (revision !== resource.revision) {
      return Promise.resolve(
        refuse(409, "conflict", {
          expectedRevision: revision,
          currentRevision: resource.revision,
        }),
      );
    }
    resource.path = String(body?.path ?? resource.path);
    resource.revision += 1;
    return Promise.resolve(reply(200, { resource: view(resource) }));
  }
  return Promise.resolve(refuse(404, "not_found"));
}

beforeEach(() => {
  state.signedIn = false;
  state.resources = new Map();
  state.calls = [];
  state.conflictAt = null;
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Wait for a request the shell made, so an assertion is not a race. */
async function waitForCall(
  method: string,
  path: string,
): Promise<{ method: string; path: string; body: unknown }> {
  await waitFor(() => {
    expect(
      state.calls.some((call) => call.method === method && call.path === path),
    ).toBe(true);
  });
  const call = state.calls.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!call) throw new Error(`No ${method} ${path}`);
  return call;
}

describe("App — anonymous browser", () => {
  it("keeps local mode working and offers sign-in from the toolbar", async () => {
    render(<App />);

    await screen.findByTestId("toolbar-sign-in");
    expect(screen.queryByTestId("workspace-server-toggle")).toBeNull();
    expect(screen.queryAllByTestId("workspace-server-project")).toHaveLength(0);

    // Local mode still works exactly as before.
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Local" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Local");
    });
    expect(screen.getByTestId("workspace-local")).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});

describe("App — authenticated browser", () => {
  /** Sign in, open the server project, and wait for its document. */
  async function openServerProject(content = "title Checkout") {
    state.signedIn = true;
    state.resources = new Map([
      [
        "r1",
        {
          id: "r1",
          projectId: "p1",
          path: "checkout.seq",
          type: "sequence-diagram",
          revision: 3,
          content,
        },
      ],
    ]);
    render(<App />);

    const row = await screen.findByTestId("workspace-server-project");
    expect(row).toHaveTextContent("Payments");
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(content);
    });
  }

  it("lists the server projects and opens one into the same editor", async () => {
    await openServerProject();

    // The explorer tree is the server project's, and the editor is the one
    // editor — not a server-specific pane. The row shows the diagram's title,
    // which the server resource's content supplies.
    expect(screen.getByTestId("explorer-diagram")).toHaveTextContent(
      "Checkout",
    );
    expect(screen.getByTestId("workspace-server-project")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId("explorer-mode")).toHaveTextContent(
      "Server project: Payments",
    );
    // Opening read the access record and the resource, and nothing more.
    expect(state.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      "GET /api/projects/p1/access",
    );
  });

  it("saves an edit with the revision it last read", async () => {
    await openServerProject();

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Checkout\nBrowser -> Gateway: Pay" },
    });

    const put = await waitForCall("PUT", "/api/projects/p1/resources/r1");
    expect(put.body).toEqual({
      content: "title Checkout\nBrowser -> Gateway: Pay",
      expectedRevision: 3,
    });
    // The tab is no longer dirty, so the save really landed.
    await waitFor(() => {
      expect(state.resources.get("r1")?.content).toContain(
        "Browser -> Gateway: Pay",
      );
    });
  });

  it("renames a server resource through the move endpoint", async () => {
    await openServerProject();

    // Right-click the row, choose Rename, and confirm the new name.
    fireEvent.contextMenu(screen.getByTestId("explorer-diagram"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-rename"));
    });
    fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
      target: { value: "orders" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    const move = await waitForCall(
      "POST",
      "/api/projects/p1/resources/r1/move",
    );
    // The name is sent as typed. Local projects name a diagram `Untitled` with no
    // extension either, so the two stores agree; the resource's *id* is what
    // survives the rename, which is the property documentation links rely on.
    expect(move.body).toEqual({ path: "orders", expectedRevision: 3 });
    await waitFor(() => {
      expect(state.resources.get("r1")?.path).toBe("orders");
    });
  });

  it("surfaces a conflict and takes the server's version on request", async () => {
    await openServerProject();

    // Someone else writes first; this client's revision is now stale.
    state.conflictAt = 9;
    const stale = state.resources.get("r1");
    if (stale) stale.content = "title Checkout\nSomeone -> Else: changed";

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Mine" },
    });

    // Nothing is overwritten: the dialog appears and the buffer is intact.
    await screen.findByTestId("save-conflict-dialog");
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Mine");

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-conflict-reload"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(
        "title Checkout\nSomeone -> Else: changed",
      );
    });
    expect(screen.queryByTestId("save-conflict-dialog")).toBeNull();
  });

  it("keeps the local buffer when the conflict is cancelled", async () => {
    await openServerProject();
    state.conflictAt = 9;

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Mine" },
    });
    await screen.findByTestId("save-conflict-dialog");

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-conflict-cancel"));
    });

    // The editor still holds the unsaved work, and nothing was written.
    expect(screen.queryByTestId("save-conflict-dialog")).toBeNull();
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Mine");
    expect(state.resources.get("r1")?.content).toContain("title Checkout");
  });

  /**
   * An offline save is not a refusal, so it must not be reported as one — and it
   * must never cost the user their work. The banner offers a retry, the buffer
   * stays in the editor, and the retry succeeds once the API answers again.
   */
  it("keeps the buffer and offers a retry when the API is unreachable", async () => {
    await openServerProject();
    state.networkFails = true;

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Offline" },
    });

    const banner = await screen.findByTestId("save-error");
    expect(banner).toHaveTextContent(/could not be reached/i);
    expect(screen.queryByTestId("save-conflict-dialog")).toBeNull();
    // The work is still on screen and still unsaved.
    expect(screen.getByTestId("dsl-textarea")).toHaveValue("title Offline");
    expect(state.resources.get("r1")?.content).toContain("title Checkout");

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-error-retry"));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("save-error")).toBeNull();
    });
    expect(state.resources.get("r1")?.content).toBe("title Offline");
  });
});
