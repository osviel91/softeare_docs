/**
 * The Node HTTP transport (ADR-040).
 *
 * Routing, authentication and use cases are all testable over a plain request
 * object, which is why almost every API test calls the router directly. That
 * convenience hides one class of bug: anything `node:http` itself does — header
 * semantics, body limits, status writing — is invisible to a router-level test.
 *
 * This file closes that gap for the specific behaviour a sign-in depends on: a
 * response may legitimately carry *two* `set-cookie` headers (the new session and
 * the cleared login-state cookie), and `ServerResponse.setHeader` replaces rather
 * than appends. Writing cookies that way silently drops one, which is exactly
 * what made a successful login leave the browser anonymous.
 */
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createHttpServer } from "../../apps/api/http/node-server";
import { Router } from "../../apps/api/http/router";
import { cookie, clearCookie, json } from "../../apps/api/http/http";

/** A listener bound to an ephemeral port, plus its base URL. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test server did not bind to a port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

const running: Server[] = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** A server whose only route answers with the headers the test supplies. */
async function serve(router: Router, expectedOrigin?: string): Promise<string> {
  const server = createHttpServer({
    router,
    ...(expectedOrigin === undefined ? {} : { expectedOrigin }),
  });
  running.push(server);
  return listen(server);
}

describe("the Node HTTP transport", () => {
  it("writes every set-cookie header, not only the last", async () => {
    const router = new Router();
    router.get("/login", async () =>
      json(303, {}, [
        { name: "location", value: "/" },
        cookie("sdm_session", "sid_1.secret", { httpOnly: true }),
        clearCookie("sdm_login"),
      ]),
    );
    const base = await serve(router);

    const response = await fetch(`${base}/login`, { redirect: "manual" });
    const cookies = response.headers.getSetCookie();

    expect(response.status).toBe(303);
    // Both cookies survive the transport; dropping either breaks sign-in or
    // leaves the short-lived login cookie behind.
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("sdm_session=sid_1.secret");
    expect(cookies[1]).toContain("sdm_login=");
    expect(cookies[1]).toContain("Max-Age=0");
  });

  it("still replaces a header that is not meant to repeat", async () => {
    const router = new Router();
    router.get("/thing", async () => ({
      status: 200,
      headers: [
        { name: "content-type", value: "text/plain" },
        { name: "content-type", value: "application/json" },
      ],
      body: "{}",
    }));
    const base = await serve(router);

    const response = await fetch(`${base}/thing`);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("carries a correlation id on the answer", async () => {
    const router = new Router();
    router.get("/healthz", async () => json(200, { status: "ok" }));
    const base = await serve(router);

    const response = await fetch(`${base}/healthz`, {
      headers: { "x-request-id": "req_test_1" },
    });
    expect(response.headers.get("x-request-id")).toBe("req_test_1");
  });
});

/**
 * The explicit cross-site check (mission item 19).
 *
 * `SameSite=Lax` and JSON-only bodies already stop a forged mutation, but both
 * are ambient properties. These tests pin the deliberate check at the transport,
 * which is where a browser request actually arrives.
 */
describe("the cross-site request check", () => {
  const origin = "http://127.0.0.1:8787";

  /** A router whose POST is the state change under test. */
  function mutationRouter(): Router {
    const router = new Router();
    router.post("/api/thing", async () => json(200, { changed: true }));
    router.get("/api/thing", async () => json(200, { read: true }));
    return router;
  }

  it("allows the application's own origin", async () => {
    const base = await serve(mutationRouter(), origin);
    const response = await fetch(`${base}/api/thing`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
  });

  it("allows a same-origin fetch without an origin header", async () => {
    const base = await serve(mutationRouter(), origin);
    const response = await fetch(`${base}/api/thing`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(200);
  });

  it("refuses a cross-site state change", async () => {
    const base = await serve(mutationRouter(), origin);
    const response = await fetch(`${base}/api/thing`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("forbidden");
  });

  it("refuses a same-site but not same-origin state change", async () => {
    const base = await serve(mutationRouter(), origin);
    const response = await fetch(`${base}/api/thing`, {
      method: "POST",
      headers: { origin: "http://other.127.0.0.1:8787" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("never refuses a safe method", async () => {
    const base = await serve(mutationRouter(), origin);
    const response = await fetch(`${base}/api/thing`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(200);
  });

  it("allows a request with no browser metadata at all", async () => {
    // A command-line client has no ambient cookie to be tricked into sending.
    const base = await serve(mutationRouter(), origin);
    const response = await fetch(`${base}/api/thing`, { method: "POST" });
    expect(response.status).toBe(200);
  });

  it("does not check at all when no origin is configured", async () => {
    const base = await serve(mutationRouter());
    const response = await fetch(`${base}/api/thing`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: "{}",
    });
    expect(response.status).toBe(200);
  });
});
