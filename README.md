# Software Docs Manager

Software Docs Manager is a local-first browser IDE for documenting software
systems. It combines editable sequence diagrams, event flows, and Markdown in
projects that can be rendered, searched, validated, exported, and shared with
coding agents.

## The Product

Software documentation is often split between prose, diagramming tools, and
files that drift apart. This project keeps those artifacts together while
keeping the source readable outside the application.

The product owns the diagram languages and rendering pipeline. The editor,
stdio MCP server, HTTP API, and remote MCP service use the same domain and
application services rather than separate interpretations.

## Capabilities

Projects contain three resource types:

- **Sequence diagrams** use `.seq` source for participants, messages, notes,
  activations, and control-flow fragments.
- **Event flows** use `.eventseq` source for events, producers, consumers,
  brokers, channels, publications, and subscriptions.
- **Documentation** uses `.md` Markdown files with headings, links, wiki-links,
  and diagram embeds.

Resources can be edited in mixed tabs, validated, rendered to deterministic SVG,
searched across a project, renamed without losing stable local identity, and
exported as portable project archives. The project index supplies diagnostics,
outlines, symbols, references, completion, and search facts.

Each resource can also carry optional semantic context: a short multiline
description and compact tags. The editor shows this context above the source for
sequence diagrams, event flows, and Markdown, with an inline edit affordance;
clearing both fields removes the block. Server projects save it with the same
optimistic revision checks as source edits, while read-only projects only show
the context. The API and remote MCP expose the same metadata to agents. It is
context for people and agents, not a search taxonomy.

The browser editor provides an explorer, source editor, outline and problems
views, live or explicit rendering, pan/zoom navigation, version history, safe
delete, Markdown preview, and project-wide search.

Project search is metadata-aware: plain text searches names, descriptions, tags,
and content. Use `tag:payments`, `tag:ddd aggregate`, `type:diagram checkout`, or
`type:note deployment` to combine exact tag/type filters with a text query.

## Local And Server Operation

Local-first is the default. A browser can store projects in IndexedDB or open a
folder through the File System Access API. A folder remains a readable project
tree, and the stdio MCP server can work on the same kind of filesystem
workspace.

Server mode adds authenticated shared projects. The API stores project identity,
memberships, resource metadata, revisions, sessions, and audit events in
PostgreSQL; resource content remains in the project storage volume. Workspace
membership scopes which projects are visible and accessible, and project roles
control permissions within an accessible project. Server writes use optimistic
revisions so stale edits are rejected instead of silently overwriting changes.

The browser uses the same editor for local and server projects. The remote MCP
service is a separately deployable, authenticated service over the shared
application layer. It does not call the HTTP API over the network.

## Human And Agent Workflows

Humans can create a project, choose a resource type, edit its source, inspect
diagnostics, and follow links between diagrams and Markdown:

1. Create or open a local project, or sign in to a server workspace.
2. Add sequence, event-flow, and Markdown resources.
3. Use the outline, search, references, and problems views while editing.
4. Render or export the result and keep the source in the project tree.

Agents can use the local stdio MCP server for filesystem work or the authenticated
remote MCP service for server projects. Both expose discovery, resource reads and
writes, validation, rendering, search, and documentation workflows. Writes return
diagnostics; destructive deletes require confirmation.

## Architecture At A Glance

Diagram source follows the shared pipeline:

```text
DSL -> lexer/parser -> AST -> validation -> layout -> render model -> SVG
```

The Markdown renderer is a separate source-to-HTML path. The project index,
search, archive, and MCP layers consume project resources beside the rendering
pipeline. React is a host for the editor, not the owner of language semantics.

The main boundaries are:

- `src/language` parses and validates source without React.
- `src/domain` contains framework-free models, indexing, search, and policies.
- `src/layout` computes geometry; `src/renderer` emits SVG without parsing.
- `src/application` contains shared use cases and authorization.
- `src/workspace` provides local repository adapters.
- `src/persistence` provides server repositories and project storage.
- `mcp/`, `apps/api/`, and `apps/mcp/` are stdio, HTTP, and remote-MCP hosts.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries and decision records,
and [CONTEXT.md](./CONTEXT.md) for the project vocabulary.

## Development

Requirements: Node.js and npm.

```bash
npm ci
npm run dev
```

The development server runs at <http://localhost:5173/>. Useful checks:

```bash
npm run verify       # lint, typecheck, full tests, MCP build/smoke/tests
npm run build        # production web, API, stdio MCP, and remote MCP bundles
npm run format:check
```

For browser smoke tests, install Chromium once and run:

```bash
npx playwright install chromium
npm run test:e2e
```

The broader container check is `npm run test:containers`.

To build and run the local stdio MCP server:

```bash
npm run mcp:build
node dist-mcp/server.mjs --workspace ./docs
```

## Deployment

The static local-first deployment needs only the web image:

```bash
docker compose up --build -d
```

It serves the browser at <http://localhost:8080/> by default. Portainer users
can use [`deploy/portainer-stack.yml`](./deploy/portainer-stack.yml); pin
`IMAGE_TAG` to an immutable image tag for repeatable deployments.

The full server deployment runs the reverse proxy, web app, API, remote MCP,
and PostgreSQL:

```bash
docker compose -f compose.production.yml up --build -d
```

Configure the required secrets, database, public URLs, and OIDC values from
[`.env.example`](./.env.example). Published images can be supplied through
`WEB_IMAGE`, `API_IMAGE`, `MCP_IMAGE`, and `PROXY_IMAGE`.

## Documentation Map

- [Architecture and ADRs](./ARCHITECTURE.md)
- [Current vocabulary](./CONTEXT.md)
- [H01 architecture baseline](./docs/architecture-baseline.md)
- [Historical plans and reports](./docs/history/README.md)
- [Production deployment files](./deploy/)
- [Static Docker composition](./docker-compose.yml)
- [Full server composition](./compose.production.yml)

Build output in `dist/`, `dist-mcp/`, `dist-api/`, and `dist-mcp-service/` is
generated and is not source documentation.
