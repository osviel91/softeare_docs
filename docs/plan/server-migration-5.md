# Server Migration — Phase 5 (Agent Identities & Access Credentials)

Phase 4 finished the authenticated browser → server-project workflow. Phase 5
introduces credentials for agents and automation, so that a user can let a
machine act on their behalf without handing over their session.

The central design principle is that a token is **not** `token → user`:

```
User
 ├── Browser session
 │
 ├── Agent: Hermes Documentation
 │     ├── Credential A   (MacMini, 90 days, projects: OSIRIS)
 │     └── Credential B   (CI, no expiry, all projects)
 │
 └── Agent: OpenCode
       └── Credential C
```

That shape is what makes audit attribution, per-machine rotation, independent
revocation, project restrictions and a future OAuth client all expressible in
the same model.

> **A credential is a machine credential, not a browser session credential.**
> It acts _as the user_ (subject) through a named _agent_ (actor), and it can
> only ever _narrow_ what that user may do.

## Checkpoints

| Checkpoint | Delivered                                                                               | Commit    |
| ---------- | --------------------------------------------------------------------------------------- | --------- |
| A          | Domain model, scope vocabulary, Principal normalization, migration 0002, repositories   | this tree |
| B          | Agent/credential application service, audit attribution, rotation, disable              | this tree |
| C          | Credential authentication, converged API bearer auth, agents API, remote MCP re-pointed | this tree |
| D          | Agents & access-token screen, ADR-045, tests and E2E                                    | this tree |

---

## 1. Domain model

`src/domain/agent/agent.ts`:

```ts
interface AgentIdentity {
  id: AgentId;
  ownerUserId: UserId; // the subject; an agent never owns anything
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null; // the agent-level kill switch
}

interface AgentCredential {
  id: CredentialId;
  agentId: AgentId;
  name: string;
  publicPrefix: string; // non-secret lookup key
  secretHash: string; // HMAC-SHA-256(pepper, full token)
  scopes: CredentialScope[];
  allowedProjectIds: ProjectId[] | null; // null = the owner's whole membership
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}
```

An agent is **not a user**: it owns no projects and holds no membership. Every
authorization decision resolves the owner's live membership, so when the owner
loses access the agent loses it in the same instant, with nothing to
synchronize.

## 2. Principal normalization

`src/application/context.ts`:

```ts
type Actor =
  | { kind: "user"; userId: UserId }
  | { kind: "agent"; agentId: AgentId; credentialId: CredentialId };

interface Principal {
  subjectUserId: UserId; // whose authority bounds the request
  actor: Actor; // who is actually asking
  authType: "session" | "oauth" | "pat" | "local";
  scopes: readonly Scope[]; // expanded permissions, never raw scopes
  allowedProjectIds?: ProjectId[];
}
```

| Caller           | subjectUserId      | actor                                   | authType  |
| ---------------- | ------------------ | --------------------------------------- | --------- |
| Browser session  | the signed-in user | `{kind:"user", userId}`                 | `session` |
| Agent credential | the agent's owner  | `{kind:"agent", agentId, credentialId}` | `pat`     |
| Local mode       | `"local"`          | `{kind:"user", userId:"local"}`         | `local`   |

Both mechanisms converge on this one value, so no use case can tell them apart —
except for audit, which is exactly where the distinction must survive.

## 3. Storage

Migration `0002-agent-credentials` (the initial `personal_access_tokens` table is
dropped by it, because its structure has no place for an agent and it holds only
a hash that cannot be reparented):

```
agent_identities           id, owner_user_id, name, description, created_at, updated_at, disabled_at
agent_credentials          id, agent_id, name, token_prefix, token_hash, scopes[], created_at,
                           expires_at, last_used_at, revoked_at
agent_credential_projects  credential_id, project_id
audit_events               + actor_type, actor_id, credential_id
```

Project restrictions are a join table on purpose: they are read into
`allowedProjectIds` by the same query that loads a credential, so no code path
can load a credential and forget its restriction.

## 4. Token format and hash at rest

```
sdm_pat_<publicPrefix>.<secret>
         16 hex = 64 bits      43 base64url = 256 bits CSPRNG
```

- The prefix is public, unique by constraint and indexed: authentication is one
  row lookup, never a scan of every hash.
- The secret is 256 bits from `crypto.randomBytes`, never `Math.random`, a
  timestamp or a bare UUID.
- The stored value is `HMAC-SHA-256(TOKEN_PEPPER, full token)`; `TOKEN_PEPPER`
  defaults to `COOKIE_SECRET`. A stolen database alone cannot test a guessed
  token, and because the secret is uniform randomness a slow password hash would
  buy nothing.
- Verification reuses `apps/api/auth/secret-compare.ts` (`timingSafeEqual`) —
  there is no second comparison implementation.
- The plaintext is never a column, never logged, never in an audit row, and is
  returned exactly once, from credential creation or rotation.

A `.` separates the halves rather than the `_` the mission sketches because a
base64url secret itself contains `_`, which would make the split ambiguous.

## 5. Scope vocabulary

A use case requires a fine-grained `Permission`; a credential is granted a
`CredentialScope`, which is a permission or the `resource:write` shorthand:

```
project:read  project:create  project:update  project:delete  project:members:write
resource:read resource:create resource:update resource:move resource:delete
diagram:render project:search project:validate project:export
agent:manage credential:manage user:manage
+ resource:write  → { resource:create, resource:update, resource:move, resource:delete }
```

The default profile for a new credential is deliberately conservative:

```
project:read, resource:read, diagram:render, project:search, project:validate
```

`project:delete`, `project:members:write`, `agent:manage`, `credential:manage`
and `user:manage` are administrative; they are never in the default profile and
the credential screen does not offer them.

## 6. Authorization composition

```
Effective = owner's project role  ∩  credential scopes  ∩  credential restrictions
```

```
requirePermission(context, projectId, permission)
  1. credentialAllowsProject?          restricted away → not_found (invisible)
  2. credentialGrants?                 scope missing   → forbidden
  3. roleOf(projectId, subjectUserId)  non-member      → not_found
  4. authorize(role, permission)       too weak        → forbidden
```

A credential can never increase the owner's authority: an OWNER with a read-only
credential cannot write, and a VIEWER with `resource:write` is still refused
because the role is checked too. Restrictions only ever remove access.

## 7. Authentication convergence

`apps/api/auth/api-auth.ts` decides which mechanism identifies a request:

- `Authorization: Bearer …` present → the credential authenticates it;
- otherwise → the session cookie does;
- **the header wins** when both are present, and the two are never merged, so a
  request can never be authorized by the union of two credentials.

Malformed, unknown, revoked, expired and disabled-agent credentials all answer
`401` with `WWW-Authenticate`; an authenticated caller refused an operation gets
`403`. Management endpoints (`/api/agents…`) are session-only and additionally
require `agent:manage`/`credential:manage`, so a credential cannot mint or revoke
credentials.

## 8. Rotation, revocation, expiry, disable

- **Revocation** sets `revoked_at`; verification reads the row on every request,
  so the next request is `401`. No cache, no grace period, idempotent.
- **Rotation** is create-new-then-revoke-old. Rotating an already-revoked
  credential is refused, so a double rotate cannot mint two live secrets. The
  step is not atomic because a credential is a row and there is no transaction
  across "mint" and "revoke": if the revoke fails the new credential is already
  live and the old one still revocable — two live credentials for a moment,
  never zero. Documented, not hidden.
- **Expiry** is checked on every verification; creation refuses a past instant.
- **Disabling an agent** invalidates every one of its credentials immediately and
  restoring it re-enables them, without touching each credential.
- **`lastUsedAt`** is updated best-effort; a failure to record use never fails an
  otherwise-authorized request. It is metadata, not authorization state.

## 9. Audit attribution

`audit_events` records `subject_user_id`, `actor_type`, `actor_id`,
`credential_id` and `auth_type`, so the trail can say:

```
resource.updated
  subject:    Osvi
  actor:      Hermes Documentation (agent)
  credential: MacMini
  auth:       PAT
```

A session write records the user as both subject and actor; a credential write
records the owner as subject and the agent as actor. Token values and prefixes
are never written.

## 10. Management API and UI

```
GET    /api/agents                                     list agents + counts
POST   /api/agents                                     create an agent
PATCH  /api/agents/:agentId                            rename / re-describe
DELETE /api/agents/:agentId                            disable
POST   /api/agents/:agentId/enable                     re-enable
GET    /api/agents/:agentId/credentials                metadata + status
POST   /api/agents/:agentId/credentials                create (secret once)
POST   /api/agents/:agentId/credentials/:id/rotate     rotate (secret once)
DELETE /api/agents/:agentId/credentials/:id            revoke
```

The Tokens screen becomes **Agents & access tokens**: create an agent, expand it,
create a credential with a scope set, expiry and optional project restriction,
copy the one-time secret, rotate or revoke. The plaintext lives in one component
state variable and is never written to `localStorage`, `sessionStorage`, a URL or
module state. The same page carries the remote MCP connection example with a
literal `<YOUR_PAT>` placeholder.

## 11. Threat model

| Threat                                           | Mitigation                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Stolen credential                                | optional expiry, instant revoke, per-credential revoke, agent-wide disable, scopes bound the blast radius, `last_used_at` shows use |
| Database compromise                              | only `HMAC-SHA-256(pepper, token)` is stored; the pepper is not in the database                                                     |
| Replay                                           | bearer by design; TLS in transit, expiry, revocation and precise scopes limit it; it is never read from a cookie                    |
| Expired / revoked / disabled                     | all checked on every verification and answered identically                                                                          |
| Scope escalation                                 | closed vocabulary, read-only default, admin scopes unoffered, management requires a session plus `agent:manage`/`credential:manage` |
| Cross-user project-id / resource-id substitution | the policy resolves the role from membership; non-members get `not_found`; resource queries are scoped by `project_id`              |
| Malformed / traversing paths                     | `normalizeResourcePath` plus realpath/canonical-root checks; refusal surfaces as `invalid_path`                                     |
| Token leakage in errors/logs                     | unexpected failures become `internal` + correlation id; a test asserts stderr during a failed verification contains no token        |
| Brute-force lookup                               | the prefix is only a lookup key; the secret is 256 bits compared in constant time                                                   |
| Resource abuse                                   | 2 MiB HTTP / 1 MiB MCP body caps; per-credential rate limiting remains a deployment concern                                         |

## 12. Client configuration

```json
{
  "mcpServers": {
    "sequencediagrams": {
      "type": "http",
      "url": "https://your-server/mcp",
      "headers": { "Authorization": "Bearer <YOUR_PAT>" }
    }
  }
}
```

## 13. Verification

```
npm test            # unit + API + persistence, incl. agent-management, agent-authorization
                    # and remote-MCP suites
npm run test:mcp    # the stdio MCP server over real stdio
npm run test:e2e    # Chromium, a loopback OIDC provider and the real API, incl.:
                    # login → create agent → read-only credential → the credential
                    # authenticates, reads, is refused a write, is revoked and
                    # immediately returns 401
npm run typecheck && npm run lint && npm run format:check && npm run build
```

## 14. Known limitations

- **Rotation is not atomic** (see §8); the failure direction is fail-open for a
  moment and toward the owner only.
- **No per-credential rate limiting**; body/tool limits and scopes bound abuse.
- **A credential is not restricted by IP or user-agent**, and there is no
  credential use history beyond `last_used_at`.
- **The browser-adapter conflict path is unchanged**; a check-then-write window
  remains in `DocumentationWorkspace.saveContent` (Phase 6 convergence).
- **Remote MCP is re-pointed at agent credentials but gains no new features**;
  the mission defers MCP transport work to Phase 6.
- **OAuth is a type, not an implementation**: `authType: "oauth"` and the `actor`
  model are ready for it, but no OAuth client exists yet.
- **Audit is not transactional with the mutation** (Phase 4 outbox work).
