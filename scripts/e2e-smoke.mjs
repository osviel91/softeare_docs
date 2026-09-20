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
  // files and the first of them is loaded.
  const importedSource = await waitForText(
    page.locator('[data-testid="dsl-textarea"]'),
    (text) => text.includes("SEARCHMARKER"),
    "imported diagram source",
  );
  check(
    "the imported document keeps its content",
    importedSource.includes("CartService"),
  );
  check(
    "the imported project carries its files",
    (await page.locator('[data-testid="explorer-diagram"]').count()) === 1 &&
      (await page.locator('[data-testid="explorer-note"]').count()) === 1,
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
  await page
    .locator('[data-testid="explorer-project"]')
    .filter({ hasText: "Orders" })
    .locator('[data-testid="project-add-button"]')
    .click();
  await page.locator('[data-testid="context-menu-new-event-flow"]').click();
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
