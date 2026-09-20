# SequenceDiagrams Manager

A browser-based, **local-first** tool for creating, editing, organizing,
visualizing, and exporting sequence diagrams. It ships its own small DSL with a
dedicated lexer/parser, a layout engine, and an SVG renderer — the diagram
domain is owned by this project, not delegated to an external library.

The vision is a focused, IDE-like editing experience (project explorer + DSL
editor + live preview) that works entirely offline in the browser.

## Design principles

- **Owned domain logic.** The pipeline is `DSL → lexer/parser → AST →
validation → layout → render model → SVG`. The UI consumes this engine; it
  does not contain diagram semantics.
- **Clean boundaries.** The renderer never parses text, the editor never
  computes geometry, the parser does not know about React, and persistence never
  depends on UI components. See [ARCHITECTURE.md](./ARCHITECTURE.md).
- **Simple + correct + extensible** over clever + abstract + unfinished.
- **Pure functions and strong typing** wherever practical. Minimal dependencies.

## Tech stack

- TypeScript, React 18, Vite
- Vitest + Testing Library for tests
- ESLint + Prettier

## Getting started

```bash
npm install   # installs dependencies (uses a project-local cache)
npm run dev   # start the Vite dev server at http://localhost:5173/
npm test      # run the test suite once
npm run build # type-check and produce a production build in dist/
```

Other scripts: `npm run preview`, `npm run lint`, `npm run lint:fix`,
`npm run format`, `npm run format:check`, `npm run typecheck`,
`npm run test:e2e`.

## Testing in a real browser

`npm test` runs the Vitest suite in jsdom, which never proves that the _built_
bundle boots in a browser — bundling, the production React build, asset paths,
and the live editor → preview wiring are all unverified there. `npm run test:e2e`
closes that gap: it builds the production bundle, serves `dist/` with
`vite preview`, and drives it with Chromium through the `playwright` library. It
checks that the app shell mounts, the seeded sample renders to SVG, edits update
the preview live, and invalid DSL surfaces diagnostics instead of crashing.

Install the browser once, then run it:

```bash
npx playwright install chromium
npm run test:e2e
```

The script exits non-zero when any check fails, so it is CI-ready; set `E2E_PORT`
to move it off the default port 4173.

## The interface

The app is a three-pane IDE: **explorer → editor → preview**, under a toolbar and
over a status bar. Everything is themed from one set of CSS custom properties in
`src/styles.css`, so the dark surface stack and the single accent are defined in
one place rather than per component.

- **Editor views.** A `Code` / `Docs` segmented control switches the middle pane
  between the DSL source and a reference for every construct the parser supports
  (`src/features/docs`). A test asserts each documented keyword really lexes as a
  keyword, so the reference cannot drift behind the grammar.
- **Editing.** The editor has a line-number gutter synced to the textarea's scroll
  position, and a **Snippets** menu (`src/features/editor`) that inserts a
  construct at the caret, starting it on its own line unless it is already at one.
- **Auto-update.** With the switch on, the canvas re-renders as you type. Switched
  off, the canvas keeps the last rendered diagram and a **Render** button appears,
  so a large diagram does not re-lay out on every keystroke.
- **Canvas navigation.** The preview is a pan/zoom viewport
  (`src/features/preview/DiagramViewport.tsx`): drag to pan, scroll to zoom
  (anchored on the cursor), arrow keys to pan, and a rail with zoom in/out, fit,
  and reset-to-100%. A minimap in the corner shows the whole diagram with the
  visible region outlined, and clicking or dragging it recenters the view.

The interaction layer is deliberately thin: all of the geometry lives in
`src/features/preview/viewport.ts`, a pure module (`zoomAtPoint`, `fitTransform`,
`panBy`, …) that is unit tested on its own. The viewport itself knows nothing
about diagram semantics — it receives finished SVG markup plus its pixel size, so
panning and zooming never re-render the diagram or re-parse the DSL. The minimap
embeds that SVG as an image rather than inline markup, so a diagram's labels are
not duplicated in the document.

## Docker

The app is a static bundle, so it ships as a two-stage image: a Node stage
builds the production bundle, and an `nginx` stage serves it over HTTP with
client-side-routing fallback.

```bash
docker build -t sequencediagrams:latest .
docker run -d --name sequencediagrams -p 8080:8080 sequencediagrams:latest
# open http://localhost:8080/
```

Stop and remove it with `docker rm -f sequencediagrams`. The image is
reproducible — `node_modules`, `dist`, and the npm cache are excluded via
`.dockerignore`, and the build installs fresh from `package-lock.json`.

## Repository layout

```
src/
  app/            React application shell and (later) routing & commands
  shared/         Framework-agnostic helpers: Result, id factories
  domain/         Domain model: diagram/project/folder (added incrementally)
  language/       DSL lexer, parser, diagnostics, formatter
  layout/         AST -> geometry (independent of SVG)
  renderer/       SVG rendering of the layout model
  workspace/      Persistence abstraction + implementations
  features/       React feature modules:
                    explorer, editor, preview (+ viewport), tabs, commands, docs
tests/            Browser-independent and workflow tests
```

The early structure is intentionally small; layers are added as phases demand
them while keeping the boundaries above intact.

## Development phases

Work proceeds in disciplined, commit-per-phase milestones (see
[ARCHITECTURE.md](./ARCHITECTURE.md#phases)):

0. Repository foundation (this phase)
1. Sequence language core (DSL, parser, diagnostics, validation)
2. Layout + SVG rendering
3. Interactive live editor
4. In-browser projects (IndexedDB)
5. Local folder projects (File System Access API)
6. Editing productivity (tabs, commands, search)
7. DSL v2 constructs (aliases, notes, activations, groups, loops, alt/opt…)
8. Export (SVG, then PNG)

## Status

**Phases 0–6 are complete** and committed on `master`: repository foundation,
sequence language core, layout + SVG rendering, the interactive live editor,
in-browser projects (IndexedDB), local folder projects (File System Access API),
and editing productivity (tabs, command palette, search). The branch builds,
serves, lints, type-checks, and passes its test suite — 331 unit tests plus 32
browser checks against the production bundle (`npm run test:e2e`), and the same
bundle is served by the Docker image.

**Phase 7 (DSL v2) is in progress.** Three constructs have landed:

- **Aliases** — `alias X = participant` binds a shorthand that messages may use
  in place of the full participant name. An alias whose target is undeclared is
  reported as a diagnostic, and aliases may not chain. Layout resolves a
  shorthand to the target lifeline, so an aliased sender's arrow attaches
  correctly instead of falling back to the margin.
- **Callout notes** — `note left/right of <participant> : text` anchors a note to
  a lifeline and `note over [: text]` spans the diagram. It flows fully through
  the pipeline — a `note` lexer token, a `NoteNode` in the AST, a `MalformedNote`
  diagnostic, parser rules, beside/over lifeline placement in the layout engine,
  and a folded note box in the SVG renderer.
- **Activations** — `activate X` / `deactivate X` draw a bar over a lifeline for
  the span in which that participant is working. Bars nest (each level is offset
  so stacked bars stay visible), take no message row of their own, and close at
  the row following their `deactivate`; a bar left open runs to the bottom of the
  message body. A `deactivate` with no open bar is reported, and activations go
  through the same alias resolution as messages, so `activate U` and
  `deactivate User` pair up.

Still to come in Phase 7: groups, loops, and `alt`/`opt` fragments.
Phase 8 (export to SVG, then PNG) has not started.

The **interface** was reworked alongside the language work: a modern dark
three-pane shell with a `Code`/`Docs` view switch, line numbers and snippets in the
editor, an auto-update switch, and a pan/zoom canvas with a minimap. See
[The interface](#the-interface) above. That work also corrected the vertical layout
bands: participant `topY` is now derived from the same title height the message
band uses, so the first message row clears the name boxes instead of landing on
them, and an untitled diagram no longer positions its boxes partly off-canvas.

Phase 3 wires the pipeline into a live, IDE-style editor. The app shell now owns
the DSL source and feeds one memoized analysis to both panes: the editor
(`src/features/editor`) shows the source with a diagnostics list, and the preview
(`src/features/preview`) renders the SVG. The preview pipeline
(`src/features/preview/diagram-to-svg.ts`) is the only place the UI reaches
across the language → layout → renderer layers, so the editor never computes
geometry and the renderer never parses text. See `src/features/` for the new
React feature modules.

Phase 4 adds a local-first workspace of projects and diagram files backed by
IndexedDB. A framework-free `WorkspaceRepository` interface sits above two
implementations — an IndexedDB repository (`src/workspace/indexed-db.ts`, behind
a small promise adapter) and an in-memory fallback — so persistence stays
testable in isolation and the app works even where IndexedDB is unavailable. The
explorer (`src/features/explorer`) manages projects and diagram selection; the
editor saves edits back through a single `useWorkspace` hook. A snapshot
(`src/workspace/serialize.ts`) exports the whole workspace to human-readable JSON
for sharing or as a fallback format.

Phase 5 lets the user open a folder on their machine as the workspace, via the
File System Access API (`window.showDirectoryPicker`). The opened folder _is_ the
workspace: a subdirectory is a project and a file is a diagram, so ids are derived
from paths rather than generated — opening the same folder twice yields the same
ids. The repository holds no cache; every operation reads the current directory
tree, so files changed elsewhere appear immediately. The browser API lives behind
`createFileSystemRepository` (`src/workspace/fs-access/create-file-system-repository.ts`),
which adapts the native handles to a tiny framework-free adapter
(`src/workspace/fs-access/fs-access-adapter.ts`) and feature-detects support. The
explorer swaps the active repository to the folder-backed one when a folder is
open and back to in-browser projects when it is closed.

Phase 6 rounds out editing productivity on top of that workspace: open diagrams
become closable tabs (`src/features/tabs`), a command palette
(`src/features/commands`) exposes the frequent actions — new and empty diagrams,
save, export — from a single keyboard-driven surface, and the explorer gains a
search box that filters diagram names across _every_ project. The search works
because `useWorkspace` (`src/features/explorer/use-workspace.ts`) loads all
projects' diagrams up front into a workspace-wide list (`allDiagrams`), kept
current as files are created, opened, or saved; the explorer filters that list by
name while a query is present, so a diagram from another project resolves even
after navigating away. These stay testable in isolation: the command and tab logic
drive pure state reducers, and the explorer search is covered with the component
rendered against the same folder-backed repository the app uses.
