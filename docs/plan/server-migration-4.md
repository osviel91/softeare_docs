# Server Migration — Phase 4 (Browser/Server Workspace, E2E, Hardening, Cleanup)

Phase 4 completes the authenticated browser → server-project workflow and stabilises
the system before Phase 5 adds Personal Access Tokens. It builds directly on
[Phases 0–3](server-migration-0-3.md): the API, the application layer, the
authorization policy and the PostgreSQL/volume persistence already existed at the
Phase 3 checkpoint (`f87f818`); what was missing was a browser that could use them.

```
Browser  ──OIDC/session──►  API  ──►  Application  ──►  Authorization
   │                                    │
   │  LocalWorkspaceRepository          ├── PostgreSQL
   │  ServerWorkspaceRepository ────────┴── project volume
   ▼
Editor (one experience, two stores)
```

## Goal

The editor must not have a "server mode". It must have **one** editor that runs
against either storage, chosen at the workspace seam:

```
Editor / UI  ──►  WorkspaceRepository  ──┬── LocalWorkspaceRepository
                                         └── ServerWorkspaceRepository
```

Local-first mode keeps working and is never gated behind a login.

---

## Phase 4A — Server workspace integration in the browser

### The seam that already existed

`src/workspace/WorkspaceRepository.ts` is the project-scoped store contract the
editor already depended on (`listProjects`, `listDiagramFiles`, `saveNoteFile`,
`renameDiagramFile`, …), and `src/application/ports.ts` already distinguished a
plain store from a `RevisionedWorkspaceRepository`. Nothing about the abstraction
had to change: Phase 4 added a third implementation and a way to select it.

### New browser modules

| Module                                                | Responsibility                                                                                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workspace/server/api-errors.ts`                  | The typed failure vocabulary (`RevisionConflictError`, `AuthenticationRequiredError`, `AccessDeniedError`, `ResourceNotFoundError`, `ValidationFailedError`, `ServerError`, `NetworkError`). |
| `src/workspace/server/api-client.ts`                  | The only module that knows the HTTP surface. Same-origin, cookie-credentialed, envelope-unwrapping.                                                                                          |
| `src/workspace/server/server-workspace-repository.ts` | `WorkspaceRepository` (and `RevisionedWorkspaceRepository`, and `ForceWritableWorkspaceRepository`) over that client, bound to one project.                                                  |
| `src/features/server/use-auth.ts`                     | `AuthState` (`loading` / `anonymous` / `authenticated`) from `GET /api/me`.                                                                                                                  |
| `src/features/server/use-server-workspaces.ts`        | The server project list, creation, and the open binding (project + repository + `writable`).                                                                                                 |
| `src/features/explorer/WorkspaceSwitcher.tsx`         | The `LOCAL` / `SERVER` picker above the explorer tree.                                                                                                                                       |
| `src/features/ui/SaveConflictDialog.tsx`              | The `409` decision.                                                                                                                                                                          |

### Three shape differences the adapter hides deliberately

- **Identity.** A local file's id _is_ its path; a server resource has an opaque
  database id and a separate `path`. The editor already tolerated both, because
  `useWorkspace` follows a returned copy whose id may differ.
- **Concurrency.** Only the server has revisions. The adapter remembers the
  revision it last read for each resource and sends it with every write; when it
  has no cached revision it reads the resource first rather than writing blind.
- **Project identity.** The adapter is constructed for exactly one project, so a
  project id never arrives from a click — only from an already-authorized
  listing. Creating and listing _projects_ is the switcher's job, so those methods
  refuse, exactly as the server-side repository does.

React components never see a path, a URL or a status code.

### Errors, dirty state and conflicts

- `useTabs` used to swallow a failed auto-save. It now exposes
  `saveError` / `retrySave` / `markActiveSaved` / `dismissSaveError`, and the shell
  renders either a retryable status-bar error or the conflict dialog. A failed
  write **never** clears the tab's dirty flag: the buffer is the user's work.
- Two different workspaces are two different stores, so switching repositories
  drops the open tabs (`useTabs`) and the workspace-wide file lists
  (`useWorkspace`). A stale id must never be replayed against a store that never
  issued it.
- On a `409` the dialog offers **Reload server version**, **Keep my changes**
  (an explicitly confirmed overwrite at the revision the server just reported,
  implemented as `ForceWritableWorkspaceRepository` and still refused if someone
  wrote again in between), **Copy my changes**, and **Cancel** (buffer kept,
  still dirty). Nothing silently overwrites and nothing is lost.
- A transport failure is a `NetworkError`, never an `ApiError`: nothing was
  refused, so nothing is reported as refused, and the banner offers a retry.

### The bug the E2E work found

`apps/api/http/node-server.ts` wrote every response header with
`setHeader`. Node **replaces** on a repeated name, so a login response carrying
both `Set-Cookie: sdm_session=…` and `Set-Cookie: sdm_login=; Max-Age=0` sent only
the second — the session cookie never reached the browser and every sign-in
appeared to succeed but left the user anonymous. The router-level tests could not
see it because they inspect the returned header array, not the wire.

Fixed by writing `set-cookie` with `appendHeader`, and pinned by
`tests/api/node-server.test.ts`, which starts a real `node:http` listener and
asserts `getSetCookie()` returns both cookies.

---

## Phase 4B — E2E stabilisation

Both known failures were root-caused and fixed at the cause, not by raising a
timeout.

1. **`the imported project carries its files`** — a _test-expectation_ defect.
   The assertion counted `explorer-diagram` / `explorer-note` rows across the
   whole explorer, so it measured every project's files rather than the imported
   project's. Scope the count to the imported project's own row
   (`[aria-current="true"]`), and a unit regression in
   `tests/app.transfer.test.tsx` that keeps a second project with a file present
   while importing.
2. **Event-flow context-menu click timeout** — a real UI defect. The menu is
   `position: fixed`, anchored below the `＋` button, and was never clamped to the
   viewport; on a long explorer the third item ("New event flow") was rendered
   below the fold where Playwright correctly refused to click it.
   `ContextMenu` now measures itself and shifts into the viewport before paint
   (`clampMenuToViewport`, unit-tested). The E2E log named the cause exactly —
   _"element is outside of the viewport"_ — which is why it was not a locator or
   overlay problem.

Authenticated browser scenarios are covered by `npm run test:e2e`, which builds
the web bundle and the API, starts a **loopback OIDC provider** (real RSA signing,
real PKCE, no external dependency) and the real API, and drives Chromium through:

1. sign in → create a server project → create a sequence diagram → edit → save →
   reload → reopen, with the content asserted **on the server**, not just in the
   editor;
2. the same for a Markdown document;
3. two browser contexts on one document: the first saves, the second saves from a
   stale revision and gets the conflict dialog, the server content is unchanged,
   and _Reload server version_ shows the first client's text;
4. a second user added as `VIEWER`: reading works, and both the UI and the server
   refuse a write;
5. a fresh anonymous context: local projects still work and the server section
   asks for a sign-in instead of listing projects.

Making the switcher fit meant the explorer scrolls on Playwright's 720-pixel
viewport, which changes what a click on a context-menu item has to wait for; that
was resolved in the harness with concrete waits on the tab/note a scenario
created, never by raising a timeout.

### Defects the stabilisation surfaced

Making the gates reproducible found three things that were not on the mission's
list:

1. **A login dropped its own session cookie** (see Phase 4A above). Found because
   the harness had to sign in through the real transport for the first time.
2. **"Newest first" was not deterministic.** Listings order by
   `(occurred_at DESC, id DESC)`, and `occurred_at` is the database's clock, which
   collides at its own resolution — but ids were plain UUIDv7, whose 80-bit tail
   is random, so the tie-break was random and an audit listing could return an
   older event first. `createIdGenerator` is now monotonic within a millisecond
   (a repeated tick advances the previous tail), which makes the tie-break mean
   what it says and keeps primary-key inserts append-mostly. Pinned by
   `tests/shared/ids/uuid.test.ts` and by an audit-ordering test that gives two
   rows an explicitly identical timestamp.
3. **A loaded machine failed a test _hook_ rather than an assertion.** The API and
   persistence suites boot PostgreSQL-in-WASM and run every migration in
   `beforeAll`; vitest's 10-second default was close enough to that work to fail
   under load, which is a red suite that says nothing about the code. The hook
   timeout is 30 seconds; the assertions keep the default.

---

## Phase 4C — OIDC/JWT hardening

Bespoke compact-JWS parsing, Web-Crypto signature verification and a hand-rolled
JWKS cache were replaced with [`jose`](https://github.com/panva/jose) 6.x:

- `createRemoteJWKSet(jwks_uri, { cooldownDuration: 0, [customFetch] })` owns the
  key set and the cache. `cooldownDuration: 0` is deliberate: jose's 30-second
  default would make a rotated key fail until the cooldown lapsed, which the
  "rotated key" regression test proves.
- `jwtVerify(token, keySet, { issuer, audience, algorithms, clockTolerance, currentDate, requiredClaims })`
  — issuer, audience and the algorithm allow-list come from configuration and are
  **never** taken from the token. `none` and the HMAC family are refused before a
  key lookup.
- The `nonce` check, the non-empty `sub` check and the display-name derivation
  stay in the exported `verifyIdTokenClaims`, because jose does not do them.

Rejected explicitly: wrong issuer, wrong audience, expired, not-yet-valid,
invalid signature, unknown/retired key, unsupported algorithm, missing subject.
Covered by deterministic tests over the real local provider in
`tests/api/auth.test.ts` (no external IdP, real signatures, real PKCE).

---

## Phase 4D — Architectural cleanup

### 14. Persistence ports moved into the application layer

`ProjectRepository`, `AuditRepository`, their record types and
`InvalidResourcePathError` now live under `src/application/ports/` (`index.ts`,
`project-repository.ts`, `audit-repository.ts`, `resource-path.ts`). The
PostgreSQL modules import them and re-export for existing callers, so the arrow is
now `persistence → application ports` and never the reverse. Enforced by a new
case in `tests/architecture/boundaries.test.ts`.

### 15. `updateResource` convergence (preparation, not merge)

Two entry points remain, as the mission allows:

| Entry point                                 | Store                    | Concurrency                    |
| ------------------------------------------- | ------------------------ | ------------------------------ |
| `catalog.updateResource` (server API + MCP) | PostgreSQL rows + volume | revisions, `409`               |
| `useWorkspace.save*` (browser, local mode)  | IndexedDB or a folder    | none (one editor, one machine) |

They are **not** merged in this phase, but they are deliberately kept from
diverging further: both speak the same `WorkspaceRepository` contract, both
produce/consume the same `DiagramFile`/`NoteFile` shapes, and every naming rule
(`uniqueDiagramName`, `uniqueCopyName`, `ensureMarkdownExtension`) is shared
domain code rather than a per-store decision. The Phase 6 target is:

```
                 Application Use Cases
                          ▲
        ┌─────────────────┼─────────────────┐
     Local            Server API           MCP
  (IndexedDB /      (catalog + rows     (same catalog,
   folder)           + volume)           different transport)
```

Local persistence may remain a separate adapter; what must converge is the _use
case_, which is what `catalog.updateResource` already is.

### 16. PostgreSQL + volume atomicity

No distributed transaction is attempted. The failure matrix is now documented and
tested (`tests/persistence/project-catalog-atomicity.test.ts`, which injects a
failure into one side at a time):

| Operation | First step    | Second step  | State after a failure                | Recoverable?                                     |
| --------- | ------------- | ------------ | ------------------------------------ | ------------------------------------------------ |
| create    | volume write  | row insert   | file only, no row                    | orphan file; reconcilable, not automatic         |
| update    | revision bump | volume write | revision consumed, content unchanged | yes — re-read, retry at the new revision         |
| move      | volume move   | row move     | file moved back, row unchanged       | yes (compensation), unless the row call _throws_ |
| delete    | volume remove | row delete   | file gone, row remains               | yes — reads report `not_found` with the reason   |

The one case without compensation is a `move` whose two steps straddle a thrown
database error — the bytes stay at the new path and the row names the old one.
That is recorded rather than hidden; closing it belongs to the Phase 6
outbox/compensation work.

### 17. Revision semantics

The design deliberately **consumes a revision on a write that fails after the
claim** (`updateResource` claims the revision before writing the bytes, so a stale
writer can never touch the file). This is intentional and now observable:
`tests/persistence/project-catalog-atomicity.test.ts` asserts that a failed write
moves revision 1 → 2 with unchanged content, and that a blind retry at revision 1
is then refused as `conflict`.

Clients must therefore treat a revision as **opaque monotonic concurrency state**:

- send the revision you last read; never compute one;
- never assume `revision + 1` equals "number of successful writes";
- on `409`, re-read and retry (or, in the browser, resolve the conflict
  explicitly).

### 18. Audit reliability

Audit rows are written after the mutation. That used to mean an audit-store
failure made an already-committed mutation look like a failure, which invites a
duplicate retry. `writeAudit` now reports the failure through an injectable
`onAuditFailure` (defaulting to a correlation-id line on stderr) and lets the
committed mutation stand — observable without being a lie. Asserted by
`tests/persistence/project-catalog-audit.test.ts`, which also asserts that no
audit row serializes a document's bytes, a session token or a cookie.

**Future option: transactional outbox.** The durable fix is to write the audit
event into an `outbox` table _in the same transaction_ as the row change, and
have a relay move rows into `audit_events` (and, later, publish server-side
events). That is Phase 6 scope; it is recorded here so the current behaviour is a
known trade-off rather than an accident.

---

## Security review

Scope: OIDC, sessions, authorization, server workspace paths, symlink handling,
revision conflicts, CSRF, project isolation.

### OIDC

Authorization code + PKCE (S256 required), signed short-lived login-state cookie,
`state` compared against the cookie, `nonce` compared against the ID token,
signature/issuer/audience/expiry/not-before verified by `jose` against a remote
JWKS with an explicit algorithm allow-list. The raw ID token is verified and
discarded; the browser only ever holds this server's session cookie. A provider
error is logged with a correlation id and never echoed to the browser.

### Sessions

| Property   | Value                                                                         | Where                     |
| ---------- | ----------------------------------------------------------------------------- | ------------------------- |
| `HttpOnly` | always                                                                        | `apps/api/auth/routes.ts` |
| `Secure`   | when the deployment is not loopback HTTP                                      | `config.secureCookies`    |
| `SameSite` | `Lax` (required: the OIDC redirect back is a cross-site top-level navigation) | `routes.ts`               |
| `Path`     | `/`                                                                           | `routes.ts`               |
| `Max-Age`  | the configured session TTL                                                    | `routes.ts`               |
| Storage    | server-side row; the database holds only a SHA-256 of the secret              | `apps/api/context.ts`     |
| Rotation   | a **new** session row and secret on every login                               | `routes.ts`               |
| Logout     | revokes the row server-side **and** clears the cookie                         | `routes.ts`               |
| Expiry     | checked on every request (`expiresAt`)                                        | `context.ts`              |

Fixation resistance comes from never promoting a client-supplied identifier: the
session id is a fresh UUID minted at the callback, and the cookie's secret is 256
bits of `randomBytes`. Asserted by `tests/api/auth.test.ts` ("session security").

### CSRF

Threat model first: the session is an ambient `HttpOnly` cookie, so the question
is whether _this application's_ page caused a state-changing request. Two ambient
properties already close the common attack — `SameSite=Lax` means a cross-site
`POST` carries no cookie, and the API only accepts JSON object bodies, which an
HTML form cannot produce — but both are properties rather than checks.

An explicit **Fetch Metadata / Origin check** was added at the transport
(`apps/api/http/csrf.ts`, applied in `createHttpServer` before any route):

- a state-changing request with `Sec-Fetch-Site` must say `same-origin` or `none`
  (`same-site` is refused — a sibling subdomain is a different principal);
- otherwise, a request with `Origin` must name this deployment's origin exactly;
- a request with neither header is a non-browser client with no ambient cookie to
  borrow, and is allowed (this keeps `curl`, agents and MCP usable).

A refusal is a `403 forbidden` produced before authentication runs. A
synchronizer token was considered and rejected for this phase (it needs token
state, SPA injection and a story for the OIDC redirect, to defend a surface the
checks above already close); the design composes with one later if a deployment
needs it. Authentication semantics were not changed: no new cookie, no header the
browser must remember, and `/auth/login` + `/auth/callback` are still `GET`
navigations.

One accepted exception: `GET /auth/logout` revokes the session and is a top-level
navigation, which `SameSite=Lax` carries the cookie for, so another site can
force a sign-out. That is a nuisance rather than a compromise — no data is
exposed and the user simply signs in again — and the route stays a link because
RP-initiated logout must be a navigation.

### Server workspace paths and symlinks

Three ordered defences (`src/persistence/fs-project-storage.ts`):
`normalizeResourcePath` rejects absolute paths, `.`/`..` segments, backslashes,
control characters, drive prefixes and encoded variants before any filesystem
call; every path is then `realpath`-resolved and checked against the project's
canonical root, so a symlink pointing out of the directory is refused even when
its text was legal (the parent is created and re-checked before a write); project
directories are created `0700`. A project's storage root is never derived from a
request — the catalog asks a factory for the store of a project it has already
authorized.

### Revision conflicts

The conditional update is the authority, not a read-then-write check: a stale
writer changes nothing. `move` additionally refuses a stale caller _before_
touching the volume and compensates if the row update is refused. The browser
never overwrites silently (see Phase 4A), and no client is allowed to invent a
revision.

### Project isolation

Verified by `tests/api/project-isolation.test.ts` (mission item 21): two users,
each owning a project, exercised **both** through the HTTP route table and
directly against the catalog and the raw policy. A non-member cannot list, read,
update, move or delete the other's resource, cannot create inside the project, and
cannot escalate by adding themselves as a member; a `VIEWER` can read but every
mutation is `403`; an unauthenticated request is `401` with
`WWW-Authenticate`. Cross-project resource-id substitution is closed because every
resource query is scoped by `project_id`. The boundary holds at exactly one place
— `policy.requirePermission` inside each use case — so no transport can opt out.

One deliberate disclosure choice: a project the caller cannot see is `404`, not
`403`, so the API is not an existence oracle for other people's project ids. A
`VIEWER`'s refused write _is_ `403`, because they can already see the project.

---

## Verification

```
npm test            # unit + API + persistence: every suite, including the new
                    # adapter, isolation, atomicity, audit and hook tests
npm run test:mcp    # the stdio MCP server still passes over real stdio
npm run test:e2e    # build:web + api:build + a loopback OIDC provider, the real
                    # API, and the authenticated browser scenarios
npm run typecheck
npm run lint
npm run format:check
npm run build
```

All green at the Phase 4 checkpoint. The only two checks that need a browser and a
process (E2E, MCP smoke) run locally; nothing reaches the network.

## Known limitations (carried deliberately into Phase 5)

- A `move` whose database step throws outright can strand a file at the new path;
  compensation covers a _refused_ row move, not a lost connection. Phase 6
  (outbox/compensation).
- Audit rows are not transactional with the mutation; a failed audit write is
  reported and swallowed. Phase 6 (transactional outbox).
- Local and server `updateResource` entry points are still separate
  implementations behind one contract; Phase 6 owns the convergence.
- Server projects have no in-browser import/export of a whole project archive
  (local mode does); not required by this phase.
- Two browser clients editing the same document resolve a `409` by choosing
  reload or overwrite — there is no three-way merge editor yet (explicitly
  deferred by the mission).
- The browser adapter lists a project's resources and then reads each one's text,
  which is one request per document. Correct, and fine for the project sizes this
  phase targets; a bulk read endpoint is the obvious optimisation when a project
  grows large.
