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
the preview live, a note bullet expands its callout on click without resizing the
canvas, a self-message paints a loop with an arrowhead, a markdown note renders and
its `[[Diagram]]` link resolves through the context menu, and invalid DSL surfaces
diagnostics instead of crashing.

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

- **Editor views.** A `Code` / `Docs` / `History` segmented control switches the
  middle pane between the DSL source, a reference for every construct both
  documentation languages support (`src/features/docs`), and the open diagram's
  version timeline (`src/features/history`). The reference is split into a
  sequence-diagram section and an event-flow section, and tests assert each
  documented keyword really lexes as a keyword — or, for an event flow, is
  accepted by its parser — so it cannot drift behind the grammar.
- **Editing.** The editor has a line-number gutter synced to the textarea's scroll
  position, and a **Snippets** menu (`src/features/editor/snippets.ts`) that
  inserts a construct at the caret, starting it on its own line unless it is
  already at one. The menu follows the open document's language, so an event flow
  offers `event`, `broker` and `publish … to …` rather than `participant` and
  sequence arrows, which would be syntax errors there. The gutter also prints the
  diagram's circled step number beside each message line, so a number on the
  canvas — the one `note on 3` refers to — can be located in the source at a
  glance (`src/domain/diagram/step-numbers.ts`).
- **Name highlighting and live rename.** Every name is drawn bold and in the
  accent colour wherever it is written — a participant or actor at its declaration
  and at every message, activation, note and alias that names it, and an event,
  broker, channel or service at its declaration and in every edge that carries it.
  A `<textarea>` cannot style part of its own text, so a highlight layer sits
  behind a transparent textarea and both share one box, font and line grid
  (`src/features/editor/highlight.ts`). Because the editor knows each mention's
  exact span, retyping a declaration's name rewrites its usages as you type
  (`src/features/editor/live-rename.ts`) — a rename never collapses the diagram
  into "unknown participant" or the flow into "unknown event", never touches prose
  in a label or metadata value, and is refused when the new name is already
  another declaration's. The spans come from `participant-mentions.ts`
  (sequence) and `eventflow/mentions.ts`; the project index shares the former, so
  find-references, semantic rename and the live rename cannot disagree.
- **Auto-update.** With the switch on, the canvas re-renders as you type. Switched
  off, the canvas keeps the last rendered diagram and a **Render** button appears,
  so a large diagram does not re-lay out on every keystroke.
- **Canvas navigation.** The preview is a pan/zoom viewport
  (`src/features/preview/DiagramViewport.tsx`): drag to pan, scroll to zoom
  (anchored on the cursor), arrow keys to pan, and a rail with zoom in/out, fit,
  and reset-to-100%. A minimap in the corner shows the whole diagram with the
  visible region outlined, and clicking or dragging it recenters the view.
- **Diagram naming.** A diagram is named by the `title` line in its own source:
  the explorer row and tab label show that title, falling back to the file name
  when the source declares none. Renaming the title renames the diagram
  everywhere as you type, so there is no separate rename step — and the file on
  disk (and its id) is untouched, so a title is free to differ from the file name.
  `title` may appear on any line; the first one wins and a duplicate is reported.
- **Message arrows.** A message's visual semantics are explicit in the AST
  (`lineStyle` × `arrowStyle`), not encoded in an arrow string: the parser maps
  every spelling — `->`, `-->`, `->>`, `-->>`, `-x`, `--x`, `-)`, `--)`,
  `<<->>`, `<<-->>` — onto a solid or dashed line with a filled arrowhead
  (`->` and `-->`, and their double-chevron synonyms `->>` / `-->>`), an open
  async chevron (`-)`, `--)`), a cross for a failed delivery (`-x`, `--x`), or
  heads at both ends (`<<->>`, `<<-->>`). Every message line points somewhere,
  so a call never reads as a bare rule (`src/domain/diagram/ast.ts`). The arrow
  lookup table lives in one place in the parser, so the renderer never re-reads
  source text.
- **Actors and labelled lifelines.** `actor User` draws a human figure instead
  of a name box; `participant auth as "Authentication Service"` gives a lifeline
  a readable label while messages keep using the stable `auth` id. Declaration
  order still controls left-to-right placement, and actor and participant glyphs
  share one top band so the diagram stays aligned.
- **Control-flow fragments.** `loop`, `alt`/`else`, `opt`, `par`/`and`,
  `critical`/`option`, and `break` are first-class nested statements
  (`src/domain/diagram/ast.ts`), not flattened into messages. The layout engine
  frames the rows each one owns, sizes the frame to the participants it mentions,
  insets nested frames, and draws a labelled divider per extra branch
  (`src/layout/sequence-layout.ts`).
- **Sequence numbers.** Every call and every response is numbered in source
  order, drawn as a small circle on the arrow just inside its tail (on a
  self-message, on the loop's top segment), so the order of the steps is legible
  at a glance. Numbering is a render-time annotation over the ordered message
  list (`src/renderer/svg/sequence-svg-renderer.ts`), so it never changes the
  layout or the canvas size.
- **Notes as bullets.** A `note` is attached to the element it annotates as a
  small bullet (`src/features/preview`). Clicking the bullet (or pressing
  Enter/Space on it) expands the folded callout box; clicking again collapses it.
  A note may attach to a lifeline (`note right of API`), span several
  (`note over API,DB : …`), target the whole diagram (`note over : …`), or attach
  to a single **message by its step number** (`note on 3 : …` — the number the
  diagram prints in its circle, counting calls and responses in source order). It
  may also be multiline (a body running to `end note`), which grows the box one
  line at a time. When several notes share an anchor their bullets stack, and a
  `Notes (n)` control offers **Expand all** / **Collapse all**. Expansion is a
  render-time option, so toggling a bullet never changes the canvas size and the
  current pan/zoom is preserved.
- **Safe delete.** Deleting a project or diagram always asks first
  (`src/features/ui/ConfirmDialog.tsx`). When a local folder is open the dialog
  offers both scopes: **Remove from app** hides the entry in the explorer but
  leaves the file on disk, while **Delete from disk** removes it for good. Hidden
  paths are remembered per folder and the explorer offers to restore them, so a
  mistaken delete is recoverable; in-browser projects (which have no disk copy)
  offer the single permanent delete.
- **Trajectory history.** Every diagram keeps a timeline of the sources it has
  been through (`src/domain/workspace/version.ts`,
  `src/workspace/version-history.ts`). The first version is captured when a
  diagram is opened, further versions are checkpointed automatically once edits
  settle, and **Save version** captures one on demand. Each entry shows when it
  was taken, why, and a one-line summary, and can be restored into the editor or
  forgotten. Restoring records the restored content as a new checkpoint, so the
  timeline is append-only.
- **Projects as documentation.** A project holds diagrams _and_ markdown
  documents, so it can document a system rather than only draw it. A project's
  `＋` button opens a menu to add either kind — **New diagram** or **New note** —
  so the choice is explicit. Both kinds open into **one tab strip** (see
  _Documentation workspace_ below), and selecting a markdown document shows the
  markdown editor (`src/features/notes`) beside its rendered output, with
  headings, lists, tables, images, code, emphasis, and links. A document links to
  a diagram with `[[Diagram Name]]` — or with an ordinary relative link such as
  `[Payment flow](../diagrams/payment.seq)`, which resolves against the project's
  file names. Either way a resolved link is clickable and opens that document's
  tab, while an unresolved wiki-link is shown as broken. The markdown renderer
  (`src/language/markdown/markdown.ts`) is owned by the project like the DSL is —
  no Markdown dependency — and escapes every piece of user text before emitting
  tags.
- **Documentation workspace.** The app is a workspace, not only a diagram editor:
  - **Mixed tabs.** A diagram and a markdown document stay open side by side in
    one strip (`src/features/tabs`). A tab shows its document kind, its title, a
    modified indicator while its buffer has unsaved changes, and a close button.
    Activating a tab loads that document, and closing the active tab moves the
    editor to whichever tab replaces it.
  - **Project-wide search.** `Ctrl/Cmd+Shift+F` (or **Search Project…** in the
    palette) scans every diagram's source and every document's markdown at once
    (`src/domain/search/project-search.ts`) and shows each hit with its project,
    file, line, and matching text. Opening a result loads that document and puts
    the caret on the hit. The query understands scopes — `kind:diagram`,
    `kind:note`, `project:name`, and `participant:Name` — so
    `participant:PaymentService` lists the diagrams declaring that participant.
  - **Portable project archives.** **Export Project** writes the selected project
    to a `.zip` (`src/workspace/transfer/`) laid out as a readable documentation
    tree — a `project.json` manifest plus `diagrams/` and `docs/` — and **Import
    Project…** recreates a project from one. The archive is a plain ZIP of UTF-8
    text files, so it is diffable, Git-friendly, and portable; the ZIP codec is
    owned in-process (`src/workspace/transfer/zip.ts`) rather than pulled in as a
    dependency, and `createZip` is deterministic.
- **File actions.** Right-clicking a diagram or note row (or using its `⋯`
  button) opens a context menu with **Rename…**, **Change title…**,
  **Duplicate**, and **Delete**. Rename changes the backing file name
  (`architecture.md`), while change title edits the document's own title — the
  `title` line for a diagram, the first heading for a note. Duplicate copies the
  document's content into a new file beside it, named `<name> copy` (then
  `<name> copy 2`, …) so an existing file is never overwritten. Rename and title
  both go through a small prompt dialog, and delete still goes through the
  confirmation dialog above. With a local folder open, rename moves the file on
  disk and the version timeline follows the file to its new id.
- **Participant drag-and-drop.** Participant name boxes in the preview are
  draggable: drop one into the DSL editor to insert that participant name at the
  caret, instead of retyping it. The drop target highlights while a drag is over
  it, and the **Title** snippet (`title My Diagram`) covers the other thing every
  diagram needs up front.

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

### Publishing an image

[`.github/workflows/publish-image.yml`](./.github/workflows/publish-image.yml)
builds the image on every push to `master` and publishes it to the GitHub
Container Registry as `ghcr.io/osviel91/softeare_docs`:

| Ref      | Tags                                    |
| -------- | --------------------------------------- |
| `master` | `latest`, `master`, `sha-<short>`       |
| `v1.2.3` | `1.2.3`, `1.2`, `v1.2.3`, `sha-<short>` |

A push builds `linux/amd64` and `linux/arm64` as one manifest, so a single tag
works on an x86 server and on an ARM NAS alike. A pull request only builds the
image to prove it still builds; nothing is published for it.

Three gates stand between a commit and a tag. `lint`, `typecheck` and the unit
suite must pass, the Chromium smoke test must drive the built bundle, and — once
the image is pushed — the workflow serves that published image and checks the
app, its SPA fallback and a hashed bundle asset. The last gate is what makes the
tag safe to deploy: it exercises the artefact Portainer will pull rather than
the source tree.

### Deploying with Portainer

[`deploy/portainer-stack.yml`](./deploy/portainer-stack.yml) is a ready-made
stack: in Portainer open **Stacks → Add stack → Web editor**, paste it, and
deploy. Two variables are read when the stack is deployed:

| Variable    | Default  | Purpose                                                        |
| ----------- | -------- | -------------------------------------------------------------- |
| `WEB_PORT`  | `8080`   | host port to publish the app on                                |
| `IMAGE_TAG` | `latest` | tag to run; pin `sha-<short>` when a deploy must be repeatable |

The stack pulls on every deploy (`pull_policy: always`), so the flow for a
change is: merge to `master`, let the workflow finish, then **Update the stack**
in Portainer. There is no backend, database, or volume to migrate — the app is a
static bundle and all state lives in the browser.

A package published to GHCR is private by default, so the first pull needs
either the package made public (GitHub → the package → _Package settings_ →
_Change visibility_) or a Portainer registry entry (**Registries → Add registry
→ Custom**: `ghcr.io`, your GitHub username, and a PAT carrying
`read:packages`).

To try a change before pushing it, `docker-compose.yml` builds the same image
from the working tree: `docker compose up --build -d`, then
<http://localhost:8080/>.

## Repository layout

```
src/
  app/            React application shell and (later) routing & commands
  shared/         Framework-agnostic helpers: Result, id factories
  domain/         Domain model: diagram, note, eventflow, project, resource,
                  links; project-wide search (search/); project index (project/)
  language/       Two DSLs (lexer, parser, diagnostics) — `sequence/` and
                  `eventflow/` — plus the markdown renderer
  layout/         AST -> geometry (independent of SVG)
  renderer/       SVG rendering of the layout model
  workspace/      Persistence abstraction + implementations; portable
                  project archives (transfer/)
  features/       React feature modules:
                    explorer, editor, preview (+ viewport), tabs, commands, docs,
                    notes (markdown editor/view), history (version timeline),
                    search (project find-in-files), ui (dialogs, context menu)
tests/            Browser-independent and workflow tests
docs/plan/        Mission plans: intent, deliverables, and verification
deploy/           Portainer stack for the published image
.github/          CI: the image publish workflow
```

The early structure is intentionally small; layers are added as phases demand
them while keeping the boundaries above intact.

## Development phases

Work proceeds in disciplined, commit-per-phase milestones (see
[ARCHITECTURE.md](./ARCHITECTURE.md#phases)). Each phase's mission — its goal,
deliverables and boundaries — is recorded under [`docs/plan/`](./docs/plan/).

0. Repository foundation (this phase)
1. Sequence language core (DSL, parser, diagnostics, validation)
2. Layout + SVG rendering
3. Interactive live editor
4. In-browser projects (IndexedDB)
5. Local folder projects (File System Access API)
6. Editing productivity (tabs, commands, search)
7. DSL v2 constructs (actors, labelled ids, the full arrow family, activations, notes, and control-flow fragments)
8. Export (SVG, then PNG)
9. Documentation workspace (mixed document tabs, project-wide search, portable project archives)
10. Project intelligence (stable resource ids, project index, diagnostics, outline, completion, quick open, find/references, rename)
11. Event-driven modeling (`*.eventseq`: events, producers, consumers, brokers, channels, fan-out, causal chains)

## Status

**Phases 0–11 are implemented** on this branch. `npm test` runs 1200+ tests,
`npm run test:e2e` drives 85 checks against the production bundle in Chromium,
and `npm run typecheck`, `npm run lint`, `npm run build` and
`npm run format:check` are clean.

**Phase 11 (event-driven modeling).** A project can now document an
event-driven architecture in its own language, `*.eventseq`:

```text
title Order Processing

event OrderCreated {
  version: 2
  domain: Orders
}

broker Kafka
topic orders on Kafka

producer OrderService
consumer BillingService

OrderService publishes OrderCreated to orders
BillingService consumes OrderCreated from orders
```

- **A second language, not a different arrow.** Events, producers, consumers,
  brokers and channels are first-class in the model (`src/domain/eventflow/ast.ts`)
  rather than being styled sequence messages, because the documentation is _about_
  those concepts. Publications and subscriptions are the mission's
  `EventPublication { producer, event, channel }` and
  `EventSubscription { consumer, event, channel }`.
- **Both spellings of an edge.** `OrderService publishes OrderCreated to orders`
  and `publish OrderCreated from OrderService to orders` parse to the same node,
  so a document can be written the way it reads best.
- **Extensible event metadata.** `event X { … }` holds arbitrary `key: value`
  pairs — version, domain, schema, correlation key, partition key — with no field
  hard-coded in the parser.
- **Fan-out is explicit.** The layout draws one row per event with its producer
  on the left, the channel and event in the middle, and one box per consumer on
  the right, so competing consumers are visible rather than implied by a count.
- **Causal chains.** Events are ordered by a stable topological sort over
  "a service consumes A and publishes B", so a cascade reads top to bottom; a
  cycle is reported and its rows are tagged rather than silently reordered.
- **The same project intelligence.** An event flow contributes events, services,
  channels and brokers to the project index, so quick open, find-references,
  the overview and the Problems panel cover it exactly as they cover a sequence
  diagram — and the event-driven checks (`Event X has no producer`, `Unknown
service "Ghost"`) are what an EDD review actually wants.
- **Everything else works too.** Event flows open in the same tab strip (with a
  `⇄` glyph), the same editor with context-aware completion
  (`OrderService publishes ␣` offers the events the project declares, including
  ones another flow declares), the same outline, the same viewport, the same
  source↔diagram selection, and the same export pipeline (SVG/PNG/PDF).

**Phases 0–9 are implemented** on this branch: the sequence language and its
renderer, the interactive editor, in-browser and folder-backed projects, tabs and
commands, the DSL v2 backlog, the documentation workspace, and the project
intelligence layer described below. `npm test` runs 1000+ tests, `npm run
test:e2e` drives 70 checks against the production bundle in Chromium, and
`npm run lint`, `npm run typecheck`, `npm run build` and `npm run format:check`
are clean.

**Phase 10 (project intelligence).** The app stopped being a set of editors over
files and became a project-aware IDE:

- **Stable resource ids.** A file's _path_ can change; its _id_ cannot. Every
  resource gets an id (`diagram-payment-processing`) recorded in the project's
  `project.json`, so `resource://` links survive renaming and moving, and an agent
  can read a project's identity without running the app. A project that predates
  ids gains them deterministically the first time it is opened — see
  `src/domain/workspace/metadata.ts`.
- **A project index.** Every symbol (participants, actors, and an inferred
  architectural role), every reference, every usage span and every diagnostic is
  derived from the files into a `ProjectIndex`. Analysis is per-resource and cached
  by content fingerprint, so editing one diagram re-parses one diagram, not the
  project (`src/domain/project/`).
- **Problems panel.** Project-wide diagnostics from one UI-independent service:
  parse errors, unresolved participants, unused participants, duplicate resource
  ids, duplicate titles, broken stable references, broken embeds and unresolved
  links. Clicking a problem opens the file and selects the range.
- **Outline panel.** A statement tree for a diagram (title, participants, flow,
  fragments and their branches) and a heading tree for a document. Clicking a row
  selects the corresponding source.
- **Semantic completion and hover.** Completion is context-aware — after an arrow
  only participants, inside a fragment only the statements that can appear there,
  never inside a label — and draws names from the index, so `Pay` offers
  `PaymentService`. The popup never takes a key the user did not give it: Enter
  inserts a newline unless a suggestion has first been highlighted with ↓/↑ (so a
  blank line is always possible), `Tab` accepts the highlighted suggestion (the
  top one if none is highlighted), ↓/↑ walk the list only while it is open, and
  Escape dismisses it. A blank line opens no popup at all — only a word being
  typed, or a position that names participants or events, does. Hover answers
  "what is this?" with the declaration site and how many interactions use it.
- **Quick open (`Ctrl/Cmd+P`)** over resources, participant symbols and document
  headings, with fuzzy ranking. The command palette moved to `Ctrl/Cmd+Shift+P` so
  the two overlays do not fight over one shortcut.
- **Source ↔ diagram selection.** Every addressable AST node gets a deterministic
  id from its source range; the layout carries it and the SVG exposes it as
  `data-node-id`. Clicking a rendered message, participant, note, activation or
  fragment selects exactly that statement in the editor, and moving the caret
  highlights the corresponding element — in both directions by id lookup, never by
  matching text.
- **Find references and semantic rename.** A symbol's declarations and every
  endpoint mention, listed across the project; renaming rewrites only the spans the
  analyser identified, so prose that mentions the same word is untouched.
- **Diagram embedding.** `{{diagram:<id>}}` renders the current diagram inside a
  markdown document; clicking the embedded picture opens its source, and a target
  that does not exist renders a visible placeholder and a project error.
- **Project overview.** A dashboard over the index — resources, symbols,
  diagnostics — that counts what the index already derived rather than recomputing
  anything.

**Phases 0–7 are complete** and committed on `master`: repository foundation,
sequence language core, layout + SVG rendering, the interactive live editor,
in-browser projects (IndexedDB), local folder projects (File System Access API),
editing productivity (tabs, command palette, search), and the DSL v2 backlog. The
branch builds, serves, lints, type-checks, and passes its test suite — 786 unit
tests plus 60 browser checks against the production bundle (`npm run test:e2e`),
and the same bundle is served by the Docker image.

**Phase 7 (DSL v2) has landed its Mermaid-parity backlog.** The sequence language
now covers participants, actors, aliases, every arrow family, activations,
notes, and the control-flow fragments:

- **Participants, actors, and labels** — `participant User` declares a name box,
  `actor User` a human figure, and `participant auth as "Authentication Service"`
  pairs a stable id with a readable label. Declaration order controls placement,
  and the participant band grows when any lifeline is an actor so the glyphs stay
  aligned.
- **Aliases** — `alias X = participant` binds a shorthand that messages may use
  in place of the full participant name. An alias whose target is undeclared is
  reported as a diagnostic, and aliases may not chain. Layout resolves a
  shorthand to the target lifeline, so an aliased sender's arrow attaches
  correctly instead of falling back to the margin.
- **The message model** — a message carries `lineStyle` (`solid` / `dashed`) and
  `arrowStyle` (`none` / `arrow` / `open` / `cross` / `bidirectional`) rather
  than an arrow string, and the parser maps all ten spellings onto it. The
  renderer draws the matching ending, including a chevron for the async `-)` and
  an ✕ for the failed `-x`.
- **Self-messages** — `A ->> A: Work` (or two spellings of one participant via
  an alias) draws a loop out of and back onto that lifeline, with the arrowhead
  pointing at the lifeline and the label beside the loop. Two self-messages are
  not treated as one: each takes its own row, and the canvas widens so a loop and
  its label on the rightmost lifeline stay inside the drawing.
- **Activations** — `activate X` / `deactivate X` draw a bar over a lifeline for
  the span in which that participant is working, and the inline `+` / `-`
  suffixes on a message are normalized into the same statements (`+` activates
  the receiver, `-` deactivates the sender) so the bar's edge lines up with the
  arrow. Bars nest, take no message row of their own, and a bar left open runs to
  the bottom; a `deactivate` with no open bar is reported.
- **Notes** — `note left/right of <participant>`, `note over <participant>`, a
  spanning `note over API,DB : text`, a diagram-wide `note over : text`, a note
  attached to a message by its step number (`note on 3 : text`, matched against
  the circled sequence number), and a multiline body closed by `end note`. A note
  flows fully through the pipeline — a `note` lexer token, a `NoteNode` in the
  AST, `MalformedNote` / `UnknownMessageNumber` diagnostics, placement in the
  layout engine, and a folded note box in the SVG renderer.
- **Control-flow fragments** — `loop`, `alt`/`else`, `opt`, `par`/`and`,
  `critical`/`option`, and `break` are explicit nested statements
  (`loop`/`opt`/`break` own a `statements` list; the others own labelled
  branches). The layout engine frames the rows a fragment contains, sizes the
  frame to the participants it mentions, insets nested frames, and the renderer
  labels the frame and each `else` / `and` / `option` divider. Fragments nest
  arbitrarily, and an unclosed one is reported instead of silently swallowing the
  rest of the document.

Phase 8 (export to SVG, then PNG) has not started.

**Phase 9 (documentation workspace) is implemented on top of that**, in the
working tree. Its first milestone is the documentation half of the product: the
workspace stopped being only a container for `.seq` files and became a place to
document a system.

- **One tab strip for every document kind.** A `Tab` used to be diagram-shaped.
  It is now a `TabDocument` carrying a `kind` (`diagram` or `note`) alongside its
  id, project, name, and buffer, so a diagram and a markdown document stay open
  side by side, switching follows the tab, and closing the active tab moves the
  editor to the tab that replaces it. Each tab also remembers the buffer it last
  persisted, which is what the strip's modified indicator reports. The shared
  shape lives in `src/domain/workspace/resource.ts`, a thin view over the
  existing stores rather than a second domain.
- **Markdown is a first-class resource.** The renderer gained pipe tables and
  images, and an ordinary relative link (`[Payment flow](../diagrams/pay.seq)`)
  now resolves against the project's resources (`src/domain/workspace/project-link.ts`)
  and opens in-app, exactly as a `[[wiki-link]]` does. Resolution stays in the UI:
  the renderer emits `data-resource-link` and never learns about the workspace.
- **Project-wide search.** `Ctrl/Cmd+Shift+F` opens a find-in-files overlay over
  every diagram and document. The scan is a pure function
  (`src/domain/search/project-search.ts`) over documents built lazily while the
  overlay is open, so editing never pays for an index. Queries understand
  `kind:`, `project:`, and `participant:` scopes; a result opens its document and
  selects the matched range through a value-shaped reveal request
  (`src/features/editor/reveal.ts`) shared by both editors.
- **Portable project archives.** **Export Project** writes the selected project
  to a deterministic ZIP — a `project.json` manifest plus `diagrams/` and `docs/`
  — and **Import Project…** recreates it with fresh ids, so importing can never
  overwrite something local. The ZIP codec is owned in-process
  (`src/workspace/transfer/zip.ts`) rather than added as a dependency, in keeping
  with the project's "own the domain" stance.

Phase 8's remaining half (SVG/PNG/PDF diagram export with options) has not
started; the archive above is a project export, not a diagram export.

Alongside the language work, the workspace gained **safe delete**, a **Trajectory
version history**, **collapsible note bullets**, and a **documentation layer**:

- Deletes are confirmed in a dialog. With a local folder open the user chooses
  between removing an entry from the app (a hidden-path set kept in
  `src/workspace/hidden-paths.ts`, so the file survives on disk) and deleting it
  from disk; hidden entries can be restored from the explorer.
- Version history lives in its own store (`src/workspace/version-history.ts` plus
  an IndexedDB implementation), separate from the workspace repository, because a
  timeline is app-local metadata that must survive independently of which
  repository is active. Checkpoints are content-aware, so an unchanged buffer
  never grows the timeline. A local-folder rename moves the timeline to the file's
  new id.
- Notes render as bullets attached to their element and expand into their callout
  on click. The expanded set is a render-time option, so the layout — and the
  viewport's pan/zoom — is unaffected by toggling.
- A project now holds markdown notes as well as diagrams, and its `＋` button
  offers to create either kind (the explorer's context menu renames, retitles,
  duplicates, or deletes either kind). Duplicates are named by
  `src/domain/workspace/copy-name.ts`, so in-browser and folder projects agree. In
  a local folder the
  extension is what distinguishes them (`.md` is a note, anything else a diagram),
  so a project directory is a readable documentation tree outside the app too. The
  markdown renderer and title helpers live in `src/language/markdown`, and the
  IndexedDB schema gained a `notes` store (version 2), which upgrades in place.

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
