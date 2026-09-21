# Phase 6.5 — Deployment Verification Report

**Verdict: PHASE 6.5 DEPLOYMENT VERIFIED (local production-shaped deployment).**

The Phase 6 architecture was exercised as a deployed composition — reverse proxy,
web, API, MCP and PostgreSQL as separate containers, built from pushed commits,
sharing one project volume and one database. Every functional claim in the
mission's completion gate was verified and passed. Two items could not be
verified from this machine and are stated explicitly under
[Not verified](#not-verified) rather than implied.

The verification found one real deployment defect and it was fixed, committed and
pushed (see [Issues found and fixed](#issues-found-and-fixed)).

---

## Source

- **commit (Phase 6 checkpoint):** `e7799c7` — _feat(mcp): ship the remote MCP as a production service (Phase 6)_
- **commit (deployment fix):** `70ec9ef` — _fix(ci): publish the API and MCP images, and gate on the container composition_
- **branch:** `master`
- **remote:** `https://github.com/osviel91/softeare_docs.git`, `origin/master` = `70ec9ef` (verified with `git fetch` + `git rev-parse`)
- **working tree:** clean

The 16 commits that carried Phase 6 to the remote were pushed from a clean tree.
`origin/master` was `09e7e2e` beforehand, so Phase 6 had never been published.

Remote tree at `origin/master` was confirmed to contain `apps/mcp/`,
`Dockerfile.mcp`, `compose.production.yml`, `deploy/reverse-proxy/nginx.conf`,
`src/persistence/migrations/0003-workspace-operations.ts`,
`docs/plan/server-migration-6.md` and ADR-046/047/048.

## Images

Built from the pushed commit with each service's own Dockerfile, then deployed.
The digest values below are the locally built image IDs: these images were built
on this host rather than pulled from a registry, so they have no `RepoDigest`.

| Image                         | Dockerfile       | Local image ID                                                            |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------- |
| `sequencediagrams-web:phase6` | `Dockerfile`     | `sha256:f29308cf3ed99762b48c59140c4654d7a7776b1ac24b1ec941b62ff8b9503978` |
| `sequencediagrams-api:phase6` | `Dockerfile.api` | `sha256:244a451f9280a20bcbd1d1ea7c13f85c50af2f806f53548f1ee556fefc43d6fa` |
| `sequencediagrams-mcp:phase6` | `Dockerfile.mcp` | `sha256:b386000b1baf6948937c0f5b44c346619142b73f0754e5f1735b273c52b3b9fa` |

With `70ec9ef` the workflow publishes `ghcr.io/osviel91/softeare_docs` (web),
`…/api` and `…/mcp`, each also tagged immutably `sha-<short>`, and writes the
pushed digest to the job summary. A deployment should pin that tag or digest.

## Database

- **migration state:** `schema_migrations` = `1`, `2`, `3` — `0003-workspace-operations` applied.
- **required structures present:** `agent_identities`, `agent_credentials`,
  `agent_credential_projects`, `workspace_operations`, `idempotency_records`,
  `audit_events`.
- Migrations were applied by the service on startup, not by hand; the schema was
  never mutated manually.

## Services

Deployed via `docker compose -f compose.production.yml up -d --build`:

| Service                     | State                                                      |
| --------------------------- | ---------------------------------------------------------- |
| web (nginx + static bundle) | healthy, serves the SPA                                    |
| api (Node)                  | healthy, `/healthz` reports `database: ok`, `signIn: oidc` |
| mcp (Node)                  | healthy, `/health` and `/ready` both ok                    |
| postgres                    | healthy (`pg_isready`)                                     |
| reverse proxy (nginx)       | healthy                                                    |

A second composition was then started from **published image references only**
(`WEB_IMAGE`/`API_IMAGE`/`MCP_IMAGE`, `--pull missing`, no build on the host) to
prove the Portainer path; it came up healthy with the same results.

## HTTPS

**Not verified as HTTPS. The composition was verified over HTTP on a local
port.** No host, domain or certificate was available, and the repository
contains no certificates. What _was_ verified about routing:

- three distinct origins are configured: web (`localhost`), API (`/api`, `/auth`,
  `/healthz`) and MCP (`mcp.localhost`);
- the MCP origin serves **only** `/mcp`, `/health`, `/ready`; `/` and
  `/assets/…` are `404` there — no SPA fallback, so the MCP is not a route on web nginx;
- `/metrics` is `403` through the proxy;
- the web origin cannot reach API or MCP internals (`/ready` is not an API route);
- cookies are stripped on the MCP route (`proxy_set_header Cookie ""`);
- no CORS headers are added to the MCP endpoint.

The proxy file carries the commented TLS form (`listen 443 ssl`, HSTS) to be
enabled once real certificates exist. Enabling HSTS before TLS works would lock
users out for its `max-age`, which is why it is not enabled here.

## MCP authentication

| Check                                                                            | Result                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /mcp` with no `Authorization`                                              | **401**, `www-authenticate: Bearer realm="sequencediagrams", resource=…`, body `A personal access token is required.`; no tools and no project data returned |
| `POST /mcp` with a **valid browser session cookie** and no PAT                   | **401** (the MCP never consults a cookie)                                                                                                                    |
| the same cookie against the API                                                  | **200** — proving the cookie was genuinely valid, so the MCP refusal is a real boundary and not a broken credential                                          |
| real MCP client (`@modelcontextprotocol/sdk`) with `Authorization: Bearer <PAT>` | `initialize`/connect succeeds; `tools/list` 15 tools; `resources/list` succeeds                                                                              |

## Scope / project isolation

- A credential carrying `project:read, resource:read, project:search,
project:validate, diagram:render` is advertised **no** mutation tool, and a
  direct `create_resource` call is refused at execution (`Tool … disabled`) —
  hiding is not the boundary.
- A PAT restricted to Project Alpha sees Alpha and does **not** see Beta;
  addressing Beta by id returns `not_found`, so the refusal does not disclose
  that Beta exists.
- The unrestricted control credential does see Beta, proving Beta exists and is
  hidden by policy rather than missing.

## Browser ↔ MCP consistency

Verified with the official MCP client plus a **real headless Chromium** loading
the shipped bundle through the reverse proxy with a real session cookie:

- MCP creates a Markdown resource → the browser lists it, reads the exact bytes,
  revision 1;
- the browser updates it → the MCP reads the new content immediately;
- the browser produced no uncaught page errors.

## Concurrency

Client A wrote at revision N and succeeded; Client B wrote at the same stale
revision N and received a deterministic conflict naming both revisions. The
stored content was A's — no lost update.

## Idempotency

The same mutation sent twice with the same `idempotencyKey`:

- both responses reported success and the same resulting revision;
- the operation journal grew by **exactly one**;
- the revision advanced by **exactly one**;
- exactly **one** `idempotency_records` row exists.

## Operations journal

After all writes, `workspace_operations` contained no `pending`, `processing`,
`compensating` or `failed` row; every journaled operation was `completed`
(4/4 in the final clean run, 6/6 earlier).

## Audit

A deployed MCP mutation produced an audit row of the form
`actor_type=agent`, `actor_id=<agent identity>`, `credential_id=<credential>`,
`auth_type=pat`, with the **subject user** (`user_id`) recorded alongside, and
project/resource/action populated. No raw token (`sdm_pat_`) appears in any audit
detail.

## Observability

- structured one-line JSON logs on stdout;
- `x-request-id` is honoured and carried into the logs; a W3C `traceparent`
  trace id is extracted and carried into the logs;
- tool completion is logged with a duration;
- `/metrics` renders Prometheus text and exposes `mcp_requests_total`,
  `mcp_tool_calls_total`, `auth_failures_total`, `rate_limit_rejections_total`;
  it is **not** publicly reachable (403 through the proxy);
- no PAT, no session cookie value, and no document content appeared in the logs.

## Rate limits

Verified against a **separate low-threshold instance** (`MCP_RATE_READ_LIMIT=5`)
so no production-like budget was consumed. On a fresh credential: exactly 5 read
requests allowed, the 6th rejected with a deterministic `429` naming the class
and `retryAfterSeconds`; an unrelated credential was unaffected, confirming the
budget is per-credential rather than global.

## Restart / stateless

- After a controlled MCP restart the same PAT remained valid, `/ready` returned,
  and projects stayed accessible — no client session state was required.
- Restarting MCP left the API and browser/API project work serving normally.
- Restarting the API left the MCP serving normally.

## Container security

- `mcp` and `api` run as non-root (`USER node`, uid 1000), with a read-only root
  filesystem; `mcp` additionally sets `no-new-privileges`;
- neither mounts the Docker socket, and neither has a source-tree bind mount
  (only the named project volume);
- the MCP image contains no nginx, no frontend bundle, no PGlite, and its `/app`
  holds only `dist-mcp-service`;
- `api` and `mcp` mount the **same** named volume at `/data/projects` with the
  same owner (1000:1000), and a file written through MCP is readable by the API
  process from that volume.

## Issues found and fixed

**CI published only the web image.** Phase 6 defines three images and
`compose.production.yml` requires all three, but `publish-image.yml` built only
the root `Dockerfile`. The API and MCP images therefore could not be deployed
from a pushed commit, and a Portainer stack pointed at the repository had nothing
to pull for two of its five services.

Root cause: the workflow predates Phase 6, when the repository was a static
bundle with a single image, and Phase 6 added two images without extending it.

Fixed minimally in `70ec9ef`:

1. `publish` became a three-leg matrix (`web`, `api`, `mcp`) with per-service
   cache scopes; the web image keeps its existing bare repository name so an
   already-deployed stack keeps working.
2. A `container-integration` job runs `npm run test:containers` on every push —
   the real Dockerfiles, the real composition, the real PostgreSQL — closing the
   gap between "the browser bundle boots" and "the server hosts work".
3. `WEB_IMAGE` / `API_IMAGE` / `MCP_IMAGE` parameterise the compose image
   references so a stack can deploy published images instead of building on the
   host; `.env.example` documents pinning the immutable `sha-<short>` tag.

Regression evidence: the fix was pushed, then a stack was deployed from image
references **without building on the host** and verified healthy
(`web` 200, `api /healthz` database ok, `mcp /health` and `/ready` ok,
unauthenticated MCP 401).

## Gates run from the pushed commit

All run locally from the committed tree; all green.

| Gate                        | Result                                   |
| --------------------------- | ---------------------------------------- |
| format (`prettier --check`) | passed                                   |
| lint (`eslint .`)           | passed                                   |
| typecheck (4 tsconfigs)     | passed                                   |
| unit tests                  | **1801 passed** (121 files)              |
| MCP tests                   | **35 passed** (2 files) + MCP smoke test |
| E2E                         | E2E smoke test passed                    |
| container integration       | **CONTAINER INTEGRATION PASSED**         |
| build                       | web, api and mcp images all built        |

## Not verified

These are stated plainly because the completion gate names them:

1. **Remote CI was not observed.** Neither `gh` nor any GitHub token is
   available on this machine, so the Actions run for `70ec9ef` could not be read.
   The equivalent gates were run locally from the pushed tree and all passed, and
   the workflow was statically validated (YAML parse, three-service matrix, job
   dependencies), but "remote CI is green" rests on the local run, not on an
   observed pipeline. This should be confirmed from the repository's Actions tab.
2. **No real HTTPS deployment.** No host, domain or certificate was available.
   Routing, host separation and the auth boundary were verified over HTTP; a
   valid certificate and HTTP→HTTPS redirect remain unverified.
3. **The new image tags do not exist in GHCR yet.** They are produced on the
   first successful run of the updated workflow. Until then, a Portainer stack
   must either build from a Git checkout or pin the previously-published web
   image only.

## Portainer deployment

`compose.production.yml` is the stack definition; it supports both entry points
from one file.

**Git repository stack** (recommended — builds the repository that contains the
compose file): point the stack at this repository, set the file path to
`compose.production.yml`, and leave the image variables unset.

**Published-image stack** (nothing built on the host): set in the stack's
environment

```text
WEB_IMAGE=ghcr.io/osviel91/softeare_docs:sha-<short>
API_IMAGE=ghcr.io/osviel91/softeare_docs/api:sha-<short>
MCP_IMAGE=ghcr.io/osviel91/softeare_docs/mcp:sha-<short>
```

Both paths also require `POSTGRES_PASSWORD`, `COOKIE_SECRET`, `TOKEN_PEPPER`,
`API_PUBLIC_URL`, `MCP_PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID` and
`OIDC_CLIENT_SECRET`. `TOKEN_PEPPER` must differ from `COOKIE_SECRET`; the
services refuse to start otherwise. `PROXY_PORT` defaults to `8080`. For real
TLS, mount certificates into the proxy and enable the commented `server` blocks
in `deploy/reverse-proxy/nginx.conf`.

---

## Completion gate

| Requirement                           | Status                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| commit pushed                         | yes — `e7799c7`, `70ec9ef`                                                    |
| remote CI green                       | **not observed** (no API access); equivalent gates green locally              |
| production images traceable to commit | local build digests recorded; GHCR tags publish on first updated-workflow run |
| migrations applied                    | yes — 0003, all required tables                                               |
| all services healthy                  | yes — web, api, mcp, postgres, proxy                                          |
| HTTPS MCP reachable                   | reachable over HTTP; **TLS unverified**                                       |
| unauthenticated MCP refused           | yes — 401                                                                     |
| PAT MCP succeeds                      | yes — official client, tools and resources                                    |
| browser sessions refused by MCP       | yes — 401, with the cookie proven valid on the API                            |
| project restrictions verified         | yes — Alpha visible, Beta invisible and refused by id                         |
| browser ↔ MCP consistency verified    | yes — real headless browser, both directions                                  |
| revision conflicts verified           | yes — A succeeds, B conflicts, no lost update                                 |
| idempotency verified                  | yes — one mutation, one revision, one record                                  |
| audit attribution verified            | yes — agent + credential + PAT + subject user                                 |
| restart/stateless behavior verified   | yes — PAT survives, no session state                                          |
| deployment issues fixed and committed | yes — `70ec9ef`                                                               |

**Phase 7 (MCP OAuth 2.1) must not begin until the two unverified items above are
closed**: remote CI observed green, and a real TLS deployment exercised.
