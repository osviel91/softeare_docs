# Server Migration — Phases 0–3 (Authentication, Projects, Authorization)

SequenceDiagrams Manager is a local-first browser application with a stdio MCP
server. This mission turns it into a **secure multi-user system**: authenticated
browser users, server-managed projects, an HTTPS API, a remote MCP server, and
project-level authorization — without removing local-first mode and without a
second implementation of any project operation.

The full mission spans thirteen phases. This plan covers the first four and
stops before Personal Access Tokens or remote MCP, as the mission instructs.

## Goal

```
Browser ──► Web API ──┐
                      ├──► Application layer ──► Domain ──► Persistence
MCP client ─► MCP ────┘                    └──► Authorization
```

One use case — `updateResource(context, command)` — reached through REST **and**
through MCP. The two hosts are separate deployable processes that share
TypeScript modules, and neither owns a project operation the other lacks.

## Deliverables

### Phase 0 — Architectural refactor

- `docs/plan/server-migration-0-3.md` (this file) and **ADR-039**.
- `src/application/` as the one layer every host calls:
  - `context.ts` — `Principal`, `ApplicationContext`, `localContext()`.
  - `errors.ts` — `ApplicationError` with transport-neutral codes.
  - `ports.ts` — `ProjectWorkspace`, `ProjectWorkspaceProvider`.
  - `project-service.ts` — moved from `src/services/` (the React shell imported
    it, so re-homing it is a pure rename of the import).
  - `local-workspace-provider.ts` — the local-first implementation of the port,
    with the host injecting the `FsDirectoryHandle` factory so the application
    layer never imports `node:fs`.
- `src/domain/access/permissions.ts` — the capability vocabulary: roles
  (`OWNER`/`EDITOR`/`VIEWER`), permissions, agent profiles, and the OAuth →
  permission mapping.
- `DocumentationWorkspace.over(provider)` — the application service runs over
  any provider, proven by tests that serve it from an in-memory store.
- `tests/architecture/boundaries.test.ts` — the dependency rule as a test.

### Phase 1 — Server persistence foundation

- PostgreSQL schema and migrations: `users`, `projects`, `project_members`,
  `resources`, `personal_access_tokens`, `sessions`, `audit_events`.
- A driver port with two implementations: `pg` for deployment, PGlite for
  hermetic tests.
- Server project storage on a persistent volume (`/data/projects/<project-id>`)
  with a validated relative path boundary and no client-supplied absolute paths.
- Repositories for projects, members and resources, plus an audit writer.
- A server `ProjectWorkspaceProvider`, so the _same_ application service runs
  against the server.
- Optimistic concurrency: `resources.revision` with a conditional update that
  reports `409 Conflict` when the expected revision is stale.

### Phase 2 — User authentication

- OIDC authorization-code + PKCE against a standards-compliant provider.
- BFF sessions: `HttpOnly`, `Secure`, `SameSite` cookie; no token in
  `localStorage`. Sessions are stored hashed, server-side.
- `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /api/me`.
- Identity mapping on `(issuer, subject)` → internal `User.id`; email is never
  the key.
- A `Principal` is built at the edge; nothing below it sees a cookie.

### Phase 3 — Authorization

- `authorize(principal, permission, project)` in `src/domain/access/`.
- Role lookup through `project_members`, cached per request.
- Enforcement inside the application use cases — not in controllers and not in
  MCP tools, which is what stops an MCP tool from bypassing authorization.
- Tests: viewer cannot write; editor can write; editor cannot administer
  members; a user cannot reach another user's project; a project-restricted
  token cannot reach another project.

## Boundaries this plan must not cross

- Local-first mode keeps working: the IndexedDB and File System Access
  repositories are untouched in behaviour, and the browser keeps opening local
  projects.
- No business logic is duplicated: the API and MCP adapters share every
  operation.
- No cryptography is written in-process for identity: OIDC verification uses a
  maintained library, and secrets are hashed with `node:crypto`.
- Paths are never authority: `userId`, `projectId` and `resourceId` are the
  identifiers; a path is resource metadata validated against traversal.

## Verification

Every phase ends with `npm test`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build` (all bundles), the PostgreSQL-backed
server tests, and one checkpoint commit.
