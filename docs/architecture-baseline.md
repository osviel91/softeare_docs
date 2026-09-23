# Current Architecture Baseline

This is the H01 snapshot of behavior that later transformation work must
preserve. It describes the implementation in the working tree, not a target
architecture.

## Shape

- The browser entry is `src/main.tsx` -> `src/App.tsx`.
- Shared diagram behavior flows through `src/language` -> `src/domain` ->
  `src/layout` -> `src/renderer`; React features consume those results.
- `src/domain` contains framework-free sequence, event-flow, project, search,
  and workspace models. `src/application` contains shared server use cases.
- Local workspace repositories live under `src/workspace` and support in-memory,
  IndexedDB, and File System Access storage. Server repositories and project
  storage live under `src/persistence`.
- `mcp/` is the stdio host over `DocumentationWorkspace`. `apps/api/` is the
  HTTP host. `apps/mcp/` is the remote MCP host. They consume shared application
  or workspace services and do not call one another.
- The project index is the source for resource facts, diagnostics, symbols,
  references, and search. Editors, panels, and MCP features do not independently
  parse project resources to rebuild those facts.

## Compatibility Contracts

### Persisted local projects

- Workspace snapshots remain JSON with `projects`, `diagrams`, and optional
  `notes` arrays. Projects use `datasetIds` and optional `noteIds` ordering.
- Missing legacy `notes` and `noteIds` are read as empty collections. Invalid
  top-level shapes and resource records are rejected.
- Diagram and note records retain their existing `id`, name, content, and
  `projectId` fields; optional resource metadata is normalized when loaded and
  omitted for legacy records. Event flows are diagram records identified by the
  `.eventseq` name suffix; they are not a separate persisted collection.

### Identity, names, and scope

- A project owns each resource. Local generated IDs are stable across ordinary
  edits and renames; File System Access IDs are paths. Server resource records
  have database IDs and project IDs.
- Sequence diagrams use `.seq`, event flows use `.eventseq`, and Markdown uses
  `.md`. Resource names are resolved by path, ID, name, or title where the host
  supports those references.
- Server project access is authorized by the application catalog before storage
  is opened. Resource mutations use revisions and reject stale expectations.

### HTTP API

- Project resources are exposed at `/api/projects/:projectId/resources`.
- Resource representations contain `id`, `projectId`, `path`, `type`, and
  `revision`, plus optional normalized `metadata` containing `description` and
  `tags`; reads additionally return content.
- Resource create and update accept metadata. Omitting it preserves existing
  metadata; sending an empty object clears it. Updates still require the expected
  revision and use the shared journaled mutation path.
- The supported resource types are `sequence-diagram`, `event-flow`, and
  `markdown-document`. Create, update, move, and delete preserve project
  scoping, path validation, authorization, and expected-revision behavior.

### MCP

- Remote MCP exposes project/resource discovery and read/write operations plus
  semantic diagram, event-flow, and documentation tools. Its resource reads and
  writes use the same project authorization and revision rules as the API.
  `get_resource_metadata` reads the semantic fields and
  `update_resource_metadata` changes them without replacing content.
- Stdio MCP exposes the local workspace operations, static reference resources,
  validation, search, and SVG rendering. Existing tool names and reference URIs
  are compatibility surface.

### Rendering and indexing

- Sequence and event-flow source is parsed, validated, laid out, and rendered
  to deterministic SVG by shared non-React code. Markdown is indexed but not
  sent through a diagram renderer.
- Search, symbols, references, diagnostics, and project summaries are derived
  from the project index. Rendering reads the resource through the workspace
  service before selecting the language-specific renderer.

### Event Flow Views

- The Event Flow pipeline is `source → parser/analyzer → EventFlow semantic
model`, followed by independent Flow, Catalog, or Topology projections. Flow
  continues through `FlowViewModel → Flow layout → Flow renderer → SVG`; Catalog
  is a source-ordered document projection rendered by the browser UI; Topology
  continues through `TopologyViewModel → Topology layout → Topology renderer →
SVG`.
- The semantic model contains documented-system facts such as events, services,
  channels, brokers, publications, subscriptions, and event metadata. The
  `FlowViewModel` contains the row view's presentation decisions, but no pixel
  coordinates; layout owns geometry and the renderer owns SVG. The Catalog view
  consumes the same model without persisted view state or a second resource.
- One Event Flow resource stores one semantic model/source. Views are pure
  projections and are not separately persisted resources. Topology edges
  represent mediated publication/subscription relationships; channels and
  brokers remain context rather than graph nodes.

### Resource Dimensions

- `ResourceKind` is the broad stored-resource class: `diagram` or `note`.
- `ResourceRepresentation` is the language used to interpret content: `sequence`,
  `event-flow`, or `markdown`. Sequence diagrams and Event Flows are both
  diagrams; Markdown is a note. Existing persisted/API `type` values remain
  compatible spellings of these representations.
- A representation is not a visualization. An Event Flow has representation
  `event-flow` and can later support multiple views of the same semantic model,
  such as flow, catalogue, topology, or matrix views. Those views do not create
  new resource kinds or representations.

## Known Debt, Not H01 Work

- `ARCHITECTURE.md` contains historical phase and ADR wording that does not
  always read as a current-state document.
- Workspace membership and project membership are both present; project
  authorization remains the effective server boundary, and invitation delivery
  is not complete.
- The local domain types still call the diagram collection `diagrams` even
  though it also stores event flows by filename. This is an existing persisted
  contract, not a reason to rename or generalize it in H01.

## Verification

- Fast repository gate: `npm run verify` (`lint`, `typecheck`, all Vitest tests,
  and MCP build/smoke/tests).
- Production bundle gate: `npm run build`.
- Broader deployment checks remain `npm run test:e2e` and
  `npm run test:containers`; they require their documented external setup.

H01 adds no public API, MCP, persistence, or domain-model redesign. It adds
only characterization of the server event-flow path and this baseline record.
