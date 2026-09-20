# Mission: Phase B — Advanced Editor & Project Intelligence

> Recorded from the mission as issued. See
> [phase-c-event-driven-modeling.md](phase-c-event-driven-modeling.md) for the
> next phase.

## Context

The documentation workspace foundation is implemented. The application supports
sequence diagrams, Markdown resources, project organization, editing,
previewing, and project import/export.

The objective of Phase B is to evolve the application into a serious engineering
documentation IDE.

Constraints:

- Do **not** start MCP yet.
- Do **not** redesign the existing parser/rendering pipeline unless required.
- Preserve all existing functionality.

## 1. Main goals

1. source ↔ visual synchronization;
2. project-wide diagnostics;
3. semantic autocomplete;
4. quick-open;
5. command palette improvements;
6. outline/navigation;
7. project indexing;
8. stable resource identifiers;
9. cross-resource references;
10. improved export.

These prepare the application for Event Driven Architecture modeling,
project-wide semantic analysis, future MCP access, and agent-assisted
documentation.

## 2. Stable resource IDs

Resources must no longer be identified exclusively by path.

```ts
interface ResourceBase {
  id: ResourceId;
  path: string;
  title?: string;
  type: ResourceType;
}
```

```json
{
  "id": "diagram-payment-processing",
  "path": "diagrams/payment-processing.seq",
  "type": "sequence-diagram"
}
```

- rename/move must preserve the id;
- ids must be unique inside a project;
- validation must detect duplicates;
- generated ids must be deterministic enough or persisted appropriately;
- existing projects must not break — migration/default generation for old
  resources is required.

## 3. Project index

A derived project index, rebuildable from project files, never the source of
truth:

```ts
interface ProjectIndex {
  resources: ResourceDescriptor[];
  diagrams: DiagramDescriptor[];
  documents: DocumentDescriptor[];
  participants: ParticipantSymbol[];
  references: ProjectReference[];
  diagnostics: ProjectDiagnostic[];
}
```

It exists for search, navigation, autocomplete, diagnostics, references and
future MCP access.

## 4. Symbol index

Extract project-level symbols — initially participants, actors, services,
queues, databases, diagrams, documents; later events, topics, consumer groups and
schemas.

```ts
interface ProjectSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  resourceId: ResourceId;
  sourceRange?: SourceRange;
}
```

## 5. Source ↔ diagram synchronization

Bidirectional selection, by AST id / source range — never text matching.

- **Source → visual:** the cursor entering `API -> DB: Find user` highlights the
  corresponding SVG message; the preview scrolls to it if required.
- **Visual → source:** clicking a participant, message, note, loop, alt branch,
  group or activation activates the source file, moves the editor cursor to the
  source range, and selects the statement.

## 6. Stable AST node IDs

Addressable AST nodes expose an id and a source range; one render cycle keeps a
deterministic AST node → layout element → SVG element relationship. SVG may
expose `data-node-id` without leaking internal parsing state.

## 7. Outline panel

A statement tree for sequence diagrams (title, participants, flow, fragments and
their branches) and a heading tree for Markdown. Clicking an entry navigates to
the DSL source / heading.

## 8. Problems panel

A project-level panel aggregating `error`, `warning` and `info`, covering
unknown participants, duplicate resource ids, broken diagram references, broken
Markdown links, missing files, duplicated titles and unused participants.
Clicking a problem navigates to it.

```ts
interface ProjectDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  resourceId: ResourceId;
  sourceRange?: SourceRange;
  code?: string;
}
```

## 9. Project validation service

A UI-independent `validateProject(project): ProjectDiagnostic[]`. The browser UI
calls this service; validation logic must not live inside React. It later becomes
directly reusable by MCP.

## 10. Semantic autocomplete

Autocomplete understands project content — participant names, resource names,
diagram references and DSL keywords — using the project index.

## 11. Context-aware DSL completion

Suggestions depend on parser context: at root `participant`, `actor`, `title`,
`group`, `autonumber`; inside `alt`, `loop`, `par`, `opt`, `critical`, `note`;
after `API ->` known participants. Not a static word list.

## 12. Hover information

Semantic hover: for a participant, its kind, declaration site and usage count;
for a message, its endpoints, operation and type.

## 13. Find references

`Find References` for participants/resources, built from the project index.

## 14. Rename resource

Rename a resource safely, updating internal references automatically, without
touching unrelated plain text.

## 15. Rename symbol

Semantic rename for participant ids where safely possible — never a blind global
replace; cross-diagram rename only when project-wide semantics are clear.

## 16. Quick open

`Cmd/Ctrl + P`, fuzzy-searchable across diagrams, Markdown docs, folders and
symbols.

## 17. Improved command palette

`Cmd/Ctrl + Shift + P`, with commands for creating/renaming/duplicating/deleting
resources, exporting, validating, formatting, toggling panels, and quick open —
registered through a central command registry rather than scattered keyboard
handlers.

## 18. Command architecture

```ts
interface AppCommand {
  id: string;
  title: string;
  shortcut?: string;
  execute(context: CommandContext): void | Promise<void>;
}
```

## 19. Cross-resource references

Stable internal links (`resource://<id>`, `diagram://<id>`, `doc://<id>`) that
survive rename/move. Path-based links remain supported for compatibility, but
stable ids are preferred internally.

## 20. Diagram references

Sequence diagrams may reference another diagram; clicking the rendered reference
opens it, and validation detects broken references.

## 21. Markdown diagram embedding

`{{diagram:<id>}}` renders the current diagram source into the Markdown preview,
respects the theme, detects missing diagrams, opens source on click, and is
included in exported documentation.

## 22. Export improvements

SVG, PNG and PDF from one canonical renderer, with theme, background, scale,
padding, include-title and transparent-background options. No second layout
engine.

## 23. Project documentation export

`Export Documentation Site` produces static files that need no server, with
navigation from project structure and embedded diagrams rendered.

## 24. Project overview

A dashboard consuming the `ProjectIndex` (counts, diagnostics, recently
modified) without recalculating data independently.

## 25. Architecture preparation for EDD

Do not implement event-driven modeling yet, but avoid designs that would make
events, producers, consumers, channels, schemas and consumer groups impossible.
Do not add placeholders throughout the codebase.

## 26. Application service layer

Separate application operations from React (`openResource`, `createResource`,
`renameResource`, `deleteResource`, `validateProject`, `searchProject`,
`findReferences`, `exportDiagram`, `exportProject`). React orchestrates; it does
not own these operations.

## 27. Tests

Strong tests for the project index (indexing, rename, duplicate ids, symbols,
references), cross references (valid, broken, moved, renamed), navigation
(AST → source range, source range → rendered node), validation (errors, warnings,
links) and export (deterministic SVG, embedded diagrams, static site).

## 28. Performance

Assume 100+ diagrams, 100+ documents and thousands of messages/events. Do not
reparse the whole project after each keystroke; prefer incremental behavior:

```text
edited resource → reparse resource → update index entries → re-run affected validations
```

Establish correct boundaries first; keep the implementation simple.

## 29. Completion criteria

Phase B is complete when source and visual elements are synchronized,
project-wide search and quick-open work, symbols are indexed, the Problems and
Outline panels work, semantic autocomplete works, stable resource ids exist,
cross-resource links survive rename/move, diagrams can be embedded in Markdown,
SVG/PNG/PDF export works, documentation-site export works, validation is a
UI-independent service, and all previous functionality remains intact.

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Fix regressions rather than suppressing them. Create a checkpoint commit.

## Delivered

Phase B is implemented; the checkpoint is commit `77e17ef` ("documentation
workspace and project intelligence"). Where each goal lives:

| Goal                          | Where                                                                   | Test                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Stable resource ids           | `src/domain/workspace/resource-id.ts`, `metadata.ts`                    | `tests/domain/workspace/metadata.test.ts`                            |
| Project index (incremental)   | `src/domain/project/indexer.ts`, `project-index.ts`                     | `tests/domain/project/project-index.test.ts`                         |
| Per-resource analysis         | `src/domain/project/resource-analysis.ts`                               | `tests/domain/project/project-index.test.ts`                         |
| UI-independent validation     | `src/domain/project/validate.ts`                                        | `tests/domain/project/project-index.test.ts`                         |
| References + semantic rename  | `src/domain/project/references.ts`                                      | `tests/domain/project/references.test.ts`                            |
| Semantic / context completion | `src/domain/project/completion.ts`                                      | `tests/domain/project/completion.test.ts`                            |
| Hover                         | `src/domain/project/hover.ts`                                           | `tests/domain/project/hover.test.ts`                                 |
| Outline                       | `src/domain/outline/outline.ts`, `src/features/outline/`                | `tests/domain/outline/outline.test.ts`                               |
| Problems panel                | `src/features/problems/`                                                | `tests/features/problems/ProblemsPanel.test.tsx`                     |
| Quick open                    | `src/features/quickopen/`                                               | `tests/features/quickopen/`                                          |
| Command registry              | `src/features/commands/`                                                | `tests/features/commands/`                                           |
| Cross-resource links + embeds | `src/domain/workspace/project-link.ts`, `language/markdown/markdown.ts` | `tests/domain/workspace/project-link.test.ts`                        |
| Export (SVG/PNG/PDF/site)     | `src/features/export/`                                                  | `tests/features/export/`                                             |
| Source ↔ diagram selection    | `src/domain/diagram/node-id.ts`, `src/App.tsx`                          | `tests/domain/diagram/node-id.test.ts`, `tests/app.phase-b.test.tsx` |

### Deviations from the plan

- **Command palette scope.** The palette offers the commands that act on the
  shell or the active document (new diagram/note/event flow, close tab, search,
  quick open, toggle outline/problems, overview, validate, find references,
  rename symbol, export diagram/site, export/import project, open/close folder).
  Per-resource actions — rename resource, duplicate, delete, change title — live
  in the explorer context menu, where the target resource is unambiguous.
- **Not implemented: `Create Folder`, `Format Diagram`, `Toggle Preview`.**
  Folders exist only in folder projects, where they are created on disk (the
  in-browser store is flat); the language layer has no formatter; and the preview
  is switched by its own control rather than a palette command.
- **Not implemented: `Group`, `autonumber`.** They are named among completion
  keywords in the mission but are not part of the sequence DSL, so they are not
  suggested.
- **Project overview shape.** It is a dashboard over the index rather than a
  separate route; every number (resources, symbols, diagnostics, recently
  modified) is read from `ProjectIndex` alone.
