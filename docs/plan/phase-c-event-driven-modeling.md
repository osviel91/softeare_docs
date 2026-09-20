# Phase C — Event-Driven Architecture Modeling

The mission's Phase B prepared the ground: a project index, symbols, references,
diagnostics, outline, completion, quick open, stable ids and an export pipeline.
Phase C uses that foundation for its stated purpose — documenting an
**event-driven architecture** — without redesigning the parser or rendering
pipeline it already had.

## Work breakdown (C1–C6)

### C1 — Event-flow AST, lexer, parser, validator, tests

`*.eventseq` is a second documentation language with its own model, not a set of
styled sequence messages:

- `src/domain/eventflow/ast.ts` — `event` (with an open `key: value` metadata
  block), `broker`, `topic` / `queue` / `stream`, `producer` / `consumer` /
  `service`, and the edges `EventPublication { producer, event, channel }` and
  `EventSubscription { consumer, event, channel }`.
- `src/language/eventflow/lexer.ts` and `parser.ts` — both the subject-first
  (`OrderService publishes OrderCreated to orders`) and verb-first spellings
  parse to the same node.
- Diagnostics: unknown service/event/channel/broker, duplicate declarations,
  unclosed metadata, an event with no producer, an event nothing consumes, a
  channel nothing uses, a service that does nothing.
- `src/domain/eventflow/node-lookup.ts` — the AST → id lookup in both
  directions, on the shared `<kind>@<line>:<column>` vocabulary.
- Tests: `tests/language/eventflow/parser.test.ts` (31).

### C2 — Layout engine and SVG renderer

- `src/layout/eventflow-layout.ts` — one row per event: producer, channel chip,
  event, then one box per consumer, so fan-out is boxes rather than a count.
  Causal chains come from a stable topological sort over `consumes → publishes`
  edges; a cycle is reported and its rows tagged rather than reordered.
- `src/renderer/svg/eventflow-svg-renderer.ts` — deterministic SVG with
  `data-node-id` on every addressable element, so source↔diagram selection works
  in both languages.
- Tests: `tests/layout/eventflow-layout.test.ts` (25),
  `tests/renderer/eventflow-svg-renderer.test.ts` (25),
  `tests/features/preview/eventflow-to-svg.test.ts` (12).

### C3 — Index integration

An event flow contributes to the same `ProjectIndex` as any other resource:

- `src/domain/project/resource-analysis.ts` — events, services, channels and
  brokers become `ProjectSymbol`s; the flow contributes an `EventFlowDescriptor`
  with event/producer/consumer/channel counts; language diagnostics are mapped to
  `ProjectDiagnostic`.
- `src/domain/project/project-index.ts` — the new symbol kinds
  (`event`, `channel`, `broker`, and the resource kind `event-flow`) and the
  `eventflow://` reference scheme.
- References between resources keep resolving through the two-tier scheme
  (`resource://`, `diagram://`, `eventflow://`, `doc://` first, then path/name).
- **Follow-up fix:** an event flow's own resource symbol used to be given the
  kind `event`, which conflated a _file_ with a declared event. It now has the
  distinct kind `event-flow`, so Quick Open lists the flow once under
  "Event flows" and event completion can never offer a flow's title as an event
  name (`isResourceSymbolKind` centralises the rule).
- Tests: `tests/domain/project/project-index.test.ts`,
  `tests/domain/project/completion.test.ts`.

### C4 — Resource type, storage, tabs, editor, explorer, commands

- `src/domain/workspace/event-flow.ts` — the `.eventseq` extension, default name
  and collision strategy, mirroring `diagram.ts` and `note.ts`.
- `src/domain/workspace/resource-id.ts` — `resourceTypeOfName` is the single
  place the extension decides the resource type.
- Storage reuses the diagram store; there is no new repository kind and no schema
  migration (`.md` is a document, `.eventseq` an event flow, anything else a
  sequence diagram).
- The same tab strip (with a `⇄` glyph), editor, viewport and export dialog
  (SVG/PNG/PDF) serve event flows.
- Commands: `New Event Flow` creates and opens a `.eventseq` document; explorer
  and workspace factories treat it as a first-class file.
- Tests: `tests/app.eventflow.test.tsx`, `tests/features/explorer/Explorer.test.tsx`,
  `tests/features/tabs/`.

### C5 — Outline and validation surfacing

- `src/domain/outline/outline.ts` — `eventFlowOutline` builds a
  declaration-and-flow tree (events, services, channels, brokers, then the flow
  of publications and subscriptions); clicking a row navigates to the source.
- The Problems panel reads the same project diagnostics, so `Event X has no
producer`, `Unknown service "Ghost"` and their siblings are clickable and
  navigate to the offending line. No validation logic lives in React.
- Tests: `tests/domain/outline/outline.test.ts`,
  `tests/features/outline/OutlinePanel.test.tsx`,
  `tests/features/problems/ProblemsPanel.test.tsx`,
  `tests/app.eventflow.test.tsx`.

### C6 — Documentation, verification, checkpoint

- `README.md` and `ARCHITECTURE.md` updated, with ADR-027 (own language and AST),
  ADR-028 (extension decides the resource type) and ADR-029 (one row per event,
  stable topological order).
- These plans recorded under `docs/plan/`.
- Checkpoint commit `99362e6`; the symbol-kind follow-up is committed separately.

## Verification

| Gate                   | Result                                              |
| ---------------------- | --------------------------------------------------- |
| `npm test`             | 77 files, 1205 tests passed (before follow-up)      |
| `npm run typecheck`    | clean                                               |
| `npm run lint`         | clean                                               |
| `npm run format:check` | clean                                               |
| `npm run build`        | clean (128 modules)                                 |
| `npm run test:e2e`     | 85 checks against the production bundle in Chromium |

## Known limitations

- **Find-references for an event flow's symbols returns declarations only.**
  Event-flow publications and subscriptions are not recorded as
  `ProjectSymbolUsage`s (the usage contexts are sequence-only today), so a
  cross-flow reference list is not yet built.
- **Hover for event flows is minimal** — kind and declaration line — rather than
  the service/event card the sequence language gets.
- **Completion offers declared names, not channel semantics**: it does not yet
  filter a channel by kind (topic vs queue) or suggest an event's known payload
  metadata keys.
- **No consumer-group or schema concept yet.** The `SymbolKind` union and the
  parser's open metadata block leave room for both without a redesign.

## Recommended next phase

**Phase D — Event-flow intelligence**: index publications and subscriptions as
usages (find-references across flows), rich hover for services/events/channels,
consumer groups and schema references, and an architecture view that unifies
sequence diagrams and event flows.

Do not begin it automatically; this phase stops at the checkpoint.
