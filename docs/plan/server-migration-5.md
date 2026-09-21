# Server Migration — Phase 5 (Personal Access Tokens + Remote MCP)

Phase 4 finished the authenticated browser → server-project workflow. Phase 5
opens the _same_ projects to external agents and tools without weakening the
browser security model: a user mints a revocable **Personal Access Token**, an
MCP client presents it as a bearer credential, and every read and write runs
through the application use cases the browser already calls.

Two sentences carry the whole design:

> **A PAT is a machine credential, not a browser session credential.**
> **Remote MCP is a second adapter over the shared application layer, not a
> second implementation of it.**

```
Browser UI ──cookie/session──┐
HTTP API   ──cookie/session──┤
Local MCP  ──local principal─┼──►  Application use cases  ──►  Authorization policy
Remote MCP ──Bearer PAT──────┘     (project-catalog, …)        (roles × scopes)
```

## Goal

- Allow external AI agents to read and write a user's server-hosted projects
  through a remote MCP endpoint.
- Authenticate that endpoint exclusively with user-owned, revocable PATs.
- Keep the browser's OIDC/session authentication exactly as it was.
- Never expose a PAT to browser JavaScript, a URL, a log line or a tool error.
- Preserve project isolation, role enforcement and optimistic concurrency end to
  end, including across transports.

## Checkpoints

| Checkpoint | Delivered                                                                 | Commit    |
| ---------- | ------------------------------------------------------------------------- | --------- |
| 5A         | PAT scope model, storage, lifecycle service and `/api/tokens` routes      | `0335271` |
| 5B         | Bearer verification, shared principal, scope × role composition and tests | `204f385` |
| 5C/5D      | Remote MCP Streamable HTTP transport, read and write tools, error model   | `204f385` |
| 5E         | PAT screen, remote-MCP connection guide, real remote-MCP E2E              | `fdcfa7b` |

---

## 1. The PAT model

### Token format

```
sdm_pat_<prefix>.<secret>
```

| Part     | Size                                    | Secret? | Purpose                                           |
| -------- | --------------------------------------- | ------- | ------------------------------------------------- |
| `prefix` | 16 hex chars (64 bits)                  | no      | indexed lookup key, unique by database constraint |
| `secret` | 43 base64url chars (256 bits of CSPRNG) | yes     | the credential                                    |

The `sdm_pat_` literal makes a leaked token recognisable in a log or a paste.
The two halves are generated independently so the public lookup key is not
derived from anything about the secret.

### Storage

The schema ships with the initial migration (`personal_access_tokens`), and the
repository lives in `src/persistence/personal-access-token-repository.ts`.

```
id            uuid    primary key      stable token id (audit, rename, revoke)
user_id       uuid    → users          the owner; a PAT is never shared
name          text                     display name
prefix        text    unique           the public half, the lookup key
token_hash    text                     SHA-256 of the *full* token
scopes        text[]                   coarse scopes (projects:read/write)
project_ids   uuid[]  null             optional restriction, null = whole membership
created_at    timestamptz
expires_at    timestamptz null
last_used_at  timestamptz null
revoked_at    timestamptz null
```

**The plaintext is never a column and never written by any code path.** It exists
in exactly one place: the `secret` field of the `201` response to
`POST /api/tokens`, from where the screen shows it once and discards it.

A single SHA-256 is deliberate and is _not_ a password hash. The secret is 256
bits of uniform randomness that only this server ever generates, so there is no
dictionary to try and no work factor to buy; the digest exists so that a leaked
database cannot be replayed as a credential. This mirrors the session design
(`apps/api/context.ts`).

### Lifecycle

```
create   POST   /api/tokens          → 201 { secret, token: {metadata} }
list     GET    /api/tokens          → 200 { tokens: [metadata], scopes }
read     GET    /api/tokens/:id      → 200 { token: metadata }
rename   PATCH  /api/tokens/:id      → 200 { token: metadata }
revoke   DELETE /api/tokens/:id      → 204
```

- **Metadata only, ever.** `tokenView` has no field a secret or a digest could
  occupy, and a test asserts the list and read responses do not contain the
  plaintext.
- **Ownership is a predicate, not a check.** Every per-token repository method
  takes the caller's user id in its `WHERE` clause, so one user cannot read,
  rename or revoke another's token even if a controller forgot to ask. A foreign
  id answers `404`, not `403`, so the API is not an existence oracle.
- **Management requires a browser session.** The lifecycle service refuses any
  principal whose `authType` is not `session`, so a leaked PAT cannot mint a
  replacement for itself or quietly erase the evidence. A token cannot reach
  these routes at all: they are cookie-authenticated, and a bearer header is not
  consulted.
- **CSRF is unchanged.** Create/rename/revoke are `POST`/`PATCH`/`DELETE`, so the
  Phase 4 Fetch Metadata / `Origin` check already covers them.

### Audit

`token.created`, `token.renamed` and `token.revoked` are written through the
existing audit port with `detail: { tokenId, name, scopes }` — never the token,
the prefix or the hash. **Use is not an audit row.** Recording every MCP request
would grow the audit trail without bound and would not match the existing
architecture (session use is a best-effort `last_seen_at` touch, not an audit
event). Use is observable through `last_used_at`, which the verifier updates
best-effort on every successful authentication.

---

## 2. Scope model

Two coarse scopes, named once in `src/domain/access/permissions.ts`:

| Scope            | Expands to (permissions)                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `projects:read`  | `project:read`, `resource:read`, `diagram:render`, `project:validate`, `project:export`, `mcp:read` |
| `projects:write` | everything `projects:read` grants, plus `project:write`, `resource:write`, `mcp:write`              |

`projects:write` is a superset of `projects:read` by construction, so a token can
never be in the contradictory state of "write but not read", and a UI never has
to warn about the combination.

**Neither scope grants `project:admin`.** Membership changes, ownership transfer
and project deletion stay human actions. A write token also cannot create a
project through the remote surface, and `catalog.createProject` now checks the
credential capability directly, so a future transport cannot reintroduce it by
accident.

Expansion drops unknown scope names rather than throwing: a scope written by a
newer server grants nothing here, instead of inventing a permission or refusing
every request from a valid token.

The scope vocabulary is returned by `GET /api/tokens`, so the UI and any client
never hard-code it.

---

## 3. Browser vs machine authentication

|               | Browser                                                   | Machine / remote MCP                                 |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| Credential    | OIDC → server-side session → `HttpOnly` cookie            | `Authorization: Bearer sdm_pat_…`                    |
| Presented     | ambient, automatic                                        | explicit, per request                                |
| Identity      | `users.id` from `(issuer, subject)`                       | `token.user_id`                                      |
| Capabilities  | the whole permission vocabulary, narrowed by project role | the token's scopes, narrowed further by project role |
| Conveyed over | cookie only                                               | header only                                          |
| Management    | may create/revoke PATs                                    | may **not** touch PATs                               |
| Revocation    | logout revokes the session row                            | revoke sets `revoked_at`                             |

The two are separate code paths that converge on one value:

```
resolveSession(sessions, request) → Principal{authType:"session"}
resolvePat(tokens, request)       → Principal{authType:"pat"}
                    ↓
        ApplicationContext{ principal, requestId }
                    ↓
        policy.requirePermission(context, projectId, permission)
```

`requireBearerContext` in `apps/api/auth/pat.ts` **never consults the cookie**,
and `requireContext` in `apps/api/context.ts` **never consults the header**. The
remote endpoint is a machine surface; letting an ambient cookie authenticate it
would turn a same-site `fetch` into an agent call.

### Bearer verification

1. Parse `Authorization` exactly as `Bearer <token>`. Absent → `none`; anything
   else (`Basic`, a bare token, an empty scheme) → `invalid`, so a
   misconfiguration fails loudly instead of half-working.
2. Validate the `sdm_pat_<prefix>.<secret>` shape. A malformed value never
   reaches the database.
3. Look the row up by the indexed `prefix`.
4. Compare `sha256(full token)` to the stored digest with `timingSafeEqual`
   (`constantTimeEquals`). Length inequality is public and returns early.
5. Refuse a revoked or expired row.
6. Update `last_used_at` best-effort.
7. Build the principal: owner identity, scopes expanded to permissions, the
   credential id, and the optional project restriction.

Every failure after step 1 produces the _same_ `invalid` answer, so an attacker
cannot use error shape or timing to learn whether a prefix is real.

---

## 4. Remote MCP transport

The endpoint is `POST /mcp`, speaking the Model Context Protocol over
**Streamable HTTP** in its JSON-response form:

- a single JSON-RPC object or a batch in, a JSON-RPC result out, `Content-Type:
application/json`;
- the server is **stateless**: there is no `Mcp-Session-Id`, no server-initiated
  SSE stream (`GET /mcp` → `405`, `Allow: POST, DELETE`) and no state to leak
  between requests. Each request carries its own PAT and its own protocol
  version;
- `DELETE /mcp` is a `204` no-op (a client's session termination has nothing to
  terminate);
- a notification (no `id`) is acknowledged with `202` and an empty body;
- malformed JSON is `400` with a JSON-RPC parse error;
- `MCP-Protocol-Version`, when sent, is validated against the supported set.

The wire vocabulary lives in `src/shared/mcp/protocol.ts` — moved there in this
phase — so the stdio server (`mcp/`) and the HTTP server (`apps/api/mcp/`) speak
one definition instead of two that can drift. `mcp/protocol.ts` remains a
re-export.

### Tools

Every tool validates arguments, calls a use case on the shared
`ProjectCatalog`, and renders the result. No tool touches the database, the
volume or the filesystem.

| Tool              | Permission gate | Use case                                         |
| ----------------- | --------------- | ------------------------------------------------ |
| `list_projects`   | `mcp:read`      | `catalog.listProjects`                           |
| `get_project`     | `mcp:read`      | `catalog.getProject` + `describeAccess`          |
| `list_resources`  | `mcp:read`      | `catalog.listResources`                          |
| `read_resource`   | `mcp:read`      | `catalog.readResource`                           |
| `create_resource` | `mcp:write`     | `catalog.createResource`                         |
| `update_resource` | `mcp:write`     | `catalog.updateResource` (**required revision**) |
| `move_resource`   | `mcp:write`     | `catalog.moveResource` (**required revision**)   |
| `delete_resource` | `mcp:write`     | `catalog.deleteResource` (requires `confirm`)    |

`tools/list` is filtered to the tools the credential's scopes can call, and the
same gate is re-checked when a tool is called. The listing is a courtesy; the
call-time check is the boundary.

The stdio server keeps its richer documentation tool set over a filesystem
workspace. The two share the protocol and the application services; they differ
only in the store and the credential, which is the point.

---

## 5. Authorization flow

One decision function, reached identically from every transport:

```
requirePermission(context, projectId, permission)
  1. credentialAllowsProject?   project-restricted token → not_found (invisible)
  2. credentialGrants?          scope missing           → forbidden
  3. roleOf(projectId, userId)  not a member            → not_found
  4. authorize(role, permission) role too weak          → forbidden
```

The order is a security decision. The _credential_ is checked before membership,
so a token that was never granted a capability cannot probe which projects
exist, and a project-restricted token addresses another project exactly as one
that does not exist. `not_found` and `restricted` answer identically.

Two grants must line up for anything to happen: the credential carries the
capability, and the role carries it too. A read-only token owned by an OWNER is
refused a write; a write token owned by a VIEWER is refused a write. Both are
`403`, for the same reason a viewer's refusal is: the caller can already see the
project.

`createServerWorkspaceProvider` is the second door into a project; it asks the
same policy once (`catalog.can(..., "resource:write")`) and hands out a
genuinely read-only repository when the answer is no, so a write cannot slip
past authorization by arriving through a different service.

---

## 6. Error model

Every failure maps through `apps/api/mcp/errors.ts` onto a closed vocabulary,
carried both as text and as `structuredContent.error`:

| MCP code       | Source                                                      |
| -------------- | ----------------------------------------------------------- |
| `forbidden`    | scope missing, role too weak, credential-management refusal |
| `not_found`    | unknown/foreign/restricted project or resource              |
| `conflict`     | stale `expectedRevision`, occupied path                     |
| `invalid_path` | a refused resource path (`details.kind = "invalid_path"`)   |
| `validation`   | any other well-formed-but-invalid request                   |
| `unavailable`  | a dependency the server knows is down                       |
| `internal`     | anything unexpected                                         |

`unauthenticated` is not produced by the tool layer: a bad or missing PAT is a
`401` with `WWW-Authenticate` from the transport, before a tool runs.

A non-`ApplicationError` never exposes its message. It becomes `internal` with
the request's correlation id; the detail goes to the server log. The same rule
protects stack traces, database errors and filesystem paths from reaching the
model. The existing `401`/`403`/`404` isolation semantics are unchanged, and a
foreign project or resource is always `not_found`.

## 7. Conflict semantics

Optimistic concurrency is a property of the application contract, not of a
transport:

- every resource read returns a `revision`;
- `update_resource` and `move_resource` require `expectedRevision`; the catalog's
  conditional `UPDATE` is the authority and a stale writer changes nothing;
- a stale write returns `conflict` with `{ expectedRevision, currentRevision }`,
  which the agent is instructed to act on by re-reading and retrying;
- there is **no MCP-specific last-write-wins path**: the tool refuses to send a
  write that did not name a revision, and the catalog refuses one that names the
  wrong one.

A revision is opaque monotonic concurrency state: send the one you read, never
compute one, and never assume `revision + 1` is "number of writes".

## 8. Revocation

Revoking sets `revoked_at`; the very next request that presents the token is
`401`, because verification reads the row on every request. There is no cache,
no signed blob and no grace period. Revocation is idempotent and available only
to the owner, from the browser session. A test and the E2E both prove that the
same credential that worked a moment earlier is rejected immediately after the
revoke.

---

## 9. Threat model

| Threat                                 | Mitigation                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stolen PAT**                         | short optional expiry; instant revoke; `last_used_at` shows use; scopes bound the blast radius; the token cannot manage tokens; `sdm_pat_` prefix makes it recognisable for secret scanning                                                                                  |
| **Database compromise**                | only `sha256(full token)` is stored; the dump cannot be replayed. Prefixes are public and useless without the 256-bit secret                                                                                                                                                 |
| **Bearer-token logging**               | the token is never logged, never in an audit row, never in a URL, never in stored config; a test asserts stderr during a failed verification does not contain it                                                                                                             |
| **Replay**                             | a bearer token is replayable by design; mitigation is TLS in transit, short expiry, revocation and the fact that the credential is read-only or write-scoped rather than ambient; it is never accepted from a cookie, so a cross-site page cannot make the browser replay it |
| **Expired token**                      | `expires_at` checked on every verification; expiry must be in the future at creation                                                                                                                                                                                         |
| **Revoked token**                      | `revoked_at` checked on every verification; immediate                                                                                                                                                                                                                        |
| **Scope escalation**                   | scopes expand to a closed permission set; `project:admin` is unreachable; `tools/list` is filtered and the gate is re-checked at call time; PAT routes reject non-session principals                                                                                         |
| **Cross-user project-id substitution** | the policy resolves the role from membership; a non-member gets `not_found`, never a `403` that would confirm existence                                                                                                                                                      |
| **Resource-id substitution**           | every resource query is scoped by `project_id`; a resource id from another project resolves to `not_found`                                                                                                                                                                   |
| **Malformed paths / traversal**        | `normalizeResourcePath` rejects absolute paths, `..`/`.`, backslashes, control characters and drive prefixes before any filesystem call; `realpath` + canonical-root checks follow; a refusal surfaces as `invalid_path`                                                     |
| **Symlink escape**                     | unchanged from Phase 4: realpath resolution against the project's canonical root                                                                                                                                                                                             |
| **Token leakage through MCP errors**   | unexpected failures are `internal` with a correlation id only; no stack, path or database message is echoed                                                                                                                                                                  |
| **Brute-force lookup**                 | the prefix is only a lookup key; the secret is 256 bits and compared against a digest in constant time, so guessing is infeasible and timing reveals nothing                                                                                                                 |
| **Rate / resource abuse**              | request bodies are bounded (2 MiB HTTP, 1 MiB MCP), tool results are bounded by the document sizes the API accepts, and the transport refuses oversized bodies with `413`; per-token rate limiting is a deployment concern (see limitations)                                 |
| **CSRF against the token endpoints**   | unchanged Fetch Metadata / `Origin` check; token mutations are non-`GET`; a machine client sends neither header and carries no ambient cookie                                                                                                                                |

### What is deliberately not weakened

Canonical-root/realpath protection, project isolation, role enforcement, revision
checks, CSRF, session cookie flags and the OIDC flow are all untouched. PATs add
a second, narrower credential; they do not widen the first.

---

## 10. Client configuration

The Tokens screen shows this, with the real origin and a literal placeholder —
never the user's token:

```json
{
  "mcpServers": {
    "sequencediagrams": {
      "type": "http",
      "url": "https://your-server/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_PAT>"
      }
    }
  }
}
```

The endpoint is same-origin with the app (`/mcp`). A client that needs the
protocol handshake may send `initialize` (legacy) or `server/discover` (modern);
both are answered. The server is stateless, so no session header is required on
subsequent requests.

---

## 11. Verification

```
npm test            # unit + API + persistence, including the PAT, PAT-authorization
                    # and remote-MCP suites
npm run test:mcp    # the stdio MCP server still passes over real stdio
npm run test:e2e    # build:web + api:build + a loopback OIDC provider, the real
                    # API and Chromium, including server scenario 6: create a PAT,
                    # drive /mcp as a machine client, observe the write in the
                    # browser, revoke, and watch the credential be rejected
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## 12. Known limitations (carried to Phase 6)

- **A check-then-write window remains in the shared documentation service's
  `updateResource`.** The remote MCP path goes through `catalog.updateResource`,
  whose conditional `UPDATE` is a true compare-and-swap, but
  `DocumentationWorkspace.saveContent` checks the revision and then writes, and a
  writer landing between those two steps could still be overwritten. Closing it
  means threading the expected revision into `saveDiagramFile`/`saveNoteFile`,
  which is the Phase 6 `updateResource` convergence.
- **No per-token rate limiting.** Abuse is bounded by body/tool limits and the
  scope model, not by a rate limiter; a deployment that needs one should put it
  in front of `/mcp`.
- **Project restriction is API-only.** The API and the principal support a
  `projectIds` restriction and it is tested, but the token screen does not yet
  offer a picker for it.
- **Audit is not transactional with the mutation** (Phase 4's outbox work), and
  token use is tracked by `last_used_at` rather than an audit row, by design.
- **Remote MCP exposes the resource/project tools, not the stdio server's
  documentation analytics** (outline, search, render, audit). Those remain
  available over the local stdio server; converging them on the server-side
  workspace service is a follow-up.
- **The `move`/rename compensation gap** documented in Phase 4 is unchanged.
