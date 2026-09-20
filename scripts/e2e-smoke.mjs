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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;
const UI_TIMEOUT_MS = 10_000;

/** A diagram that shares no participant names with the seeded sample. */
const REPLACEMENT_SOURCE = [
  "title Checkout",
  "",
  "participant Browser",
  "participant Gateway",
  "",
  "Browser -> Gateway: Submit order",
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
  "Browser -> Gateway: Submit order",
  "",
].join("\n");

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

/** Start `vite preview` for the built bundle and resolve once it serves. */
async function startPreviewServer() {
  const viteBin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    throw new Error(`Vite binary not found at ${viteBin}; run npm install.`);
  }

  const child = spawn(
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

/** Drive the served app and record every check. */
async function runChecks(browser) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  console.log("\nShell:");
  await page.locator('[data-testid="app-shell"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("app shell mounts", true);
  check(
    "document title is the product name",
    (await page.title()) === "SequenceDiagrams Manager",
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
    "each sync message paints an arrowhead",
    arrowHeads === 2,
    `found ${arrowHeads}`,
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

  console.log("\nEditor views and auto-update:");
  await page.locator('[data-testid="view-docs"]').click();
  await page.locator('[data-testid="dsl-reference"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("docs view shows the DSL reference", true);
  check(
    "the reference documents the activation construct",
    (
      await page.locator('[data-testid="dsl-reference"]').textContent()
    ).includes("activate"),
  );
  await page.locator('[data-testid="view-code"]').click();
  await page.locator('[data-testid="dsl-textarea"]').waitFor({
    state: "visible",
    timeout: UI_TIMEOUT_MS,
  });
  check("code view restores the editor", true);

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
  check(
    "still no uncaught page errors",
    consoleErrors.length === 0,
    consoleErrors.join("; "),
  );

  await page.close();
}

async function main() {
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    throw new Error(
      "dist/index.html is missing; run `npm run build` first (npm run test:e2e does it for you).",
    );
  }

  const server = await startPreviewServer();
  let browser;
  try {
    browser = await chromium.launch();
    await runChecks(browser);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
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
