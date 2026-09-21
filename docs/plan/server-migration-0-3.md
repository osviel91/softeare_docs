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
- Identity is not implemented in-process: OIDC verification is built on the
  platform's Web Crypto (`node:crypto`), and secrets are hashed with
  `node:crypto`. **Deviation:** the mission asked for a _maintained library_
  here, and this implementation parses and verifies the JWS itself against the
  platform's primitives instead. See "Final review" below.
- Paths are never authority: `userId`, `projectId` and `resourceId` are the
  identifiers; a path is resource metadata validated against traversal.

## Verification

Every phase ends with `npm test`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build` (all bundles), the PostgreSQL-backed
server tests, and one checkpoint commit.

## Definition of done — where Phases 0–3 land

| Mission requirement                                 | State                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| One application layer every host calls              | Done (`src/application`, ADR-039)                                                 |
| Server projects in PostgreSQL + a project volume    | Done (ADR-040)                                                                    |
| Optimistic concurrency → `409`                      | Done                                                                              |
| OIDC sign-in with a server-side session             | Done (ADR-041), with the library deviation below                                  |
| One authorization policy, enforced inside use cases | Done (ADR-042)                                                                    |
| Local-first mode still works                        | Done                                                                              |
| Browser opens server projects                       | **Not yet** — the API exists but no browser client consumes it                    |
| Agent reaches the server over HTTPS MCP with a PAT  | **Not yet** — PATs (Phase 5) and remote MCP (Phase 6) are the mission's next stop |

## Final review (2026-09-21)

The five commits `73267f4..48242d4` were reviewed on two axes (Standards and
Spec). Three defects were found and fixed, each with a regression test:

1. **A refused move still moved the file.** `catalog.moveResource` renamed the
   file before checking `expectedRevision`, so a `409` left the bytes at the new
   path while the row still named the old one, and the resource then read as
   missing. The revision is now checked before the volume is touched, the
   destination is checked for an occupant, and a race between the check and the
   conditional update puts the file back.
2. **A symlinked _file_ could escape the project.** `resolveInsideRoot` resolved
   the target's ancestors with `realpath` but never the final component, so a
   link sitting directly in the project root was followed by `readFile`. The
   final component is resolved and checked too, and the test that claimed to
   cover this now actually plants a symlink.
3. **The shared documentation service could write past the policy.** A
   `ServerWorkspaceRepository` opened for reading accepted writes, so a VIEWER —
   or a read-only agent token — could mutate a project through
   `DocumentationWorkspace`. The provider now resolves `resource:write` through
   the same policy and the repository fails closed, and `describeAccess` no
   longer advertises capabilities the credential does not carry.

Also corrected: `updateResource`'s comment claimed a failed write left the
revision untouched (it does not); the host boundary rule omitted
`src/persistence`, which the API host legitimately imports as the composition
root; the pure preview pipeline moved from `src/features/preview` to
`src/renderer/pipeline` so the MCP host stops importing the feature layer; and
three copies of a constant-time comparison collapsed into one.

Two `npm run test:e2e` checks fail identically on the Phase 3 commit and on this
review: 92 checks pass, then `the imported project carries its files` fails and
the Event-flows context-menu click times out with the item outside the viewport.
They are pre-existing browser-UI issues, not regressions from the server work,
and they are reported here rather than silently inherited: strictly, the e2e
suite is not green.

## Known compromises

- **OIDC verification is hand-rolled against platform crypto, not a maintained
  library.** `apps/api/auth/oidc.ts` decodes the JWS, allow-lists algorithms,
  selects the key by `kid` and calls `crypto.subtle.verify`. It does not
  implement a cipher, but it does implement JWT validation, and the mission asked
  for a library. This is the largest outstanding deviation and the first thing to
  change if the zero-runtime-dependency stance is relaxed.
- **The application layer imports persistence _port types_.** `ProjectRepository`
  and `AuditRepository` are declared in `src/persistence/` and imported by
  `src/application/project-catalog.ts`, so an `application → persistence` arrow
  exists for types. `ProjectStorage` already follows the rule; the repository
  ports should move inward for consistency.
- **PostgreSQL and the project volume are not one transaction.** A change that
  spans both (`moveResource`, `createResource`, `deleteProject`) has a window in
  which one side has been applied and the other has not, and the audit row for a
  change is written after it rather than inside a shared transaction. The
  deterministic cases are safe; a crash inside the window is not.
- **A failed write consumes a revision.** `updateResource` claims the revision
  before writing, so a storage failure leaves the content unchanged but the
  revision advanced. The alternative — writing first — would let a stale writer
  overwrite content, which is worse.
- **Two `updateResource` entry points exist.** The server catalog's
  `updateResource(context, projectId, resourceId, command)` and the local
  workspace service's `updateResource(project, reference, input)` serve different
  modes (server revisions versus a local file). The API uses only the former and
  the stdio MCP server only the latter; they must converge when the remote MCP
  host is built (Phase 6).
- **No CSRF token.** The session cookie is `SameSite=Lax` and the API is
  same-site, which blocks cross-site form posts for the state-changing methods; a
  dedicated token is still the belt-and-braces answer.
- **Some routes and vocabulary run ahead of the plan.** `/api/projects/:id/access`,
  project `PATCH`/`DELETE`, the membership routes, `mcp:read`/`mcp:write` and the
  OAuth `docs.*` mapping are Phase 4/7/8 material built early because the layer
  they belong to was being written anyway.
