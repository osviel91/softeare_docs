# Server Migration — Phase 6 (Production MCP Service & Mutation Reliability)

Phase 5 gave agents credentials. Phase 6 turns the remote MCP from a route on
the API into a **production-grade, independently deployable, authenticated HTTPS
MCP service**, converges the two server hosts onto one application layer, and
closes the two storage-reliability holes Phase 5 documented rather than hid.

```
                      INTERNET
                         │
                       HTTPS
                         │
                  Reverse Proxy
                  /      |      \
                 ▼       ▼       ▼
              Web      API      MCP
             nginx     Node     Node
                │        │        │
                │        └───┬────┘
                │            ▼
                │     Application Layer
                │            │
                │            ▼
                │     PostgreSQL + Project volume
                ▼
             Browser client
```

> **The MCP is a host, not a route.** It has its own image, port, hostname,
> configuration, rate limits and failure domain. It shares _code_ with the API,
> never an HTTP call.

## Checkpoints

| Checkpoint | Delivered                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| A          | Shared authentication (`src/persistence/agent-authentication.ts`) with a PAT verifier chain           |
| B          | Migration 0003, the operation journal, staging, recovery, move compensation, idempotency              |
| C          | One mutation path for the catalog, the MCP tools and the documentation provider                       |
| D          | `apps/mcp`: config, auth edge, SDK Streamable HTTP transport, tools, resources, limits, observability |
| E          | `Dockerfile.mcp`, `compose.production.yml`, reverse proxy, secrets, ADRs 046–048                      |
| F          | Integration, hardening, stateless, concurrency, retry and container suites                            |

---

## 1. Deployment boundary

```
apps/
  web/        (the Vite bundle, served by nginx)
  api/        (the session + bearer HTTP API)
  mcp/        (the remote MCP service)
```

| Image                  | Contains                                      | Does not contain                   |
| ---------------------- | --------------------------------------------- | ---------------------------------- |
| `sequencediagrams-web` | nginx + the static bundle                     | Node, MCP runtime, database driver |
| `sequencediagrams-api` | the API bundle + `pg`                         | frontend, MCP runtime              |
| `sequencediagrams-mcp` | the MCP bundle + `pg`, non-root, read-only FS | frontend, nginx, PGlite            |

Both Node images run as `node`, mount the project volume only, and ship no
Docker socket and no host path. The MCP image's healthcheck is a `/health` probe
that touches no dependency.

## 2. Transport

The MCP endpoint is the official `@modelcontextprotocol/sdk` Streamable HTTP
transport, in **stateless JSON mode**:

```ts
new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // no session, ever
  enableJsonResponse: true, // one JSON body per POST
});
```

Per request: authenticate → validate headers → rate limit → build a fresh
`McpServer` → connect a fresh transport → handle → close both. Nothing is
remembered between requests, so request 1 may land on instance A and request 2
on instance B.

| Method   | Answer                                               |
| -------- | ---------------------------------------------------- |
| `POST`   | the MCP message                                      |
| `GET`    | `405` (no server-initiated stream in stateless mode) |
| `DELETE` | `204` (no session to terminate)                      |

### Protocol version

The installed SDK implements `2025-11-25` as its newest revision and validates
`MCP-Protocol-Version` itself, so this server does not duplicate that check. It
does **not** know `Mcp-Method` / `Mcp-Name`; `apps/mcp/mcp/headers.ts` validates
those, and a header that disagrees with the body is a `400` that fails closed. A
request that omits them is accepted, because every current client predates the
header profile.

`2026-07-28` is not implemented by the installed SDK. Asking for it is refused
by that SDK's own protocol-version check rather than silently accepted.

## 3. Authentication and authorization

```
Authorization: Bearer sdm_pat_…
      ↓
authenticateBearerToken(verifiers, token)     // shared with the API
      ↓
Principal                                     // the API's exact shape
      ↓
MCP dispatch → application use case → policy
```

`verifyMcpPat()` does not exist. The MCP edge calls the same
`createPatBearerVerifier` the API edge calls, and the chain is already shaped for
Phase 7 to append an OAuth verifier:

```ts
const verifiers = [patVerifier, ...extraVerifiers];
```

A session cookie is never consulted, and a request with only a cookie is a
`401`. The reverse proxy also strips `Cookie` on the MCP route.

### Status vocabulary

| Situation                                | Answer                             |
| ---------------------------------------- | ---------------------------------- |
| no credential                            | `401` + `WWW-Authenticate`         |
| malformed / revoked / expired / disabled | `401`                              |
| valid credential, missing scope or role  | `403` (or a disabled-tool refusal) |
| unknown or invisible project             | `404`                              |

`apps/mcp/auth/challenge.ts` is the single construction point for
`WWW-Authenticate`; it already names the canonical resource URL from
configuration, which is the value Phase 7 will publish as the protected
resource. It is never derived from a `Host` header.

## 4. Tools and resources

Three levels, 20 tools:

- **Discovery** — `list_projects`, `get_project`, `get_project_index`,
  `list_resources`, `get_resource_metadata`, `search_project`
- **Primitive resources** — `read_resource`, `create_resource`,
  `update_resource`, `move_resource`, `delete_resource`
- **Semantic** — `read_diagram`, `upsert_sequence_diagram`, `upsert_event_flow`,
  `render_diagram`, `read_documentation`, `upsert_documentation`,
  `get_event_catalog`, `find_event_producers`, `find_event_consumers`,
  `validate_project`

Every list-like tool supports `limit` + `cursor` and returns a bounded page.
Search returns `{resourceId, path, line, column, snippet}` and never whole files.
Every mutating tool accepts an `idempotencyKey`.

Tool filtering by credential scope decides what `tools/list` advertises; the
tool is still _registered_ and refused at call time, so a call by name is a
refusal rather than "unknown tool".

Resources are exposed under `seqdocs://projects/<id>` and
`seqdocs://projects/<id>/resources/<resourceId>`, and a resource read goes
through the same authorized catalog use case a tool does.

## 5. Mutation reliability

Phase 5's known limitations:

```
saveContent check → race window → write
a move whose DB step throws can strand the file
mutation succeeds → audit fails (non-transactional)
```

Phase 6 replaces both write sequences with one path:

```
1. authorize
2. stage the new bytes at .sdd-staging/<operationId>   (filesystem)
3. claim: ONE transaction commits
     - the resource row change (insert / revision bump / path / delete)
     - a durable workspace_operations record
     - the business audit row
     - the idempotency record
4. promote the staged bytes onto the resource          (atomic rename)
5. finalize the operation
```

The partial unique index `workspace_operations_active_unique` permits one
unfinished operation per resource. That is the cross-process mutex for the
filesystem half: a second writer's claim fails _before_ it touches a file, so two
writers can never reorder each other's bytes. This is what closes the
check→write window.

Recovery at boot drives every unfinished operation to completion or to a
deterministic failure:

| Operation       | Recovered by                                          |
| --------------- | ----------------------------------------------------- |
| create / update | promote the staged file, or verify the target's hash  |
| move            | rename source → target, or accept the completed state |
| delete          | remove the file the row no longer points at           |

A failed move restores the old path, so the document is never an orphan invisible
to both the database and a reader.

`resources.revision` is a **claim counter**, not a content version: a failed
operation consumes a revision rather than reusing a number, which is what keeps a
stale writer from ever being able to claim it.

### Idempotency

```sql
idempotency_records (actor_id, project_id, idempotency_key, operation, status, result)
```

`actor + project + key` identifies one logical mutation. A completed replay
returns the stored result; an in-flight duplicate is a retryable `409`.
Retention is a `purge(before)` sweep on the journal repository.

## 6. Limits, rate limiting, observability

| Concern       | Where                                                          |
| ------------- | -------------------------------------------------------------- |
| Body size     | `MCP_MAX_BODY_BYTES` (default 1 MiB) → `413`                   |
| Resource size | `MCP_MAX_SEQ_BYTES` / `_EVENTSEQ_` / `_MARKDOWN_`              |
| Rate limits   | per credential, per class (read/search/render/write/delete)    |
| Tool deadline | `MCP_TOOL_TIMEOUT_MS`, combined with the client's abort signal |

The rate limiter is process-local and documented as such: N instances give N
times the budget. `RateLimiter` is an interface so a scaled deployment can inject
shared state without touching the transport.

Structured logs are JSON lines with `requestId` and `traceId`; `Authorization`,
`Cookie`, `token`, `secret` and document bodies are never written. Metrics are
Prometheus text at `/metrics`, with labels restricted to a closed vocabulary —
never `projectId`, `resourceId` or `userId`.

`/health` is liveness only; `/ready` checks PostgreSQL and the project volume;
neither discloses more than "usable" or not.

## 7. Verification

```bash
npm test           # 121 files, 1801 tests
npm run test:mcp   # stdio smoke + 35 MCP service tests
npm run test:e2e   # browser ↔ API ↔ MCP, over one shared runtime
npm run test:containers   # the production composition, real images
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## 8. Known limitations

- **`2026-07-28` is not implemented.** The installed SDK's newest revision is
  `2025-11-25`; the per-request `_meta` protocol negotiation and
  `server/discover` of the 2026 profile are not available from it. The header
  contract (`Mcp-Method`, `Mcp-Name`) is implemented and validated here.
- **The rate limiter is process-local.** Correct for one MCP instance; a
  horizontally scaled deployment should inject a shared implementation.
- **A crash between the claim commit and the promote** briefly exposes the new
  revision with the old bytes. Recovery repairs it on the next boot; the window
  is not zero.
- **`TOKEN_PEPPER` rotation** requires re-issuing credentials. The architecture
  accepts a verifier chain, so a multi-pepper verifier is a drop-in, but Phase 6
  does not implement one.
- **The E2E runs both server hosts in one process** over a shared runtime, so it
  can use PGlite. The container integration suite is the multi-process proof.
- **OAuth / OIDC is not implemented.** Phase 7 owns discovery, protected-resource
  metadata and the access-token verifier.
