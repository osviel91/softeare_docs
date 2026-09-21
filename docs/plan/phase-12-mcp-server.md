# Phase 12 — MCP Server for Coding Agents

The engine already knew how to parse, validate, index, outline, search and render
documentation without a browser (ADR-022 and ADR-023 anticipated exactly this).
Phase 12 exposes it to coding agents over the **Model Context Protocol**, so an
agent can add, update and improve an application's documentation with the same
engine the editor uses.

## Goal

An agent that speaks MCP — OpenCode, Hermes, Claude, Cursor, or anything else —
can open a documentation workspace on disk and, through tools, resources and
prompts:

- orient itself in a project before writing anything;
- author and edit sequence diagrams, event flows and markdown documents;
- validate a draft before it is written and a document after;
- render a diagram to SVG;
- search the project and find symbol references;
- audit what the documentation is still missing.

The hard requirement is that **none of this is a second implementation**. A
diagram an agent writes is one the editor opens unchanged, and a diagnostic it
sees is the one the Problems panel shows.

## Deliverables

### 12.1 — A Node filesystem repository

- `mcp/node-fs.ts` — adapts `node:fs/promises` to the framework-free
  `FsDirectoryHandle` interface the folder repository was already written
  against, so `createFileSystemWorkspaceRepository` works unchanged on the
  server. Directories are created lazily and files only when asked, matching the
  contract the in-memory test double established.
- Entry names are validated as single path segments before they reach
  `path.join`, which is the server's directory-traversal boundary; a render
  output path is additionally confined to the workspace root.

### 12.2 — The workspace service

- `mcp/workspace.ts` — `DocumentationWorkspace`, the application service the
  tools call. It owns project resolution, snapshots (through
  `loadProjectSnapshot`, so `project.json` reconciliation and stable ids come for
  free), indexing (`createProjectIndexer` + `toSourceFiles`), resource reads and
  writes, rename (which moves the identity record so links survive), validation
  (through `analyzeResource`, so it is the index's own verdict), outlines,
  search, rendering (through the preview pipeline) and a documentation audit.
- Creating a project now materialises an empty `project.json` immediately, so
  the project is self-describing before its first file exists.

### 12.3 — The protocol

- `mcp/protocol.ts` — JSON-RPC 2.0 and MCP wire types, the two protocol
  revisions, error codes, and the stdio framing helpers.
- `mcp/server.ts` — dual-era dispatch: the legacy `initialize` handshake for
  earlier clients, the stateless `2026-07-28` model (`server/discover`,
  per-request `_meta`, `resultType`, cache fields) for modern ones, and the
  stdio loop. Owned in-process rather than pulled from the SDK, following the
  ZIP codec and markdown renderer precedent (ADR-037).

### 12.4 — Tools, resources and prompts

- `mcp/tools.ts` — 17 tools with JSON Schemas, descriptions written for a model
  choosing between them, and honest `readOnlyHint`/`destructiveHint`
  annotations so an untrusted host can gate the write tools.
- `mcp/reference.ts` — the two DSL references (generated from the editor's own
  `src/language/dsl-reference.ts`), the markdown dialect, two guides, and the
  project-resource URI template.
- `mcp/prompts.ts` — four workflow prompts: document an application, improve
  existing documentation, diagram one interaction flow, model an event-driven
  architecture.

### 12.5 — Packaging and verification

- `scripts/build-mcp.mjs` bundles `mcp/` to one dependency-free ESM file with
  esbuild; `npm run mcp` builds and runs it.
- Unit suites under `mcp/__tests__/` cover framing, era negotiation, resource
  parsing, the workspace lifecycle and the dispatch surface.
- `scripts/mcp-smoke.mjs` (`npm run test:mcp`) spawns the bundled server and
  drives it over real stdio against a temporary workspace.

### 12.6 — Documentation

[README](../README.md#mcp-server-for-coding-agents) documents the build, the
workspace model, OpenCode/Hermes/generic client configuration, the tool catalog,
the resources and prompts, a worked session, and the safety boundary.

## Boundary rules the phase must not cross

1. No documentation logic in `mcp/`. Parsing, validation, indexing, layout,
   rendering and search stay in `src/`; `mcp/` adds transport, schemas,
   reference text and prompts.
2. The MCP server never writes a file the app could not have written: resources
   go through `WorkspaceRepository`, and identity through `project.json`.
3. stdout carries MCP messages only; diagnostics go to stderr.
4. Deletion requires explicit confirmation.

## Follow-up fix found by the phase

`metadataFileFor` in `src/services/project-service.ts` resolved a diagram's
recorded type from the _store_ (`resourceTypeOf`) rather than the file name, so a
`.eventseq` file was recorded — and therefore indexed — as a sequence diagram. An
agent that writes an event flow would have seen the wrong analysis. The fix keeps
each source of truth where it belongs: a **note** is a markdown document from the
store it came from (an in-browser note may not carry `.md`), while a **diagram**'s
type comes from its extension (`resourceTypeOfName`), the single rule ADR-028
names.

The first attempt derived every type from the file name. The browser smoke test
caught it — a note whose stored name has no `.md` was then recorded as a sequence
diagram, so an imported project listed two diagrams and no note — and the fix
narrowed to the diagram branch. A useful reminder that the store kind and the
extension each know something the other does not.

## Verification

- `npm test` — 1359 tests across 91 files, including the MCP suites.
- `npm run test:mcp` — the bundled server driven over stdio end to end.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`.
- A manual `printf … | node dist-mcp/server.mjs` handshake against a temporary
  workspace, as documented in the README.

`npm run test:e2e` has one failing check in this working tree — the imported
project's explorer rows — which is present with this phase's changes reverted and
belongs to the uncommitted work already in progress here, not to the MCP server.
