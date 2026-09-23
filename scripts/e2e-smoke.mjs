#!/usr/bin/env node
/**
 * Browser smoke test (packaging/verification phase).
 *
 * The Vitest suite runs in jsdom, so it never proves that the *built* bundle
 * boots in a real browser: bundling, the production React build, asset paths,
 * and the live editor -> preview wiring are all unverified there. This script
 * closes that gap. It serves `dist/` with `vite preview`, drives it with
 * Chromium via the already-installed `playwright` library, and checks the three
 * things a broken build would break:
 *
 *   1. the app shell mounts and the seeded sample renders as SVG;
 *   2. editing the DSL updates the preview live (React + pipeline wiring);
 *   3. malformed DSL surfaces diagnostics instead of crashing the preview.
 *
 * It deliberately uses the Playwright *library* rather than the `@playwright/test`
 * runner: the checks are a single linear path, and the project keeps its
 * dependency list minimal (see README "Design principles").
 *
 * Usage: `npm run test:e2e` (builds first). Chromium must be installed once via
 * `npx playwright install chromium`; see the README "Testing in a real browser".
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

import { startIdentityProvider } from "./e2e-identity-provider.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;
const UI_TIMEOUT_MS = 10_000;

/**
 * The API ports.
 *
 * The browser only ever talks to the preview origin; the proxy forwards
 * `/api` and `/auth` to the API, so the API's own port is an implementation
 * detail. It is nonetheless fixed by default so a manual `vite dev` run and the
 * E2E run agree, and an occupied port falls back to an ephemeral one.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 8787);
const IDP_PORT = Number(process.env.E2E_IDP_PORT ?? 8788);
const MCP_PORT = Number(process.env.E2E_MCP_PORT ?? 8789);

/**
 * The secret the API signs its login-state cookie with.
 *
 * Long enough to satisfy `COOKIE_SECRET`'s 32-character floor, and obviously a
 * test value. It is generated per run rather than committed so it cannot be
 * mistaken for a deployment secret.
 */
const COOKIE_SECRET = `e2e-${"0123456789abcdef".repeat(4)}`;

/** A diagram that shares no participant names with the seeded sample. */
const REPLACEMENT_SOURCE = [
  "title Checkout",
  "",
  "participant Browser",
  "participant Gateway",
  "",
  "Browser ->> Gateway: Submit order",
  "activate Gateway",
  "Gateway --> Browser: Accepted",
  "deactivate Gateway",
  "",
].join("\n");

/** Malformed on purpose: a sync arrow with no receiver or label. */
const SYNTAX_ERROR_SOURCE = "Browser ->\n";

/**
 * Semantically invalid on purpose: the message names `Gateway`, which is never
 * declared. The parser produces a coherent tree, so this is the case that makes
 * the preview fall back to its empty state.
 */
const SEMANTIC_ERROR_SOURCE = [
  "participant Browser",
  "",
  "Browser ->> Gateway: Submit order",
  "",
].join("\n");

/**
 * Markers the server scenarios look for on the wire.
 *
 * Each is unique so a check can never pass because a *different* scenario's
 * document happened to be open, and none appears in the seeded sample.
 */
const SERVER_MARKER = "SERVERSAVEDMARKER";
const MARKDOWN_MARKER = "SERVERDOCMARKER";
const CONFLICT_BASE = "CONFLICTSAVEDBASE";
const CONFLICT_OWNER = "CONFLICTOWNERWINS";
const CONFLICT_LOCAL = "CONFLICTLOCALEDIT";
const VIEWER_MARKER = "VIEWERREADONLYBASE";
const LOCAL_MARKER = "LOCALANONMARKER";
/** Written through the remote MCP endpoint and then looked for in the browser. */
const AGENT_MARKER = "REMOTEMCPMARKER";

const failures = [];

/** Record and print one assertion result. */
function check(description, passed, detail = "") {
  const status = passed ? "PASS" : "FAIL";
  console.log(`  ${status}  ${description}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures.push(description);
}

/**
 * Poll a locator's text until `predicate` accepts it.
 *
 * Playwright's `expect` lives in `@playwright/test`, so waiting for a React
 * re-render (which happens asynchronously after `fill`) is done by polling.
 */
async function waitForText(locator, predicate, description) {
  const deadline = Date.now() + UI_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = (await locator.textContent()) ?? "";
    } catch {
      last = "";
    }
    if (predicate(last)) return last;
    await delay(100);
  }
  throw new Error(
    `${description} timed out after ${UI_TIMEOUT_MS}ms (last text: ${JSON.stringify(
      last.slice(0, 200),
    )})`,
  );
}

/**
 * Child processes this run owns.
 *
 * The API and the preview are killed in `main`'s `finally`, but a hard failure or
 * a Ctrl-C must not leave a listener behind either. Registering every spawn here
 * and killing the set on `exit` is what makes an unexpected end safe.
 */
const liveChildren = new Set();

/** Remember a child process so an unexpected exit can still kill it. */
function trackChild(child) {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  return child;
}

/** Kill every tracked child, ignoring one that is already gone. */
function killTrackedChildren() {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already dead.
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killTrackedChildren();
    process.exit(1);
  });
}
process.on("exit", killTrackedChildren);

/**
 * Find a free loopback port.
 *
 * The preferred port is tried first so a manual run keeps stable URLs; when it is
 * taken an ephemeral port is used instead, so a stray process can never make the
 * suite fail for the wrong reason.
 */
async function findFreePort(preferred) {
  const bind = (port) =>
    new Promise((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(null));
      probe.listen(port, "127.0.0.1", () => {
        const address = probe.address();
        const bound =
          typeof address === "object" && address !== null ? address.port : null;
        probe.close(() => resolve(bound));
      });
    });
  return (await bind(preferred)) ?? (await bind(0));
}

/**
 * Start the built API against a temporary volume and wait until it serves.
 *
 * Three configuration choices carry the run:
 *
 * - `NODE_ENV=test` is deliberate. Without `DATABASE_URL`, the API refuses to
 *   boot in `development` and `production`; the E2E run must use PGlite rather
 *   than require a PostgreSQL server, and `test` is the environment in which
 *   PGlite is a legitimate driver.
 * - `PUBLIC_URL` is the *browser's* origin, not the API's port. The OIDC
 *   redirect URI must land back on the preview origin so the session cookie
 *   stays same-origin and the `/auth` proxy carries it.
 * - the project volume is a fresh temporary directory per run, so a scenario can
 *   never read another run's files.
 */
async function startApiServer({
  port,
  projectVolume,
  issuer,
  clientId,
  clientSecret,
}) {
  const apiBundle = await import(
    pathToFileURL(join(ROOT, "dist-api", "server.mjs")).href
  );

  const config = apiBundle.loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_URL: BASE_URL,
    PROJECT_VOLUME: projectVolume,
    PGLITE_DIR: "memory://",
    COOKIE_SECRET,
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
  });

  // The runtime is built here and *shared* with the MCP service below, so both
  // hosts read and write one database and one project volume. That is the only
  // way the browser↔MCP scenario can prove consistency with an in-process
  // PGlite, which no second process can open.
  const runtime = await apiBundle.createServerRuntime({
    database: config.database,
    projectVolume: config.projectVolume,
    tokenPepper: config.tokenPepper,
  });
  const dependencies = await apiBundle.createApp(config, { runtime });
  const server = apiBundle.createHttpServer({
    router: apiBundle.createRouter(dependencies),
    expectedOrigin: config.publicUrl,
    onError(error, requestId) {
      process.stderr.write(
        `${requestId} unhandled error: ${error?.stack ?? error}\n`,
      );
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const apiBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/healthz`);
      if (response.ok) {
        const health = await response.json();
        if (health.status === "ok" && health.signIn === "oidc") {
          return {
            runtime,
            config,
            apiBase,
            async close() {
              await new Promise((resolve) => server.close(resolve));
              await apiBundle.closeApp(dependencies);
            },
          };
        }
      }
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(150);
  }
  throw new Error(
    `the API did not report {status:"ok", signIn:"oidc"} within ${READY_TIMEOUT_MS}ms`,
  );
}

/**
 * Start the real MCP service in-process, over the API's own runtime.
 *
 * Phase 6 made the MCP a separate host with its own image and port; running it
 * here in the same process is a test convenience, not an architectural
 * concession — it is still a real HTTP listener with the real handler, the real
 * SDK transport and the real authentication, and it shares storage with the API
 * the way the container composition does through PostgreSQL.
 */
async function startMcpService({ port, runtime, publicUrl, projectVolume }) {
  const mcpBundle = await import(
    pathToFileURL(join(ROOT, "dist-mcp-service", "server.mjs")).href
  );
  const config = mcpBundle.loadMcpConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    MCP_PUBLIC_URL: publicUrl,
    PROJECT_VOLUME: projectVolume,
    PGLITE_DIR: "memory://",
    TOKEN_PEPPER: `e2e-pepper-${COOKIE_SECRET}`,
  });
  const service = await mcpBundle.createMcpService(config, {
    runtime,
    logger: { log: () => {} },
  });
  const server = mcpBundle.createMcpHttpServer({
    config,
    observability: service.observability,
    handleMcp: service.handleMcp,
    ready: service.ready,
    onError(error, requestId) {
      process.stderr.write(`${requestId} mcp error: ${error}\n`);
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const mcpBase = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${mcpBase}/health`);
      if (response.ok) {
        return {
          mcpBase,
          config,
          async close() {
            await new Promise((resolve) => server.close(resolve));
            await service.close();
          },
        };
      }
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(150);
  }
  throw new Error(
    `the MCP service did not become healthy within ${READY_TIMEOUT_MS}ms`,
  );
}

/**
 * Send one request from a page, through the application's own origin.
 *
 * Using the page's `fetch` is what makes the session part of the test: the
 * request is same-origin, so the browser attaches the HttpOnly cookie exactly as
 * the application does, and the preview's proxy forwards `/api` to the API.
 */
async function apiRequest(page, path, init = undefined) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        method: init?.method ?? "GET",
        ...(init?.body === undefined
          ? {}
          : {
              body: init.body,
              headers: { "content-type": "application/json" },
            }),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, json, text };
    },
    { path, init },
  );
}

/** Find a server project by name, as the signed-in page sees it. */
async function serverProjectByName(page, projectName) {
  const workspaces = await apiRequest(page, "/api/workspaces");
  for (const workspace of workspaces.json?.workspaces ?? []) {
    const projects = await apiRequest(
      page,
      `/api/projects?workspaceId=${encodeURIComponent(workspace.id)}`,
    );
    const project = (projects.json?.projects ?? []).find(
      (entry) => entry.name === projectName,
    );
    if (project) return project;
  }
  return null;
}

/**
 * Speak one JSON-RPC message to the remote MCP endpoint as a machine client.
 *
 * This goes to the API directly with an `Authorization: Bearer` header, not
 * through the page's cookie: the whole point of the remote MCP surface is that
 * it is a machine credential on a different axis from the browser session, and
 * a test that borrowed the page's session would not prove it.
 */
async function remoteMcp(baseUrl, token, message) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The Streamable HTTP transport requires a client to accept both a JSON
      // body and an event stream, even when the server only ever sends JSON.
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** Call a remote MCP tool and return its result object. */
async function remoteTool(baseUrl, token, id, name, args) {
  const answer = await remoteMcp(baseUrl, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return answer.json?.result ?? null;
}

/**
 * Poll the API until one of a project's resources holds content the predicate
 * accepts.
 *
 * Waiting on the *server's* copy rather than the tab's dirty flag is what makes
 * "the save landed" a fact rather than a guess: the tab clears its dirty flag
 * from its own optimistic bookkeeping, while this reads what a second browser
 * would see.
 */
async function waitForServerContent(page, projectName, predicate, description) {
  const deadline = Date.now() + UI_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const project = await serverProjectByName(page, projectName);
    if (project !== null) {
      const list = await apiRequest(
        page,
        `/api/projects/${project.id}/resources`,
      );
      for (const resource of list.json?.resources ?? []) {
        const read = await apiRequest(
          page,
          `/api/projects/${project.id}/resources/${resource.id}`,
        );
        last = read.json?.content ?? "";
        if (predicate(last)) {
          return {
            projectId: project.id,
            resourceId: resource.id,
            content: last,
          };
        }
      }
    }
    await delay(150);
  }
  throw new Error(
    `${description} timed out after ${UI_TIMEOUT_MS}ms (last content: ${JSON.stringify(
      last.slice(0, 200),
    )})`,
  );
}

/** Read a project's first resource, with its id, revision and content. */
async function currentServerResource(page, projectName) {
  const project = await serverProjectByName(page, projectName);
  if (project === null) {
    throw new Error(`no server project named ${JSON.stringify(projectName)}`);
  }
  const list = await apiRequest(page, `/api/projects/${project.id}/resources`);
  const resource = (list.json?.resources ?? [])[0];
  if (resource === undefined) {
    throw new Error(`server project ${projectName} has no resources`);
  }
  const read = await apiRequest(
    page,
    `/api/projects/${project.id}/resources/${resource.id}`,
  );
  return {
    projectId: project.id,
    resource,
    content: read.json?.content ?? "",
  };
}

/**
 * Poll an input's value until the predicate accepts it.
 *
 * `textContent` does not track a textarea's value, so the textarea-backed
 * editors need this rather than {@link waitForText}.
 */
async function waitForInputValue(locator, predicate, description) {
  const deadline = Date.now() + UI_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await locator.inputValue();
    } catch {
      last = "";
    }
    if (predicate(last)) return last;
    await delay(100);
  }
  throw new Error(
    `${description} timed out after ${UI_TIMEOUT_MS}ms (last value: ${JSON.stringify(
      last.slice(0, 200),
    )})`,
  );
}

/**
 * Tell the local identity provider who the next authorization signs in as.
 *
 * Going through the provider's HTTP control endpoint (rather than calling the
 * in-process object) exercises the real path a test harness uses, including its
 * loopback and bearer-token guards.
 */
async function setNextIdentity(idp, subject) {
  const response = await fetch(`${idp.issuer}/__control/subject`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-e2e-control": idp.controlToken,
    },
    body: JSON.stringify(subject),
  });
  if (!response.ok) {
    throw new Error(
      `the identity provider refused a subject change: ${response.status}`,
    );
  }
}

/**
 * Sign a page in as a subject.
 *
 * The provider is told who to sign in as *before* the browser leaves for it: the
 * authorization endpoint signs in the subject the control endpoint last chose,
 * which is how one provider serves two different people in one run.
 */
async function signIn(page, idp, subject) {
  await setNextIdentity(idp, subject);
  const button = page
    .locator('[data-testid="login-google"], [data-testid="toolbar-sign-in"]')
    .first();
  await button.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await button.click();
  await page.locator('[data-testid="toolbar-account"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
}

/** Wait for either the login gate or the authenticated application shell. */
async function waitForAuthEntry(page) {
  await page
    .locator('[data-testid="login-page"], [data-testid="app-shell"]')
    .first()
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
}

/** Create a server project from the switcher and wait until it is open. */
async function createServerProject(page, name) {
  await expandServerPanel(page);
  await page
    .locator('[data-testid="workspace-new-server-project-input"]')
    .fill(name);
  await page
    .locator('[data-testid="workspace-new-server-project-button"]')
    .click();
  await openServerProject(page, name);
}

/** Open the server workspace section, which is collapsed by default. */
async function expandServerPanel(page) {
  const toggle = page.locator('[data-testid="workspace-server-toggle"]');
  await toggle.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

/** Open a server project from the switcher and wait for its explorer row. */
async function openServerProject(page, name) {
  await expandServerPanel(page);
  const entry = page
    .locator('[data-testid="workspace-server-project"]')
    .filter({ hasText: name });
  await entry.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await entry.click();
  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: name })
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
}

/** Add a document to a project through the explorer's add menu. */
async function addDocument(page, projectName, menuTestId) {
  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: projectName })
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator(`[data-testid="${menuTestId}"]`).click();
}

/**
 * Create a document and wait for its tab to appear.
 *
 * Waiting for the editor alone is not enough: a project with no documents still
 * shows the editor, so a `fill` issued while the asynchronous create is in
 * flight would be overwritten the moment the new, empty document becomes active.
 * The new tab is the concrete signal that the created document is on screen.
 */
async function createDocument(page, projectName, menuTestId) {
  const tabsBefore = await page.locator('[data-testid="tab"]').count();
  await addDocument(page, projectName, menuTestId);
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid="tab"]').length === expected,
    tabsBefore + 1,
    { timeout: UI_TIMEOUT_MS },
  );
}

/** Run one labelled scenario, recording its completion as a single check. */
async function scenario(name, body) {
  console.log(`\n${name}`);
  try {
    await body();
    check(`${name} completed`, true);
  } catch (error) {
    check(
      `${name} completed`,
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Start `vite preview` for the built bundle and resolve once it serves. */
async function startPreviewServer() {
  const viteBin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    throw new Error(`Vite binary not found at ${viteBin}; run npm install.`);
  }

  const child = trackChild(
    spawn(
      process.execPath,
      // Bind explicitly to IPv4: Vite's default `localhost` can resolve to ::1
      // only, which the fetch-based readiness poll below would never reach.
      [
        viteBin,
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(PORT),
        "--strictPort",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );

  let serverLog = "";
  child.stdout.on("data", (chunk) => (serverLog += chunk));
  child.stderr.on("data", (chunk) => (serverLog += chunk));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `vite preview exited with code ${child.exitCode}:\n${serverLog.trim()}`,
      );
    }
    try {
      const response = await fetch(BASE_URL, { redirect: "manual" });
      if (response.ok) return child;
    } catch {
      // Not listening yet; keep polling.
    }
    await delay(150);
  }

  child.kill("SIGTERM");
  throw new Error(
    `vite preview did not serve ${BASE_URL} within ${READY_TIMEOUT_MS}ms:\n${serverLog.trim()}`,
  );
}

/**
 * Drive the served app and record every check.
 *
 * @param page - The page to drive. The caller owns it (and its context), because
 *   the window size is part of the harness rather than of a check: the workspace
 *   switcher sits above the project tree, and on Playwright's 720px-tall default
 *   viewport the explorer would have to scroll the last project into view before
 *   clicking its add button. A context menu dismisses itself on scroll, so it
 *   would close between Playwright's stability check and the click. A window tall
 *   enough to show the tree needs no scroll, which is why `main` opens the
 *   browser with one.
 */
async function runChecks(page, idp) {
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await waitForAuthEntry(page);
  await signIn(page, idp, {
    sub: "e2e-smoke-editor",
    name: "E2E Smoke Editor",
    email: "smoke-editor@e2e.test",
  });

  console.log("\nShell:");
  await page.locator('[data-testid="app-shell"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("app shell mounts", true);
  check(
    "document title is the product name",
    (await page.title()) === "Software Docs Manager",
    await page.title(),
  );

  console.log("\nSeeded sample renders:");
  const svg = page.locator('[data-testid="preview-svg"]');
  await svg.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const sampleText = await waitForText(
    svg,
    (text) => text.includes("User") && text.includes("Find user"),
    "seeded sample SVG",
  );
  check("preview renders the seeded sample", true);
  check("participant labels are drawn", sampleText.includes("User"));
  check("message labels are drawn", sampleText.includes("Find user"));
  check("diagram title is drawn", sampleText.includes("Login"));
  check(
    "no uncaught page errors",
    consoleErrors.length === 0,
    consoleErrors.join("; "),
  );

  // Text can sit in the DOM yet never be painted — nested in an element that
  // cannot render children, for instance. Measuring what the browser actually
  // lays out makes this a rendering check, not a markup check.
  const unpainted = await page.$$eval(
    '[data-testid="preview-svg"] text',
    (nodes) =>
      nodes
        .filter((node) => node.getBoundingClientRect().width === 0)
        .map((node) => node.textContent ?? ""),
  );
  check(
    "every text label is painted with a non-zero box",
    unpainted.length === 0,
    unpainted.join(", "),
  );

  const arrowHeads = await page
    .locator('[data-testid="preview-svg"] polygon')
    .count();
  check(
    "every message line paints an arrowhead",
    arrowHeads === 4,
    `found ${arrowHeads}`,
  );

  // Every call and every response is numbered in source order; the sample has
  // four messages (two calls, two responses).
  const stepNumbers = await page
    .locator('[data-testid="preview-svg"] [data-sequence-number]')
    .count();
  check(
    "every message carries a circled step number",
    stepNumbers === 4,
    `found ${stepNumbers}`,
  );

  // The gutter must line up with the textarea and keep the step badges in one
  // column. jsdom has no layout, so only a real browser can catch a line-height
  // mismatch (which drifts every number off its line) or a badge column that
  // shifts with the width of the line number beside it.
  console.log("\nEditor gutter:");
  const gutter = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".editor__line-number")];
    const textarea = document.querySelector(".editor__textarea");
    const badges = [...document.querySelectorAll(".editor__step")];
    return {
      rowLineHeight: getComputedStyle(rows[0]).lineHeight,
      textareaLineHeight: getComputedStyle(textarea).lineHeight,
      tops: rows.map((row) => row.getBoundingClientRect().top),
      badgeLefts: badges.map((badge) => badge.getBoundingClientRect().left),
    };
  });
  check(
    "gutter rows use the textarea's line height",
    gutter.rowLineHeight === gutter.textareaLineHeight,
    `${gutter.rowLineHeight} vs ${gutter.textareaLineHeight}`,
  );
  const lineHeight = Number.parseFloat(gutter.textareaLineHeight);
  const firstTop = gutter.tops[0] ?? 0;
  const maxDrift = Math.max(
    ...gutter.tops.map((top, index) =>
      Math.abs(top - (firstTop + index * lineHeight)),
    ),
  );
  check(
    "line numbers do not drift from their lines",
    maxDrift < 0.5,
    `max drift ${maxDrift.toFixed(2)}px`,
  );
  const badgeSpread =
    gutter.badgeLefts.length === 0
      ? 0
      : Math.max(...gutter.badgeLefts) - Math.min(...gutter.badgeLefts);
  check(
    "step badges share one left-aligned column",
    gutter.badgeLefts.length === 4 && badgeSpread < 0.5,
    `${gutter.badgeLefts.length} badges, spread ${badgeSpread.toFixed(2)}px`,
  );

  const editorBounds = await page.evaluate(() => {
    const editor = document.querySelector('[aria-label="DSL editor"]');
    const statusbar = document.querySelector(".app__statusbar");
    const code = document.querySelector(".editor__code");
    const textarea = document.querySelector(".editor__textarea");
    return {
      editorBottom: editor?.getBoundingClientRect().bottom ?? 0,
      statusbarTop: statusbar?.getBoundingClientRect().top ?? 0,
      codeBottom: code?.getBoundingClientRect().bottom ?? 0,
      textareaBottom: textarea?.getBoundingClientRect().bottom ?? 0,
    };
  });
  check(
    "DSL editor stays above the status bar",
    editorBounds.editorBottom <= editorBounds.statusbarTop + 0.5,
    `${editorBounds.editorBottom.toFixed(2)} vs ${editorBounds.statusbarTop.toFixed(2)}`,
  );
  check(
    "DSL textarea stays inside the code area",
    editorBounds.textareaBottom <= editorBounds.codeBottom + 0.5,
    `${editorBounds.textareaBottom.toFixed(2)} vs ${editorBounds.codeBottom.toFixed(2)}`,
  );

  // The suggestion popup must never swallow Enter or the arrow keys. It opens
  // at a statement start (a wall of keywords), and if it captured Enter the
  // editor could never add a blank line; if it captured the arrows the caret
  // could not be moved with the keyboard.
  console.log("\nCompletion never swallows typing:");
  const editor = page.locator('[data-testid="dsl-textarea"]');
  const BLANK_LINE_SOURCE = [
    "title Blank lines",
    "participant A",
    "participant B",
    "A -> B: hi",
  ].join("\n");
  await editor.fill(BLANK_LINE_SOURCE);
  const linesBefore = (await editor.inputValue()).split("\n").length;
  const titlesBefore = ((await editor.inputValue()).match(/title/g) ?? [])
    .length;
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const afterEnter = await editor.inputValue();
  const linesAfter = afterEnter.split("\n").length;
  const titlesAfter = (afterEnter.match(/title/g) ?? []).length;
  check(
    "Enter adds blank lines instead of accepting a suggestion",
    linesAfter === linesBefore + 2 && titlesAfter === titlesBefore,
    `${linesBefore} -> ${linesAfter} lines, titles ${titlesBefore} -> ${titlesAfter}`,
  );

  await page.keyboard.press("ArrowUp");
  const caretAfterArrow = await editor.evaluate((el) => el.selectionStart);
  check(
    "arrow keys still move the caret",
    caretAfterArrow < afterEnter.length,
    `caret ${caretAfterArrow} of ${afterEnter.length}`,
  );

  await editor.fill("");
  await editor.pressSequentially("part");
  await page.keyboard.press("Tab");
  check(
    "Tab still accepts the highlighted suggestion",
    (await editor.inputValue()) === "participant",
    await editor.inputValue(),
  );

  // Participant names are bolded by a highlight layer behind a transparent
  // textarea. If the two layers' fonts or boxes disagree, the bold names drift
  // off the glyphs, which only a real browser can show.
  console.log("\nParticipant highlighting:");
  await editor.fill("participant API\nAPI -> DB: hi\n");
  const boldNames = await page
    .locator('[data-testid="editor-highlight"] strong')
    .count();
  check(
    "participant names are bolded in the editor",
    boldNames === 3,
    `${boldNames} bold names`,
  );
  check(
    "highlight layer mirrors the source",
    (await page.locator('[data-testid="editor-highlight"]').textContent()) ===
      (await editor.inputValue()),
  );
  const layerMetrics = await page.evaluate(() => {
    const highlight = document.querySelector(".editor__highlight");
    const textarea = document.querySelector(".editor__textarea");
    const a = getComputedStyle(highlight);
    const b = getComputedStyle(textarea);
    const ra = highlight.getBoundingClientRect();
    const rb = textarea.getBoundingClientRect();
    return {
      sameFont: a.fontFamily === b.fontFamily && a.fontSize === b.fontSize,
      sameLineHeight: a.lineHeight === b.lineHeight,
      samePadding: a.padding === b.padding,
      noSoftWrap: textarea.wrap === "off" && a.whiteSpace === "pre",
      sameBox:
        Math.abs(ra.left - rb.left) < 0.5 &&
        Math.abs(ra.top - rb.top) < 0.5 &&
        Math.abs(ra.width - rb.width) < 0.5 &&
        Math.abs(ra.height - rb.height) < 0.5,
    };
  });
  check("highlight layer shares the textarea's font", layerMetrics.sameFont);
  check(
    "highlight layer shares the textarea's line height",
    layerMetrics.sameLineHeight,
  );
  check("editor source lines do not soft-wrap", layerMetrics.noSoftWrap);
  check("highlight layer covers the textarea exactly", layerMetrics.sameBox);

  // Retyping a declaration's name carries its usages with it, so the diagram
  // never collapses into "unknown participant" mid-edit.
  await editor.evaluate((el) => {
    el.focus();
    el.setSelectionRange(15, 15);
  });
  await page.keyboard.type("X");
  check(
    "renaming a declaration rewrites its usages",
    (await editor.inputValue()) === "participant APIX\nAPIX -> DB: hi\n",
    await editor.inputValue(),
  );

  console.log("\nLive editing updates the preview:");
  await page.locator('[data-testid="dsl-textarea"]').fill(REPLACEMENT_SOURCE);
  const editedText = await waitForText(
    svg,
    (text) => text.includes("Submit order"),
    "edited SVG",
  );
  check("new participant appears", editedText.includes("Gateway"));
  check("new message appears", editedText.includes("Submit order"));
  check("previous diagram is replaced", !editedText.includes("Find user"));
  check(
    "editor reports no problems for valid DSL",
    (await page.locator('[data-testid="dsl-diagnostics"]').count()) === 0,
  );

  // Phase 7 activations: the bar is painted as a white-filled, dark-stroked
  // rectangle over the lifeline, distinct from a participant box.
  const bars = await page.$$eval(
    '[data-testid="preview-svg"] rect[stroke="#0f172a"]',
    (nodes) => nodes.map((n) => n.getBoundingClientRect()),
  );
  check("activation bar is painted", bars.length === 1, `found ${bars.length}`);
  check(
    "activation bar has a non-zero box",
    bars.length === 1 && bars[0].height > 0 && bars[0].width > 0,
  );

  console.log("\nCanvas navigation:");
  const zoomLevel = () =>
    page.locator('[data-testid="zoom-level"]').textContent();
  const zoomBefore = await zoomLevel();
  await page.locator('[data-testid="zoom-in"]').click();
  const zoomAfter = await zoomLevel();
  check(
    "zoom in raises the zoom level",
    Number.parseInt(zoomAfter, 10) > Number.parseInt(zoomBefore, 10),
    `${zoomBefore} -> ${zoomAfter}`,
  );

  await page.locator('[data-testid="zoom-reset"]').click();
  check("reset returns to 100%", (await zoomLevel()) === "100%");

  // The zoom transform must actually move the painted diagram, not just the
  // readout: compare the canvas box before and after.
  const boxBefore = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  await page.locator('[data-testid="zoom-in"]').click();
  const boxAfter = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  check(
    "zooming enlarges the painted diagram",
    boxAfter.width > boxBefore.width,
    `${Math.round(boxBefore.width)} -> ${Math.round(boxAfter.width)}`,
  );

  // Dragging the canvas pans it without changing the zoom.
  const pane = await page
    .locator('[data-testid="viewport-pane"]')
    .boundingBox();
  const zoomDuringPan = await zoomLevel();
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    pane.x + pane.width / 2 + 80,
    pane.y + pane.height / 2,
    {
      steps: 5,
    },
  );
  await page.mouse.up();
  const boxPanned = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  check(
    "dragging pans the diagram",
    Math.round(boxPanned.x) !== Math.round(boxAfter.x),
    `x ${Math.round(boxAfter.x)} -> ${Math.round(boxPanned.x)}`,
  );
  check(
    "panning does not change the zoom",
    (await zoomLevel()) === zoomDuringPan,
  );

  check(
    "minimap renders the diagram overview",
    (await page.locator('[data-testid="minimap-image"]').count()) === 1,
  );

  console.log("\nDocumentation page and auto-update:");
  await page.locator('[data-testid="open-docs"]').click();
  await page.locator('[data-testid="docs-page"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("the toolbar opens the documentation page", true);
  check(
    "the reference documents the activation construct",
    (
      await page.locator('[data-testid="dsl-reference"]').textContent()
    ).includes("activate"),
  );

  await page.locator('[data-testid="docs-nav-commands"]').click();
  check(
    "the command reference lists a palette command",
    (
      await page.locator('[data-testid="commands-reference"]').textContent()
    ).includes("New Diagram"),
  );
  await page.locator('[data-testid="docs-nav-mcp"]').click();
  check(
    "the MCP section explains how to build the server",
    (
      await page.locator('[data-testid="mcp-reference"]').textContent()
    ).includes("npm run mcp:build"),
  );

  await page.locator('[data-testid="docs-back"]').click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("leaving the documentation page restores the editor", true);

  // With auto-update off the canvas must keep the last rendered diagram.
  await page.locator('[data-testid="auto-update-switch"]').click();
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill("title Frozen\n\nparticipant Icicle\n");
  check(
    "the preview is frozen while paused",
    !(await page.locator('[data-testid="preview-svg"]').textContent()).includes(
      "Icicle",
    ),
  );
  await page.locator('[data-testid="render-button"]').click();
  await waitForText(
    page.locator('[data-testid="preview-svg"]'),
    (text) => text.includes("Icicle"),
    "manually rendered SVG",
  );
  check("Render catches the canvas up", true);
  // Restore live updates for the checks that follow.
  await page.locator('[data-testid="auto-update-switch"]').click();

  console.log("\nNotes expand from their bullet:");
  // A note renders as a bullet on its element; expanding it is a real pointer
  // interaction, so this is where the pan surface's pointer handling is checked
  // (a stray pointer capture would swallow the click).
  const NOTES_SOURCE = [
    "title Notes demo",
    "",
    "participant User",
    "participant API",
    "",
    "User -> API: Login",
    "note right of API : Reads from cache",
    "",
  ].join("\n");
  await page.locator('[data-testid="dsl-textarea"]').fill(NOTES_SOURCE);
  await page.locator('[data-testid="preview-notes"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "notes toolbar reports the note count",
    (
      (await page.locator('[data-testid="preview-notes"]').textContent()) ?? ""
    ).includes("1 note"),
  );
  const bullet = page.locator(
    '[data-testid="preview-svg"] [data-note-index="0"]',
  );
  check(
    "a bullet is attached to the annotated element",
    (await bullet.count()) === 1,
  );
  check(
    "note text is hidden while collapsed",
    !(await page.locator('[data-testid="preview-svg"]').textContent()).includes(
      "Reads from cache",
    ),
  );

  const canvasBefore = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  await bullet.click();
  const expanded = await waitForText(
    page.locator('[data-testid="preview-svg"]'),
    (text) => text.includes("Reads from cache"),
    "expanded note",
  );
  check(
    "clicking the bullet expands the note",
    expanded.includes("Reads from cache"),
  );
  const canvasAfter = await page
    .locator('[data-testid="preview-svg"]')
    .boundingBox();
  check(
    "expanding a bullet does not resize the canvas",
    Math.round(canvasAfter.height) === Math.round(canvasBefore.height),
    `${Math.round(canvasBefore.height)} -> ${Math.round(canvasAfter.height)}`,
  );

  await bullet.click();
  check(
    "clicking the bullet again collapses the note",
    !(await page.locator('[data-testid="preview-svg"]').textContent()).includes(
      "Reads from cache",
    ),
  );

  console.log("\nSelf-messages render as loops:");
  // A message whose endpoints are the same participant must draw a cycle, not a
  // zero-length horizontal arrow that disappears.
  const SELF_SOURCE = [
    "title Self loop",
    "",
    "participant API",
    "",
    "API ->> API: Retry",
    "",
  ].join("\n");
  await page.locator('[data-testid="dsl-textarea"]').fill(SELF_SOURCE);
  await waitForText(
    page.locator('[data-testid="preview-svg"]'),
    (text) => text.includes("Retry"),
    "self-message loop",
  );
  const loopPaths = await page
    .locator('[data-testid="preview-svg"] path')
    .count();
  check(
    "a self-message paints a loop path",
    loopPaths === 1,
    `found ${loopPaths}`,
  );
  const loopHeads = await page
    .locator('[data-testid="preview-svg"] polygon')
    .count();
  check("the loop carries an arrowhead", loopHeads === 1, `found ${loopHeads}`);
  const loopPainted = await page.$$eval(
    '[data-testid="preview-svg"] path',
    (nodes) =>
      nodes.every((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }),
  );
  check("the loop is painted, not collapsed to a point", loopPainted);

  console.log("\nMermaid-parity constructs:");
  // Actors, labelled ids, every arrow family, inline activation, nested
  // fragments, and a spanning + multiline note in one diagram.
  const PARITY_SOURCE = [
    "title Mermaid parity",
    "",
    "actor User",
    "participant API",
    'participant DB as "User Database"',
    "participant Queue",
    "",
    "User ->>+ API: Login",
    "API -> DB: Cache miss",
    "API -x DB: Dropped",
    "API -) Queue: Publish",
    "API <<->> API: Sync",
    "activate API",
    "API ->> API: Work",
    "deactivate API",
    "API -->>- User: Token",
    "loop retry up to 3 times",
    "  API ->> DB: Query",
    "end",
    "alt found",
    "  DB -->> API: Row",
    "else missing",
    "  API -->> User: 404",
    "end",
    "note over API,DB : Transaction boundary",
    "note right of API:",
    "  Validate JWT",
    "  Check expiration",
    "end note",
    "note on 1 : First step note",
    "",
  ].join("\n");
  await page.locator('[data-testid="dsl-textarea"]').fill(PARITY_SOURCE);
  await page.locator('[data-testid="preview-svg"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const svgText = await waitForText(
    page.locator('[data-testid="preview-svg"]'),
    (text) => text.includes("Transaction boundary") || text.includes("Query"),
    "parity diagram",
  );
  check("the parity diagram renders", svgText.length > 0);
  check(
    "an actor is drawn as a figure",
    (await page.locator('[data-participant-type="actor"]').count()) === 1,
  );
  check(
    "a loop frame is drawn",
    (await page.locator('[data-fragment-kind="loop"]').count()) === 1,
  );
  check(
    "an alt frame is drawn with both branches",
    (await page.locator('[data-fragment-kind="alt"]').textContent())?.includes(
      "missing",
    ) === true,
  );
  check(
    "an open (async) arrow is drawn",
    (await page.locator(".arrow-open").count()) === 1,
  );
  check(
    "a cross (failed) arrow is drawn",
    (await page.locator(".arrow-cross").count()) === 1,
  );
  // Ten messages: Login, Cache miss, Dropped, Publish, Sync, Work, Token,
  // Query, Row, 404.
  const parityNumbers = await page
    .locator('[data-testid="preview-svg"] [data-sequence-number]')
    .count();
  check(
    "every message is still numbered",
    parityNumbers === 10,
    `found ${parityNumbers}`,
  );
  // The parity source carries three notes: a spanning one, a multiline one, and
  // one attached to message 1 by its step number.
  check(
    "a note can be attached to a message by its number",
    (
      (await page.locator('[data-testid="preview-notes"]').textContent()) ?? ""
    ).includes("3 notes"),
  );

  console.log("\nMarkdown notes:");
  // A project documents a system: create one, add a diagram to link to, then a
  // note that references it.
  await page.locator('[data-testid="project-name-input"]').fill("Handbook");
  await page.locator('[data-testid="create-project-button"]').click();
  await page.locator('[data-testid="project-name"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("creating a project works with notes", true);

  await page.locator('[data-testid="command-palette-button"]').click();
  await page.locator('[data-testid="palette-input"]').fill("New Diagram");
  await page.locator('[data-testid="palette-item-button"]').first().click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("a diagram can be created to link to", true);

  await page.locator('[data-testid="project-add-button"]').first().click();
  await page.locator('[data-testid="context-menu-new-note"]').click();
  await page.locator('[data-testid="markdown-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page
    .locator('[data-testid="markdown-textarea"]')
    .fill("# Runbook\n\nSee [[Untitled]] for the flow.");
  const markdownBody = page.locator('[data-testid="markdown-body"]');
  const rendered = await waitForText(
    markdownBody,
    (text) => text.includes("Runbook") && text.includes("Untitled"),
    "rendered markdown",
  );
  check("the note renders as markdown", rendered.includes("Runbook"));
  check(
    "a wiki-link to an existing diagram resolves",
    (await page.locator('[data-testid="markdown-body"] h1').textContent()) ===
      "Runbook",
  );
  check(
    "the resolved wiki-link is not marked broken",
    (await page
      .locator('[data-testid="markdown-body"] a[data-diagram-link]')
      .getAttribute("class")) === "markdown__link",
  );

  // The explorer's context menu drives rename / change title / delete.
  await page.locator('[data-testid="explorer-note"]').first().click({
    button: "right",
  });
  await page.locator('[data-testid="context-menu"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("right-clicking a note opens its context menu", true);
  await page.locator('[data-testid="context-menu-title"]').click();
  await page.locator('[data-testid="prompt-dialog-input"]').fill("Operations");
  await page.locator('[data-testid="prompt-dialog-confirm"]').click();
  const noteTitle = await waitForText(
    page.locator('[data-testid="note-title"]'),
    (text) => text.includes("Operations"),
    "note title",
  );
  check(
    "changing a note's title rewrites its heading",
    noteTitle.includes("Operations"),
  );
  check(
    "the context menu closed after choosing an action",
    (await page.locator('[data-testid="context-menu"]').count()) === 0,
  );

  // Duplicate is offered for both kinds of file; a note copy keeps its content.
  await page.locator('[data-testid="explorer-note"]').first().click({
    button: "right",
  });
  await page.locator('[data-testid="context-menu-duplicate"]').click();
  await page.locator('[data-testid="explorer-note"]').nth(1).waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "duplicating a note adds a copy",
    (await page.locator('[data-testid="explorer-note"]').count()) === 2,
  );

  // Selecting a diagram leaves note mode, which the invalid-DSL checks below
  // need (they drive the DSL editor).
  await page.locator('[data-testid="select-diagram-button"]').first().click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("selecting a diagram leaves note mode", true);

  console.log("\nInvalid DSL degrades gracefully:");
  // A syntax error is reported, but the parser recovers a partial tree, so the
  // preview keeps rendering rather than blanking out.
  await page.locator('[data-testid="dsl-textarea"]').fill(SYNTAX_ERROR_SOURCE);
  await page.locator('[data-testid="dsl-diagnostics"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("syntax error is listed as a diagnostic", true);

  // A semantic error yields a valid tree with an unresolved participant, which
  // is what drives the preview's empty state.
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(SEMANTIC_ERROR_SOURCE);
  const empty = page.locator('[data-testid="preview-empty"]');
  await empty.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  check("unresolved participant shows the empty state", true);
  check(
    "empty state points at the issue count",
    /Fix 1 issue to preview/.test((await empty.textContent()) ?? ""),
  );
  console.log("\nDocumentation workspace:");
  // A fresh project so the tab strip, search, and archive checks below start from
  // a known state. Tabs are workspace-wide, so the count is captured rather than
  // assumed; each creation waits for its tab to appear, because the editor is
  // already on screen when a document is created and waiting for the editor alone
  // would race the new tab.
  const tabs = page.locator('[data-testid="tab"]');
  const tabsBefore = await tabs.count();
  const waitForTabs = (count) =>
    page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[data-testid="tab"]').length === expected,
      count,
      { timeout: UI_TIMEOUT_MS },
    );
  // Locate a project row by name, so the checks do not depend on the
  // repository's project ordering.
  const projectRow = (name) =>
    page.locator('[data-testid="explorer-project"]').filter({ hasText: name });

  await page.locator('[data-testid="project-name-input"]').fill("Workspace");
  await page.locator('[data-testid="create-project-button"]').click();

  await projectRow("Workspace")
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-diagram"]').click();
  await waitForTabs(tabsBefore + 1);
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Checkout",
        "participant CartService",
        "participant PaymentService",
        "CartService ->> PaymentService: SEARCHMARKER",
      ].join("\n"),
    );

  await projectRow("Workspace")
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-note"]').click();
  await waitForTabs(tabsBefore + 2);
  await page.locator('[data-testid="markdown-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page
    .locator('[data-testid="markdown-textarea"]')
    .fill(
      [
        "# Handbook",
        "",
        "| Step | Owner |",
        "| --- | --- |",
        "| Authorize | PaymentService |",
      ].join("\n"),
    );

  // Both kinds share one strip: the diagram tab and the document tab coexist.
  check(
    "a diagram and a document open in one tab strip",
    (await tabs.count()) === tabsBefore + 2,
    `${tabsBefore} → ${await tabs.count()}`,
  );
  check(
    "each tab names its document kind",
    (await tabs.nth(tabsBefore).getAttribute("data-kind")) === "diagram" &&
      (await tabs.nth(tabsBefore + 1).getAttribute("data-kind")) === "note",
  );
  check(
    "the markdown document renders a table",
    (await page.locator('[data-testid="markdown-body"] table').count()) === 1,
  );
  check(
    "a table cell carries its text",
    (
      (await page
        .locator('[data-testid="markdown-body"] table td')
        .first()
        .textContent()) ?? ""
    ).includes("Authorize"),
  );

  // Project-wide search spans both kinds and lands the caret on the match.
  await page.keyboard.press("Control+Shift+F");
  await page.locator('[data-testid="search-panel"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page.locator('[data-testid="search-input"]').fill("SEARCHMARKER");
  await page.locator('[data-testid="search-result"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "search finds text inside a diagram",
    (await page.locator('[data-testid="search-result"]').count()) === 1,
  );
  await page.locator('[data-testid="search-result-button"]').first().click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const selection = await page
    .locator('[data-testid="dsl-textarea"]')
    .evaluate((element) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      selected: element.value.slice(
        element.selectionStart,
        element.selectionEnd,
      ),
    }));
  check(
    "opening a result selects the matching text",
    selection.selected === "SEARCHMARKER",
    `selected ${JSON.stringify(selection.selected)}`,
  );
  // A `participant:` query lists the documents declaring that participant.
  await page.keyboard.press("Control+Shift+F");
  await page
    .locator('[data-testid="search-input"]')
    .fill("participant:CartService");
  await page.locator('[data-testid="search-result"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "a participant query finds the declaring diagram",
    (await page.locator('[data-testid="search-result"]').count()) === 1,
  );
  await page.keyboard.press("Escape");
  check(
    "Escape dismisses the search overlay",
    (await page.locator('[data-testid="search-panel"]').count()) === 0,
  );

  // Export the project as a ZIP and import that exact file back.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.locator('[data-testid="command-palette-button"]').click();
      await page
        .locator('[data-testid="palette-input"]')
        .fill("Export Project");
      await page.locator('[data-testid="palette-item-button"]').first().click();
    })(),
  ]);
  check(
    "Export Project downloads a named ZIP",
    download.suggestedFilename() === "Workspace.zip",
    download.suggestedFilename(),
  );

  const archivePath = await download.path();
  await page
    .locator('[data-testid="import-file-input"]')
    .setInputFiles(archivePath);
  // The import is asynchronous, so wait for the third project to appear.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="explorer-project"]').length ===
      3,
    undefined,
    { timeout: UI_TIMEOUT_MS },
  );
  check("importing the exported archive adds the project", true);

  // The imported project becomes the selected one, so the explorer shows its
  // files and the first of them is loaded. Scope the file counts to that
  // project's own row: counting `explorer-diagram` across the whole explorer
  // measures every other project's files too, which is what made this assertion
  // fail once the suite had created projects of its own.
  const importedRow = page.locator(
    '[data-testid="explorer-project"][aria-current="true"]',
  );
  const importedSource = await waitForText(
    page.locator('[data-testid="dsl-textarea"]'),
    (text) => text.includes("SEARCHMARKER"),
    "imported diagram source",
  );
  check(
    "the imported document keeps its content",
    importedSource.includes("CartService"),
  );
  // An import writes its files one by one, so the note can still be arriving when
  // the diagram is already open. Waiting for it makes the count below a fact
  // rather than a race.
  await importedRow
    .locator('[data-testid="explorer-note"]')
    .first()
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  const importedDiagrams = await importedRow
    .locator('[data-testid="explorer-diagram"]')
    .count();
  const importedNotes = await importedRow
    .locator('[data-testid="explorer-note"]')
    .count();
  check(
    "the imported project carries its files",
    importedDiagrams === 1 && importedNotes === 1,
    `${importedDiagrams} diagram(s), ${importedNotes} note(s)`,
  );

  console.log("\nProject intelligence:");
  // A dedicated project, so every check below starts from a known state rather
  // than from whichever document the earlier sections happened to leave open.
  const intelRow = page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Intel" });
  const tabsAtIntel = await page.locator('[data-testid="tab"]').count();
  await page.locator('[data-testid="project-name-input"]').fill("Intel");
  await page.locator('[data-testid="create-project-button"]').click();

  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Intel" })
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-diagram"]').click();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid="tab"]').length === expected,
    tabsAtIntel + 1,
    { timeout: UI_TIMEOUT_MS },
  );
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Checkout",
        "participant CartService",
        "participant PaymentService",
        "",
        "CartService ->> PaymentService: Authorize",
      ].join("\n"),
    );

  // The outline describes the diagram's structure.
  await page.locator('[data-testid="view-outline"]').click();
  await page.locator('[data-testid="outline"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  // Section rows start collapsed; the first toggle belongs to "Participants".
  await page.locator('[data-testid="outline-item-toggle"]').first().click();
  const outlineText =
    (await page.locator('[data-testid="outline"]').textContent()) ?? "";
  check(
    "the outline lists the diagram's participants",
    outlineText.includes("CartService") &&
      outlineText.includes("PaymentService"),
  );
  check("the outline lists the diagram's flow", outlineText.includes("Flow"));

  // A document with a broken link becomes a project diagnostic.
  await page.locator('[data-testid="view-code"]').click();
  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Intel" })
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-note"]').click();
  await page.locator('[data-testid="markdown-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page
    .locator('[data-testid="markdown-textarea"]')
    .fill("# Handbook\n\nSee [gone](nowhere.seq).");

  await page.locator('[data-testid="view-problems"]').click();
  await page.locator('[data-testid="problem-item"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const brokenProblem = page
    .locator('[data-testid="problem-item"]')
    .filter({ hasText: "nowhere.seq" })
    .first();
  await brokenProblem.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  check("a broken link raises a project problem", true);
  check(
    "the problem names the link that does not resolve",
    ((await brokenProblem.textContent()) ?? "").includes("nowhere.seq"),
  );
  check(
    "the problem is a warning, not an error",
    (await brokenProblem.getAttribute("data-severity")) === "warning",
  );

  // Quick open reaches a resource by name.
  await page.keyboard.press("Control+p");
  await page.locator('[data-testid="quick-open"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page.locator('[data-testid="quick-open-input"]').fill("checkout");
  await page.locator('[data-testid="quick-open-item"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  await page.locator('[data-testid="quick-open-item"]').first().click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("quick open opens a diagram by name", true);

  // Semantic completion offers the project's participants after an arrow.
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Checkout",
        "participant CartService",
        "participant PaymentService",
        "",
        "CartService ->> PaymentService: Authorize",
        "CartService -> ",
      ].join("\n"),
    );
  // `fill` sets the value without moving the caret reliably, and completion is
  // answered for the caret, so put it at the end of the line first.
  await page.locator('[data-testid="dsl-textarea"]').press("End");
  await page.locator('[data-testid="completions"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const completionText =
    (await page.locator('[data-testid="completions"]').textContent()) ?? "";
  check(
    "completion offers the participants this project declares",
    completionText.includes("PaymentService"),
  );

  // Clicking a rendered message selects exactly that statement in the source.
  await page.locator('[data-testid="dsl-textarea"]').press("Escape");
  // A message is drawn as a horizontal `<line>`, whose bounding box has no
  // height — Playwright therefore refuses a real click. The delegated handler is
  // what is under test, so the event is dispatched directly.
  await page
    .locator('[data-testid="preview-svg"] [data-node-id^="message@"]')
    .first()
    .dispatchEvent("click");
  const selectedText = await page
    .locator('[data-testid="dsl-textarea"]')
    .evaluate((element) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    );
  check(
    "clicking a rendered message selects its source statement",
    selectedText.includes("Authorize"),
    `selected ${JSON.stringify(selectedText)}`,
  );

  // ... and the caret's statement is highlighted on the canvas in return.
  check(
    "the caret's statement is highlighted on the canvas",
    (await page
      .locator('[data-testid="preview-svg"] .svg-node--active')
      .count()) === 1,
  );

  console.log("\nEvent flows:");
  // A second documentation language, created and rendered in the same shell.
  await page.locator('[data-testid="project-name-input"]').fill("Orders");
  await page.locator('[data-testid="create-project-button"]').click();
  // Creating a document is asynchronous, and the editor was already on screen, so
  // waiting for the editor alone would let the fill below race the create and be
  // overwritten by the new, empty document. The tab appearing is the concrete
  // signal that the created document is the one on screen (the same wait the
  // "Workspace" and "Intel" sections already use).
  const tabsBeforeFlow = await page.locator('[data-testid="tab"]').count();
  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Orders" })
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-event-flow"]').click();
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid="tab"]').length === expected,
    tabsBeforeFlow + 1,
    { timeout: UI_TIMEOUT_MS },
  );
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check(
    "New Event Flow creates a .eventseq document",
    (
      await page
        .locator('[data-testid="explorer-diagram"]')
        .last()
        .textContent()
    )?.includes(".eventseq") === true,
  );

  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Order Processing",
        "event OrderCreated",
        "topic orders",
        "producer OrderService",
        "consumer BillingService",
        "OrderService publishes OrderCreated to orders",
        "BillingService consumes OrderCreated from orders",
      ].join("\n"),
    );
  await page.locator('[data-testid="preview-svg"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const eventSvg = await page
    .locator('[data-testid="preview-svg"]')
    .textContent();
  check(
    "an event flow renders its event, producer and consumer",
    (eventSvg ?? "").includes("OrderCreated") &&
      (eventSvg ?? "").includes("OrderService") &&
      (eventSvg ?? "").includes("BillingService"),
  );
  check(
    "the rendered event is addressable for source navigation",
    (await page
      .locator('[data-testid="preview-svg"] [data-node-id^="event@"]')
      .count()) === 1,
  );
  check(
    "the status bar counts the events the flow declares",
    (
      (await page
        .locator('[data-testid="status-participants"]')
        .textContent()) ?? ""
    ).includes("1 event"),
  );

  // A normal laptop viewport must keep the DSL editor inside the workspace;
  // this is the regression for the diagram editor overlapping the status bar.
  await page.setViewportSize({ width: 1440, height: 720 });
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      Array.from({ length: 80 }, (_, index) => `event Event${index}`).join(
        "\n",
      ),
    );
  const scrollBounds = await page.evaluate(() => {
    const textarea = document.querySelector('[data-testid="dsl-textarea"]');
    const code = document.querySelector(".editor__code");
    if (!(textarea instanceof HTMLTextAreaElement) || !code) return null;
    textarea.scrollTop = textarea.scrollHeight;
    const textareaBounds = textarea.getBoundingClientRect();
    return {
      canScroll: textarea.scrollHeight > textarea.clientHeight,
      didScroll: textarea.scrollTop > 0,
      textareaBottom: textareaBounds.bottom,
      codeBottom: code.getBoundingClientRect().bottom,
    };
  });
  check(
    "event-flow editor scrolls long source",
    scrollBounds?.canScroll === true && scrollBounds.didScroll,
    scrollBounds
      ? `${scrollBounds.canScroll}/${scrollBounds.didScroll}`
      : "missing editor",
  );
  check(
    "event-flow textarea stays inside the code area",
    (scrollBounds?.textareaBottom ?? 0) <=
      (scrollBounds?.codeBottom ?? 0) + 0.5,
    scrollBounds
      ? `${scrollBounds.textareaBottom.toFixed(2)} vs ${scrollBounds.codeBottom.toFixed(2)}`
      : "missing editor",
  );
  const flowEditorBounds = await page.evaluate(() => ({
    editorBottom:
      document
        .querySelector('[aria-label="Event flow editor"]')
        ?.getBoundingClientRect().bottom ?? 0,
    statusbarTop:
      document.querySelector(".app__statusbar")?.getBoundingClientRect().top ??
      0,
  }));
  check(
    "event-flow editor stays above the status bar at laptop height",
    flowEditorBounds.editorBottom <= flowEditorBounds.statusbarTop + 0.5,
    `${flowEditorBounds.editorBottom.toFixed(2)} vs ${flowEditorBounds.statusbarTop.toFixed(2)}`,
  );
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill(
      [
        "title Order Processing",
        "event OrderCreated",
        "topic orders",
        "producer OrderService",
        "consumer BillingService",
        "OrderService publishes OrderCreated to orders",
        "BillingService consumes OrderCreated from orders",
      ].join("\n"),
    );

  console.log("\nEvent-flow highlighting:");
  const flowEditor = page.locator('[data-testid="dsl-textarea"]');
  const boldEventNames = await page
    .locator('[data-testid="editor-highlight"] strong')
    .allTextContents();
  check(
    "event, broker, channel and service names are bolded",
    ["OrderCreated", "orders", "OrderService", "BillingService"].every((name) =>
      boldEventNames.includes(name),
    ),
    boldEventNames.join(", "),
  );
  check(
    "event-flow highlight mirrors the source",
    (await page.locator('[data-testid="editor-highlight"]').textContent()) ===
      (await flowEditor.inputValue()),
  );
  // Retyping an event's name carries the edges that reference it, so the flow
  // never collapses into "unknown event" mid-edit.
  await flowEditor.evaluate((el) => {
    el.focus();
    const at =
      el.value.indexOf("event OrderCreated") + "event OrderCreated".length;
    el.setSelectionRange(at, at);
  });
  await page.keyboard.type("V2");
  const renamedFlow = await flowEditor.inputValue();
  check(
    "renaming an event rewrites its edges",
    renamedFlow.includes("OrderService publishes OrderCreatedV2 to orders") &&
      renamedFlow.includes(
        "BillingService consumes OrderCreatedV2 from orders",
      ),
    renamedFlow,
  );

  console.log("\nEvent-driven diagnostics:");
  // A design mistake an event-driven review exists to catch.
  await page
    .locator('[data-testid="dsl-textarea"]')
    .fill("event Lonely\nGhost publishes Nowhere");
  await page.locator('[data-testid="view-problems"]').click();
  await page.locator('[data-testid="problem-item"]').first().waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  const problemText =
    (await page.locator('[data-testid="problems"]').textContent()) ?? "";
  check(
    "an undeclared producer is reported",
    problemText.includes("Unknown service"),
  );
  check(
    "an event nothing publishes is reported",
    problemText.includes("has no producer"),
  );

  check(
    "still no uncaught page errors",
    consoleErrors.length === 0,
    consoleErrors.join("; "),
  );

  await page.close();
}

/**
 * Drive the authenticated server scenarios.
 *
 * Each scenario opens its own browser contexts, so cookies and sessions never
 * leak between them: two contexts signed in as different people must not share a
 * session, and an anonymous context must genuinely start with no session.
 */
async function runServerChecks(browser, idp, apiBase, mcpBase) {
  const owner = {
    sub: "e2e-owner",
    name: "E2E Owner",
    email: "owner@e2e.test",
  };
  const viewer = {
    sub: "e2e-viewer",
    name: "E2E Viewer",
    email: "viewer@e2e.test",
  };

  await scenario(
    "Server scenario 1: a server project's diagram survives a reload",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(page);

        await signIn(page, idp, owner);
        check(
          "signing in through the local provider exposes the session",
          true,
        );

        await createServerProject(page, "Alpha Server");
        check("creating a server project opens it in the explorer", true);

        await createDocument(page, "Alpha Server", "context-menu-new-diagram");
        await page.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check("a sequence diagram can be created in a server project", true);

        await page
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Alpha Server",
              "participant Client",
              "participant Service",
              `Client ->> Service: ${SERVER_MARKER}`,
              "",
            ].join("\n"),
          );
        const saved = await waitForServerContent(
          page,
          "Alpha Server",
          (content) => content.includes(SERVER_MARKER),
          "the server-side save",
        );
        check(
          "the edit reaches the server, not just the browser",
          saved.content.includes(SERVER_MARKER),
        );

        await page.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(page, "Alpha Server");
        await page.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        const reopened = await waitForInputValue(
          page.locator('[data-testid="dsl-textarea"]'),
          (value) => value.includes(SERVER_MARKER),
          "the reopened diagram",
        );
        check(
          "after a reload the project reopens its document",
          reopened.includes(`Client ->> Service: ${SERVER_MARKER}`),
        );
      } finally {
        await context.close();
      }
    },
  );

  await scenario(
    "Server scenario 2: a server project's markdown document survives a reload",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(page);
        await signIn(page, idp, owner);

        await createServerProject(page, "Docs Server");
        await createDocument(page, "Docs Server", "context-menu-new-note");
        await page.locator('[data-testid="markdown-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check("a markdown document can be created in a server project", true);

        await page
          .locator('[data-testid="markdown-textarea"]')
          .fill(
            ["# Server Handbook", "", `Runbook ${MARKDOWN_MARKER}.`].join("\n"),
          );
        const saved = await waitForServerContent(
          page,
          "Docs Server",
          (content) => content.includes(MARKDOWN_MARKER),
          "the markdown save",
        );
        check(
          "the markdown edit reaches the server",
          saved.content.includes(MARKDOWN_MARKER),
        );

        await page.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(page, "Docs Server");
        await page.locator('[data-testid="markdown-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        const reopened = await waitForInputValue(
          page.locator('[data-testid="markdown-textarea"]'),
          (value) => value.includes(MARKDOWN_MARKER),
          "the reopened markdown document",
        );
        check(
          "after a reload the markdown document reopens with its content",
          reopened.includes(MARKDOWN_MARKER),
        );
      } finally {
        await context.close();
      }
    },
  );

  await scenario(
    "Server scenario 3: a stale write raises the conflict dialog",
    async () => {
      const ownerContext = await browser.newContext();
      const otherContext = await browser.newContext();
      const ownerPage = await ownerContext.newPage();
      const otherPage = await otherContext.newPage();
      try {
        // The owner creates the shared document.
        await ownerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(ownerPage);
        await signIn(ownerPage, idp, owner);
        await createServerProject(ownerPage, "Conflict Server");
        await createDocument(
          ownerPage,
          "Conflict Server",
          "context-menu-new-diagram",
        );
        await ownerPage.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await ownerPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Conflict",
              "participant A",
              "participant B",
              `A ->> B: ${CONFLICT_BASE}`,
              "",
            ].join("\n"),
          );
        await waitForServerContent(
          ownerPage,
          "Conflict Server",
          (content) => content.includes(CONFLICT_BASE),
          "the first save",
        );

        // The second context reads the same document, and so holds the revision
        // the first save produced.
        await otherPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(otherPage);
        await signIn(otherPage, idp, owner);
        await openServerProject(otherPage, "Conflict Server");
        await otherPage.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await waitForInputValue(
          otherPage.locator('[data-testid="dsl-textarea"]'),
          (value) => value.includes(CONFLICT_BASE),
          "the second editor's read",
        );
        check("a second context opens the same server document", true);

        // The owner writes first, moving the server past the revision the second
        // context read.
        await ownerPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Conflict",
              "participant A",
              "participant B",
              `A ->> B: ${CONFLICT_OWNER}`,
              "",
            ].join("\n"),
          );
        await waitForServerContent(
          ownerPage,
          "Conflict Server",
          (content) => content.includes(CONFLICT_OWNER),
          "the owner's second save",
        );

        // The second context saves from its now-stale revision.
        await otherPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Conflict",
              "participant A",
              "participant B",
              `A ->> B: ${CONFLICT_LOCAL}`,
              "",
            ].join("\n"),
          );
        await otherPage
          .locator('[data-testid="save-conflict-dialog"]')
          .waitFor({
            state: "visible",
            timeout: UI_TIMEOUT_MS,
          });
        check("a write from a stale revision raises the conflict dialog", true);
        check(
          "the local edit is still in the editor while the dialog is open",
          (
            await otherPage.locator('[data-testid="dsl-textarea"]').inputValue()
          ).includes(CONFLICT_LOCAL),
        );

        const afterConflict = await waitForServerContent(
          otherPage,
          "Conflict Server",
          (content) => content.includes(CONFLICT_OWNER),
          "the owner's content after the refused write",
        );
        check(
          "the refused write did not reach the server",
          !afterConflict.content.includes(CONFLICT_LOCAL),
        );

        await otherPage.locator('[data-testid="save-conflict-reload"]').click();
        await otherPage
          .locator('[data-testid="save-conflict-dialog"]')
          .waitFor({ state: "detached", timeout: UI_TIMEOUT_MS });
        const reloaded = await waitForInputValue(
          otherPage.locator('[data-testid="dsl-textarea"]'),
          (value) => value.includes(CONFLICT_OWNER),
          "the reloaded server version",
        );
        check(
          "reloading the server version shows the owner's content",
          reloaded.includes(CONFLICT_OWNER),
        );
        check(
          "the local edit is gone after taking the server version",
          !reloaded.includes(CONFLICT_LOCAL),
        );
      } finally {
        await ownerContext.close();
        await otherContext.close();
      }
    },
  );

  await scenario(
    "Server scenario 4: a VIEWER can read but cannot write",
    async () => {
      const ownerContext = await browser.newContext();
      const viewerContext = await browser.newContext();
      const ownerPage = await ownerContext.newPage();
      const viewerPage = await viewerContext.newPage();
      try {
        await ownerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(ownerPage);
        await signIn(ownerPage, idp, owner);
        await createServerProject(ownerPage, "Viewer Server");
        await createDocument(
          ownerPage,
          "Viewer Server",
          "context-menu-new-diagram",
        );
        await ownerPage.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await ownerPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Viewer",
              "participant A",
              "participant B",
              `A ->> B: ${VIEWER_MARKER}`,
              "",
            ].join("\n"),
          );
        await waitForServerContent(
          ownerPage,
          "Viewer Server",
          (content) => content.includes(VIEWER_MARKER),
          "the owner's save",
        );

        // The second person signs in, and the owner adds them as a viewer.
        await viewerPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(viewerPage);
        await signIn(viewerPage, idp, viewer);
        const me = await apiRequest(viewerPage, "/api/me");
        const viewerId = me.json?.user?.id;
        check(
          "the second sign-in created a distinct account",
          typeof viewerId === "string" && viewerId !== "",
        );

        const owned = await currentServerResource(ownerPage, "Viewer Server");
        const projectDetails = await apiRequest(
          ownerPage,
          `/api/projects/${owned.projectId}`,
        );
        const workspaceId = projectDetails.json?.project?.workspaceId;
        const workspaceMembership = await apiRequest(
          ownerPage,
          `/api/workspaces/${workspaceId}/members/${viewerId}`,
          { method: "PUT", body: JSON.stringify({ role: "VIEWER" }) },
        );
        check(
          "the owner can add the second user to the project workspace",
          workspaceMembership.status === 200,
          `status ${workspaceMembership.status}`,
        );
        const membership = await apiRequest(
          ownerPage,
          `/api/projects/${owned.projectId}/members/${viewerId}`,
          { method: "PUT", body: JSON.stringify({ role: "VIEWER" }) },
        );
        check(
          "the owner can add the second user as a VIEWER",
          membership.status === 204,
          `status ${membership.status}`,
        );

        // The viewer's project list was read before the membership existed, so a
        // reload is what makes the shared project appear.
        await viewerPage.reload({ waitUntil: "domcontentloaded" });
        await openServerProject(viewerPage, "Viewer Server");
        await viewerPage.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        const read = await waitForInputValue(
          viewerPage.locator('[data-testid="dsl-textarea"]'),
          (value) => value.includes(VIEWER_MARKER),
          "the viewer's read",
        );
        check(
          "a viewer can open and read the project",
          read.includes(VIEWER_MARKER),
        );

        // The viewer's edit is refused before it ever leaves the browser, and the
        // shell says so rather than failing silently.
        await viewerPage
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Viewer",
              "participant A",
              "participant B",
              "A ->> B: VIEWEREDIT",
              "",
            ].join("\n"),
          );
        await viewerPage.locator('[data-testid="save-error"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check("the read-only editor surfaces the refused save", true);

        const afterEdit = await currentServerResource(
          viewerPage,
          "Viewer Server",
        );
        check(
          "the viewer's edit never reached the server",
          afterEdit.content.includes(VIEWER_MARKER) &&
            !afterEdit.content.includes("VIEWEREDIT"),
        );

        // More important than the UI: the server refuses the write itself, even
        // with the revision it currently holds.
        const refused = await apiRequest(
          viewerPage,
          `/api/projects/${afterEdit.projectId}/resources/${afterEdit.resource.id}`,
          {
            method: "PUT",
            body: JSON.stringify({
              content: "VIEWEROVERRIDE",
              expectedRevision: afterEdit.resource.revision,
            }),
          },
        );
        check(
          "the server refuses a viewer's write with 403",
          refused.status === 403,
          `status ${refused.status}`,
        );

        // The explorer's create affordance is refused too, which is what an
        // operator actually clicks.
        const viewerRow = viewerPage
          .locator('[data-testid="explorer-project"]')
          .filter({ hasText: "Viewer Server" });
        const before = await viewerRow
          .locator('[data-testid="explorer-diagram"]')
          .count();
        await addDocument(
          viewerPage,
          "Viewer Server",
          "context-menu-new-diagram",
        );
        await viewerPage.locator('[data-testid="workspace-error"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check(
          "the read-only project refuses a create with a visible error",
          true,
        );
        check(
          "no diagram was created in the read-only project",
          (await viewerRow
            .locator('[data-testid="explorer-diagram"]')
            .count()) === before,
          `${before} -> ${await viewerRow
            .locator('[data-testid="explorer-diagram"]')
            .count()}`,
        );
      } finally {
        await ownerContext.close();
        await viewerContext.close();
      }
    },
  );

  await scenario(
    "Server scenario 5: an anonymous visitor keeps the local workspace",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await page.locator('[data-testid="login-page"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        check(
          "an anonymous visitor is kept on the login screen",
          true,
        );
        check(
          "the application shell is hidden while signed out",
          (await page.locator('[data-testid="app-shell"]').count()) === 0,
        );
        check(
          "Google sign-in is available on the login screen",
          (await page.locator('[data-testid="login-google"]').count()) === 1,
        );
        check(
          "local workspace controls are hidden while signed out",
          (await page.locator('[data-testid="project-name-input"]').count()) === 0,
        );
      } finally {
        await context.close();
      }
    },
  );

  await scenario(
    "Server scenario 6: an agent credential reads, cannot write, and revokes",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
        await waitForAuthEntry(page);
        await signIn(page, idp, owner);

        // The browser writes a document the agent will read.
        await createServerProject(page, "Agent Project");
        await createDocument(page, "Agent Project", "context-menu-new-diagram");
        await page.locator('[data-testid="dsl-textarea"]').waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await page
          .locator('[data-testid="dsl-textarea"]')
          .fill(
            [
              "title Agent Project",
              "participant One",
              "participant Two",
              `One ->> Two: ${AGENT_MARKER}`,
              "",
            ].join("\n"),
          );
        await waitForServerContent(
          page,
          "Agent Project",
          (content) => content.includes(AGENT_MARKER),
          "the browser's save",
        );
        check("the browser saves a document the agent will read", true);

        // 1. The user creates an agent and a read-only credential.
        await page.locator('[data-testid="open-agents"]').click();
        await page.locator('[data-testid="agent-name"]').fill("E2E Agent");
        await page.locator('[data-testid="agent-create"]').click();
        const card = page
          .locator('li[data-testid^="agent-"]')
          .filter({ hasText: "E2E Agent" });
        await card.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
        await card
          .locator('[data-testid^="agent-credentials-"]')
          .first()
          .click();
        const createButton = card.locator(
          '[data-testid^="credential-create-"]',
        );
        await createButton.waitFor({
          state: "visible",
          timeout: UI_TIMEOUT_MS,
        });
        await createButton.click();
        const secret = await page
          .locator('[data-testid="credential-secret"]')
          .inputValue();
        check(
          "an agent credential is created and its secret is shown once",
          secret.startsWith("sdm_pat_"),
          secret.slice(0, 16),
        );
        await page.locator('[data-testid="credential-dismiss"]').click();

        const project = await serverProjectByName(page, "Agent Project");
        if (project === null) throw new Error("Agent Project was not created");

        // 2. A machine client authenticates with the credential alone.
        const handshake = await remoteMcp(mcpBase, secret, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          // A complete initialize: the SDK's schema requires the client's
          // capabilities and identity as well as the requested version.
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "sequencediagrams-e2e", version: "1.0.0" },
          },
        });
        check(
          "the agent authenticates with its credential",
          handshake.status === 200 &&
            handshake.json?.result?.serverInfo?.name === "sequencediagrams-mcp",
          `status ${handshake.status}`,
        );

        // 3. A read-only credential is not even offered the write tools.
        const tools = await remoteMcp(mcpBase, secret, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        });
        const names = (tools.json?.result?.tools ?? []).map(
          (tool) => tool.name,
        );
        check(
          "a read-only credential is offered reads and not writes",
          names.includes("read_resource") && !names.includes("create_resource"),
          names.join(", "),
        );

        // 4. It reads the document the browser wrote.
        const resources = await remoteTool(
          mcpBase,
          secret,
          3,
          "list_resources",
          { projectId: project.id },
        );
        const resource = resources?.structuredContent?.resources?.[0];
        const read = await remoteTool(mcpBase, secret, 4, "read_resource", {
          projectId: project.id,
          resource: resource?.id,
        });
        check(
          "the agent reads the document on the server",
          (read?.structuredContent?.content ?? "").includes(AGENT_MARKER),
        );

        // 5. It cannot write.
        const write = await remoteTool(mcpBase, secret, 5, "create_resource", {
          projectId: project.id,
          path: "agent-created.seq",
          type: "sequence-diagram",
          content: "One ->> Two: nope",
        });
        // The write tool is not even registered for this credential, so the
        // refusal is a tool error rather than a successful call.
        check(
          "the read-only credential is refused every write",
          write?.isError === true,
          write?.content?.[0]?.text,
        );

        // 6. Revoking the credential stops it immediately.
        const revokeButton = card
          .locator('[data-testid^="credential-revoke-"]')
          .first();
        await revokeButton.click();
        await card
          .locator('[data-testid^="credential-revoke-confirm-"]')
          .click();
        await waitForText(
          card,
          (text) => text.includes("revoked"),
          "the revoked credential row",
        );
        check("the credential can be revoked from the agents screen", true);

        const afterRevoke = await remoteMcp(mcpBase, secret, {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/list",
        });
        check(
          "the revoked credential is rejected immediately",
          afterRevoke.status === 401,
          `status ${afterRevoke.status}`,
        );
      } finally {
        await context.close();
      }
    },
  );
}

async function main() {
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    throw new Error(
      "dist/index.html is missing; run `npm run build` first (npm run test:e2e does it for you).",
    );
  }

  const apiPort = await findFreePort(API_PORT);
  const idpPort = await findFreePort(IDP_PORT);
  const idp = await startIdentityProvider({ port: idpPort });
  const projectVolume = await mkdtemp(join(tmpdir(), "sdm-e2e-projects-"));

  // `vite preview` reads this while it builds its proxy table, and the child
  // inherits the environment, so the browser's `/api` and `/auth` calls reach the
  // API that belongs to *this* run.
  process.env.SDM_API_TARGET = `http://127.0.0.1:${apiPort}`;

  const mcpPort = await findFreePort(MCP_PORT);

  let api;
  let mcp;
  let server;
  let browser;
  try {
    api = await startApiServer({
      port: apiPort,
      projectVolume,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
    });
    // The MCP service is a real host on its own port, sharing the API's runtime
    // so a browser write and an agent read see the same project.
    mcp = await startMcpService({
      port: mcpPort,
      runtime: api.runtime,
      publicUrl: `http://127.0.0.1:${mcpPort}`,
      projectVolume,
    });
    server = await startPreviewServer();
    browser = await chromium.launch();
    // The existing checks run in a window tall enough that the whole explorer
    // tree is visible without scrolling; see `runChecks` for why that matters.
    const checksContext = await browser.newContext({
      viewport: { width: 1440, height: 1600 },
    });
    const checksPage = await checksContext.newPage();
    await runChecks(checksPage, idp);
    await checksContext.close();
    await runServerChecks(
      browser,
      idp,
      `http://127.0.0.1:${apiPort}`,
      mcp.mcpBase,
    );
  } finally {
    await browser?.close().catch(() => {});
    server?.kill("SIGTERM");
    await mcp?.close().catch(() => {});
    await api?.close().catch(() => {});
    await idp.close().catch(() => {});
    await rm(projectVolume, { recursive: true, force: true }).catch(() => {});
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`E2E smoke test FAILED (${failures.length} check(s))`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("E2E smoke test passed.");
}

main().catch((error) => {
  console.error(`\nE2E smoke test could not run: ${error.message}`);
  if (
    /Executable doesn't exist|browserType\.launch/.test(String(error.message))
  ) {
    console.error(
      "Install the browser once with: npx playwright install chromium",
    );
  }
  process.exitCode = 1;
});
