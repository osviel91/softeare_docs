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
`npm run format`, `npm run format:check`, `npm run typecheck`.

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
  editor/         Editor adapter (CodeMirror now, others pluggable)
  workspace/      Persistence abstraction + implementations
  features/       React feature modules (explorer, editor, preview, ...)
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

**Phase 0 — Repository Foundation**, **Phase 1 — Sequence Language Core**,
**Phase 2 — Layout + SVG Rendering**, **Phase 3 — Interactive Live Editor**,
**Phase 4 — In-Browser Projects (IndexedDB)**, **Phase 5 — Local Folder Projects
(File System Access API)**, and
**Phase 6 — Editing Productivity (tabs, command palette, search)** are complete
and committed on `master`. The branch builds, serves, lints, type-checks, and
passes its test suite (240 tests).

Phase 7 extends the DSL incrementally. The first construct landed is the
**callout note**: `note left/right of <participant> : text` anchors a note to a
lifeline and `note over [: text]` spans the diagram. It flows fully through the
pipeline — a `note` lexer token, a `NoteNode` in the AST, a `MalformedNote`
diagnostic, parser rules, beside/over lifeline placement in the layout engine,
and a folded note box in the SVG renderer.

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
