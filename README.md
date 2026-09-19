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
**Phase 2 — Layout + SVG Rendering**, and **Phase 3 — Interactive Live Editor**
are complete and committed on `master`. The branch builds, serves, lints,
type-checks, and passes its baseline test suite (81 tests).

Phase 3 wires the pipeline into a live, IDE-style editor. The app shell now owns
the DSL source and feeds one memoized analysis to both panes: the editor
(`src/features/editor`) shows the source with a diagnostics list, and the preview
(`src/features/preview`) renders the SVG. The preview pipeline
(`src/features/preview/diagram-to-svg.ts`) is the only place the UI reaches
across the language → layout → renderer layers, so the editor never computes
geometry and the renderer never parses text. See `src/features/` for the new
React feature modules.
