# Architecture

Architectural notes for **SequenceDiagrams Manager**. This document is kept lean
and is updated as the system grows. It records _why_ decisions were made so the
project stays maintainable and evolvable by its owner.

## 1. Core pipeline

The diagram domain flows through explicit, testable layers:

```
Sequence DSL
     │
     ▼
Lexer / Parser          → produces tokens + a ParseResult<SequenceDiagram>
     │                     (AST + diagnostics)
     ▼
Domain AST              → source-annotated, framework-free model
     │
     ▼
Semantic validation     → participants defined? message targets known?
     │
     ▼
Layout Engine           → pure AST → DiagramLayout (geometry, no SVG)
     │
     ▼
Render Model            → what the renderer draws (derived from layout)
     │
     ▼
SVG Renderer            → deterministic SVG string / DOM nodes
```

Each layer is a pure function of its input and has no knowledge of the layers
above or below it. Tests target each layer independently.

## 2. Hard boundaries (invariant rules)

These are non-negotiable and enforced by design, not by lint:

1. **The renderer never parses text.** It only consumes the layout/render model.
2. **The editor never computes diagram geometry.** It delegates to the layout engine.
3. **The parser does not know React exists.** The language layer has zero UI imports.
4. **Persistence does not depend on UI components.** Repositories are plain TS.
5. **The domain AST does not depend on CodeMirror.** Editor state is mapped into the AST.
6. **File APIs live behind a repository/adapter.** React never touches `window.showDirectoryPicker` directly.
7. **Every DSL feature flows through Grammar → AST → Validation → Layout → Renderer.**

## 3. Shared foundation (`src/shared`)

- **`result/result.ts`** — a tiny, dependency-free `Result<T, E>` type plus
  `ok`, `err`, `isOk`, `isErr`, `map`, `mapErr`. Expected failures (bad input,
  missing files) are values, not exceptions, so callers decide how to surface
  them. This keeps the editor responsive even while typing invalid DSL.
- **`ids/ids.ts`** — pluggable id factories. The default uses `crypto.randomUUID`
  (falling back to a counter); tests inject a deterministic factory so geometry
  and ids are reproducible.

## 4. Tooling decisions

- **Vite + React 18** for a fast dev loop and minimal runtime.
- **TypeScript `bundler` moduleResolution** with `noEmit` in referenced projects,
  using `tsc -b` for project references (fast incremental type-checks).
- **Vitest + jsdom** for tests. Domain/parser/layout tests avoid the browser; UI
  tests use Testing Library and cover workflows, not implementation details.
- **ESLint 8** (classic `.eslintrc.cjs`) with `@typescript-eslint` and Prettier
  via `eslint-config-prettier`. Lint is intentionally conservative to stay green.
- **Prettier** enforces formatting; `format:check` is part of CI hygiene.

## 5. Persistence plan (future phases)

A `WorkspaceRepository` interface sits above two implementations:

```
                 WorkspaceRepository
                        ▲
             ┌──────────┴──────────┐
   IndexedDB Repository      FileSystem Repository (File System Access API)
```

The domain never imports either. A project import/export format (human-readable
JSON, see Phase 4/5) provides fallback for browsers without the File System
Access API.

## 6. Phases

See [README.md](./README.md#development-phases) for the milestone list. Each
milestone ends with a checkpoint commit after `npm test`, `npm run build`, and
`npm run lint` are green.

## 7. Architectural decision records (ADRs)

| #       | Date       | Decision                                                                 | Consequence                                                                                                                                         |
| ------- | ---------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 | 2026-09-19 | Own the sequence-diagram domain in-process (no Mermaid/external engine). | More early work, but the DSL, layout, and renderer can evolve independently of third-party releases.                                                |
| ADR-002 | 2026-09-19 | Use SVG as the primary renderer.                                         | Text accessibility, scalable exports, direct DOM inspection, and element-level hit testing. Canvas may be added later for very large diagrams only. |
| ADR-003 | 2026-09-19 | `Result`-based error handling in the language layer.                     | No exceptions for expected failures; editor stays usable on malformed input.                                                                        |
