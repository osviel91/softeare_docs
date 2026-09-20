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

Notes take a deliberately separate, much shorter path:

```
Markdown source → markdown renderer → escaped HTML (+ data-diagram-link)
```

The renderer is pure and framework-free (see ADR-010). Resolving a
`[[Diagram]]` link happens in the UI, which is the only layer that knows the
workspace.

The project-intelligence layers sit **beside** that pipeline, never inside it:

```
project resources ─► tab strip (one open-document set) ─► editor + preview
        │
        ├─► search documents ─► project search (pure scan) ─► results + reveal
        └─► archive manifest ─► deterministic ZIP ─────────► export / import
```

A _resource_ is a diagram or a markdown document; `src/domain/workspace/resource.ts`
is a thin view over the two stores rather than a second model (ADR-015). The
searchable document set and the archive are both **derived on demand** — there is
no index to keep in sync (ADR-017, ADR-018) — which is what keeps the workspace
local-first and Git-friendly.

## 2. Hard boundaries (invariant rules)

These are non-negotiable and enforced by design, not by lint:

1. **The renderer never parses text.** It only consumes the layout/render model.
2. **The editor never computes diagram geometry.** It delegates to the layout engine.
3. **The parser does not know React exists.** The language layer has zero UI imports.
4. **Persistence does not depend on UI components.** Repositories are plain TS.
5. **The domain AST does not depend on CodeMirror.** Editor state is mapped into the AST.
6. **File APIs live behind a repository/adapter.** React never touches `window.showDirectoryPicker` directly.
7. **Every DSL feature flows through Grammar → AST → Validation → Layout → Renderer.**
8. **The markdown renderer emits escaped HTML and nothing else.** It never resolves a diagram link itself; the UI resolves `data-diagram-link` targets (and `data-resource-link` project links) against the workspace.
9. **Derived state is derived.** The searchable document set and the project archive are computed from the repositories when asked; nothing caches them across a change to the workspace.
10. **The index is the only source of project facts.** Panels, completion, hover, find-references and the overview read the `ProjectIndex`; none of them re-parses or re-counts anything.
11. **Node identity is computed, not stored.** AST nodes carry source ranges; a node's id is a pure function of its kind and range, so the parser stays untouched and the AST↔layout↔SVG chain agrees by construction (ADR-021).

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

Two smaller adapters sit beside the workspace repository because their lifetimes
differ from it:

- **`HiddenPathStore`** (`src/workspace/hidden-paths.ts`) remembers paths the user
  removed from the app. It is keyed per opened folder and defaults to in-memory
  when Web Storage is unavailable, which keeps "remove from app" reversible
  without teaching the cacheless filesystem repository to hide anything.
- **`VersionHistoryStore`** (`src/workspace/version-history.ts`, plus an
  IndexedDB implementation) holds each diagram's source timeline. It is
  deliberately separate so history survives closing one folder and opening
  another, and so a disk delete can clear it explicitly.

Both are constructed through small factories that check for IndexedDB up front
and fall back to memory, mirroring `createDefaultRepository`.

## 6. Phases

See [README.md](./README.md#development-phases) for the milestone list. Each
milestone ends with a checkpoint commit after `npm test`, `npm run build`, and
`npm run lint` are green.

## 7. Architectural decision records (ADRs)

| #       | Date       | Decision                                                                                                                                                                                                                                                                                                                                                    | Consequence                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 | 2026-09-19 | Own the sequence-diagram domain in-process (no Mermaid/external engine).                                                                                                                                                                                                                                                                                    | More early work, but the DSL, layout, and renderer can evolve independently of third-party releases.                                                                                                                                                                                                                                                                                                           |
| ADR-002 | 2026-09-19 | Use SVG as the primary renderer.                                                                                                                                                                                                                                                                                                                            | Text accessibility, scalable exports, direct DOM inspection, and element-level hit testing. Canvas may be added later for very large diagrams only.                                                                                                                                                                                                                                                            |
| ADR-003 | 2026-09-19 | `Result`-based error handling in the language layer.                                                                                                                                                                                                                                                                                                        | No exceptions for expected failures; editor stays usable on malformed input.                                                                                                                                                                                                                                                                                                                                   |
| ADR-004 | 2026-09-19 | A single preview pipeline (`src/features/preview/diagram-to-svg.ts`) is the only place UI crosses language → layout → renderer.                                                                                                                                                                                                                             | The editor never computes geometry and the renderer never parses text; all three layers stay independently testable. Invalid diagrams render an empty canvas rather than throwing.                                                                                                                                                                                                                             |
| ADR-005 | 2026-09-19 | Local folder projects model an opened folder as the workspace: subdirectories are projects and files are diagrams, with filesystem paths as stable entity ids.                                                                                                                                                                                              | Opening the same folder twice yields identical ids, so selection and exported snapshots stay stable; the repository is cacheless (it reads the live tree), so edits made elsewhere surface immediately. Browser file APIs stay behind a repository/adapter, keeping the layer testable in isolation and React away from `window.showDirectoryPicker`.                                                          |
| ADR-006 | 2026-09-20 | Destructive actions are confirmed in a dialog that can offer two scopes: delete from the backing store, or hide in the app while keeping the file on disk. Hidden paths live in a small `HiddenPathStore` outside the repository (localStorage per folder, in-memory fallback).                                                                             | A cacheless filesystem repository cannot remember "removed from the app" on its own, so the set belongs to a separate adapter the explorer filters against. Hiding is reversible and never destroys work, while a disk delete stays explicit. In-browser projects have no second copy, so they offer only the permanent scope.                                                                                 |
| ADR-007 | 2026-09-20 | Version history ("Trajectory") is a separate store (`VersionHistoryStore`) rather than part of `WorkspaceRepository`. Each version holds a complete source snapshot; checkpoints are content-aware, debounced, and capped.                                                                                                                                  | A timeline is app-local metadata that must survive independently of whichever repository is active (in-browser or folder) and must be cleared explicitly when a file is deleted from disk. Whole-source snapshots make restore a pure assignment — no diffs to replay — at the cost of storage bounded by the per-diagram cap.                                                                                 |
| ADR-008 | 2026-09-20 | A note renders as a bullet attached to its element and expands into its callout on demand; the expanded set is a render-time option passed to the renderer, not part of the layout.                                                                                                                                                                         | Toggling a note never changes the canvas size, so the viewport's pan/zoom is untouched; the layout engine stays free of interaction state and the rendered SVG remains a pure function of the AST plus the expanded set. Bullets carry `data-note-index`, so activation is delegated at the viewport rather than by React children inside injected markup.                                                     |
| ADR-009 | 2026-09-20 | Markdown notes are first-class project files (`NoteFile`), living beside diagrams in every repository; in a local folder the `.md` extension is what distinguishes a note from a diagram.                                                                                                                                                                   | A project documents a system rather than only drawing it, and the folder stays a readable documentation tree outside the app. The IndexedDB schema gains a `notes` store (version 2, upgrading in place) and `Project.noteIds`; the file-system repository filters by extension, so existing folders keep working.                                                                                             |
| ADR-010 | 2026-09-20 | The markdown renderer is owned in-process (no Markdown dependency), escapes all user text, and emits `data-diagram-link` markers instead of resolving `[[Diagram]]` links.                                                                                                                                                                                  | The project keeps its "own the domain" and minimal-dependency stance, and a note can never inject markup. Link resolution stays in the UI, which knows the workspace; the renderer remains a pure, independently testable function.                                                                                                                                                                            |
| ADR-011 | 2026-09-20 | Rename and "change title" are separate actions: rename moves the file (the path _is_ the id in a folder, so the id changes and callers follow it), while change title rewrites the document's own title line/heading.                                                                                                                                       | The user can reorganize a folder without losing the document's identity, and can retitle without touching the file name. A folder rename migrates the version timeline to the new id; repositories refuse to overwrite an existing file, so a rename can never destroy a sibling.                                                                                                                              |
| ADR-012 | 2026-09-20 | Duplicating a file is a repository operation (`duplicateDiagramFile` / `duplicateNoteFile`) whose copy names come from one shared module (`src/domain/workspace/copy-name.ts`), and creating an empty file picks a free name (`uniqueDiagramName`, `uniqueNoteName`).                                                                                       | A folder's duplicate must find a free name on disk, so the naming policy lives below the UI, beside the existing helpers; sharing it makes an in-browser copy and a folder copy identical. Picking a free name on creation also stops a second "Untitled" diagram in one folder from overwriting the first.                                                                                                    |
| ADR-013 | 2026-09-20 | A message's visual semantics are explicit in the AST (`lineStyle` × `arrowStyle`); the parser maps every arrow spelling onto that model, and an actor is a participant flavour (`participantType`) rather than a separate entity.                                                                                                                           | The renderer never re-interprets an arrow string, so the arrow table lives in exactly one place and a new spelling is a parser-only change. Actors reuse the lifeline and message rules; only the glyph (and the band height that fits it) differs, which keeps validation and layout uniform.                                                                                                                 |
| ADR-014 | 2026-09-20 | Control-flow fragments (`loop`, `alt`/`else`, `opt`, `par`/`and`, `critical`/`option`, `break`) are nested statements that own their inner statements, not flattened messages; the layout engine computes each frame's geometry and the renderer draws the frame, tag, label and branch dividers.                                                           | The AST preserves the document's structure, so a fragment can be framed, labelled and nested without the renderer inferring boundaries from message order. Layout and the validator both walk the same statement tree recursively, so semantic checks (unknown participants, activation pairing) still see every statement in source order.                                                                    |
| ADR-015 | 2026-09-21 | One tab strip serves every document kind. A tab is a `TabDocument` (`kind` + id + project + name + buffer), and `src/domain/workspace/resource.ts` gives diagrams and notes a shared `ProjectResource` view; persistence keeps its two concrete stores.                                                                                                     | The shell gains one open-document concept instead of a diagram strip plus a separate note mode, so a diagram and a markdown document stay open together and closing the active tab can move the editor to its neighbour. Keeping the view thin avoids a speculative generic store: widening to further kinds later is a case in `resource.ts`, not a persistence migration.                                    |
| ADR-016 | 2026-09-21 | The markdown renderer gains pipe tables and images in-process, and project-relative links are emitted as `data-resource-link` markers for the UI to resolve (`src/domain/workspace/project-link.ts`), exactly as `[[wiki-links]]` already were.                                                                                                             | Documentation can point at diagrams and sibling documents with ordinary markdown, while the renderer stays pure, escaped, and unaware of the workspace. Two-tier resolution (by path, then by file name) lets one rule serve both folder projects, whose ids are paths, and in-browser projects, which are flat.                                                                                               |
| ADR-017 | 2026-09-21 | Project search is a pure scan of documents derived on demand (`src/domain/search/project-search.ts`), not a maintained index; the document set is built only while the search overlay is open.                                                                                                                                                              | There is no index to invalidate, persist, or migrate, and editing never pays for indexing. The cost is re-scanning on each query, which is linear in project size and irrelevant at documentation scale; a persistent index stays possible behind the same function if a project ever outgrows it.                                                                                                             |
| ADR-018 | 2026-09-21 | A portable project archive is a deterministic ZIP written and read by an owned, STORE-only codec (`src/workspace/transfer/`), laid out as `project.json` plus `diagrams/` and `docs/`; the manifest records each resource's id, original name, and project-relative path.                                                                                   | The archive is a readable, diffable documentation tree that needs no dependency, matches the project's "own the domain" stance, and round-trips names exactly — including an in-browser diagram whose name has no extension. Storing paths relative to the project directory keeps an archive valid when that directory is renamed. Import writes fresh ids, so an archive can never overwrite anything local. |
| ADR-019 | 2026-09-21 | "Reveal this source range" is a value the shell passes into an editor (`src/features/editor/reveal.ts`), carrying the expected text and a token, not an imperative handle the editor exposes.                                                                                                                                                               | Both editors share one textarea reveal hook, the shell stays the single owner of what is being revealed, and repeating a request works because the token changes. Checking that the buffer actually holds the requested text before moving the caret stops a reveal from landing against the previous document while the new one is still loading.                                                             |
| ADR-020 | 2026-09-21 | A resource's stable identity lives in a project metadata document (`project.json` in the project directory, a field on the project record in IndexedDB) that maps id → path → type; files remain the source of truth for content. Reconciliation against the files that exist is the migration path, and a rename moves the record without changing the id. | Documentation links (`resource://diagram-checkout`) survive renaming and moving a file, and an agent can read the identity of a project without running the app. A project created before ids existed gains them deterministically on first open rather than breaking; the cost is one small sidecar per project, which a folder repository must exclude from its resource listing.                            |
| ADR-021 | 2026-09-21 | Addressable AST nodes are identified by `nodeIdOf(kind, range)` — `${kind}@${line}:${column}` — computed on demand, never stored on the node. The layout carries the id and the renderer emits it as `data-node-id`.                                                                                                                                        | The parser and the AST stay unchanged, and the AST→layout→SVG chain cannot drift because one pure function defines the mapping. Source and diagram selection become an id lookup in both directions, so no feature has to match text. Ids shift when text above them is edited, which is correct: they identify a node in _this_ parse, and nothing persists them.                                             |
| ADR-022 | 2026-09-21 | The project index is incremental: `analyzeResource` computes one file's symbols, usages, references and local diagnostics, and the indexer caches that by a content fingerprint; the project-level view is then assembled from cached analyses without parsing.                                                                                             | Editing one diagram in a hundred-diagram project re-parses one diagram, which is the boundary the mission's performance section asks for. Assembly stays cheap because it touches no text, and the same `analyzeResource` is the natural seam for an agent-facing API. The cache is memory-only, so a reload costs one full analysis pass.                                                                     |
| ADR-023 | 2026-09-21 | Project validation is a pure function of the index (`validateProject(core, perResource, metadata)`), with no React and no storage access; the index attaches its result as `diagnostics`.                                                                                                                                                                   | The Problems panel, an export job and the future MCP server all get the same verdict from the same code, and severity is decided in one place. Nothing re-reads a file to validate, so validation is as cheap as the index it reads.                                                                                                                                                                           |
| ADR-024 | 2026-09-21 | Cross-resource references resolve in two tiers: a stable scheme (`resource://`, `diagram://`, `doc://`) is looked up through the identity metadata, while a bare path or `[[wiki-name]]` is matched against the current tree. An embed (`{{diagram:id}}`) tries the id tier first.                                                                          | Documents written today with relative paths keep working, while documents written with stable ids survive rename and move — so the preferred form can migrate without a flag day. Resolution reports _why_ it failed (`external`, `missing`, `wrong-kind`), which is what lets the validator treat a web link as fine and a broken stable reference as an error.                                               |
| ADR-025 | 2026-09-21 | Semantic rename rewrites only the spans the analyser identified: a participant's declaration token and every endpoint mention, located as a whole word in the part of the statement line before its `:`. Scope is one project, justified because each diagram declares its own lifelines.                                                                   | Prose that mentions the same word is never touched, and a rename cannot corrupt a document structure. The cost is that the _exact_ token span comes from re-reading the statement's line rather than from the AST, which is documented in `resource-analysis.ts`; a future parser that records endpoint spans would remove that step.                                                                          |
| ADR-026 | 2026-09-21 | Diagram export renders the canonical SVG once and derives PNG and PDF from it; theme, background, scale, padding and title are `RenderOptions`, and `theme: "light"` is byte-identical to the previous output.                                                                                                                                              | One layout pipeline, one renderer, and no second drawing path to keep in step — which is the mission's explicit instruction. Keeping light mode byte-identical means the change is provably additive, and the renderer's existing tests keep asserting the same markup.                                                                                                                                        |
