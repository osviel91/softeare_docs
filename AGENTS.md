# Agent Guide

## Product

- SequenceDiagrams Manager is a local-first browser IDE for authoring, validating, rendering, and exporting sequence-diagram and event-flow DSLs, plus Markdown documentation.
- Its owned core is the two language parsers/validators, framework-free domain and layout models, deterministic SVG renderer, project index, and local workspace repositories. The React UI, stdio MCP server, HTTP API, and remote MCP service all consume those shared layers.

## Commands

- Install with `npm ci`; `.npmrc` intentionally keeps npm's cache in the ignored `./.npm-cache/` directory.
- Run the focused Vitest file with `npm test -- tests/language/parser.test.ts`; `npm test` runs all jsdom, API, persistence, MCP, and architecture tests.
- Match CI's fast gates with `npm run lint && npm run typecheck && npm test && npm run test:mcp`.
- `npm run test:e2e` builds the web/API/remote-MCP bundles and boots them with PGlite; install Chromium first with `npx playwright install chromium`. Set `E2E_PORT` only when the default preview port conflicts.
- `npm run test:containers` exercises the production Dockerfiles and compose topology; use it for API/MCP/storage integration changes.
- `npm run build` type-checks every host and writes `dist/`, `dist-mcp/`, `dist-api/`, and `dist-mcp-service/`; those directories are build output, never edit them.

## Structure

- The browser entry is `src/main.tsx` -> `src/App.tsx`. Keep diagram semantics in the pipeline: `src/language` -> `src/domain` -> `src/layout` -> `src/renderer`; React features consume its results.
- `src/application` is the shared use-case layer. `mcp/` (stdio), `apps/api/` (HTTP), and `apps/mcp/` (remote MCP) are hosts/adapters over it, not peers.
- The browser's `/api` and `/auth` requests are same-origin and Vite proxies both to `SDM_API_TARGET` (default `http://127.0.0.1:8787`). Run `npm run api` separately when manually testing server-backed browser flows.
- Local-first web and stdio MCP need no environment. API/remote-MCP configuration is validated at startup; copy `.env.example` only for server mode. `DATABASE_URL` and `COOKIE_SECRET` are required; use `PGLITE_DIR=memory://` only in tests/development.

## Deployment

- Static local-first deployment: `docker compose up --build -d` serves the web image on `http://localhost:8080` (override with `WEB_PORT`). It has no backend, database, or server-side state.
- Portainer static deployment uses `deploy/portainer-stack.yml`; set `IMAGE_TAG` (prefer immutable `sha-<short>`) and optionally `WEB_PORT`. Published web images are `ghcr.io/osviel91/softeare_docs`.
- Full server deployment: set the required secrets and public URLs in `.env`, optionally set `PLATFORM_ADMIN_EMAIL`, then run `docker compose -f compose.production.yml up --build -d`. It runs reverse proxy, web, API, remote MCP, and PostgreSQL; API and MCP share the `project-data` volume but never call each other over HTTP.
- The production composition requires `POSTGRES_PASSWORD`, `COOKIE_SECRET`, `TOKEN_PEPPER`, `API_PUBLIC_URL`, `MCP_PUBLIC_URL`, and all OIDC values. For published images, set `WEB_IMAGE`, `API_IMAGE`, `MCP_IMAGE`, and `PROXY_IMAGE` to pinned GHCR tags instead of building on the host.

## Boundaries

- Do not let renderers parse source, editors compute geometry, or language/domain/application modules import React/features.
- Keep `src/domain` independent of `src/application`; keep `src/application` independent of `src/persistence` and all hosts. Hosts must not import each other or `src/features`. These rules are enforced by `tests/architecture/boundaries.test.ts`.
- Add a DSL feature across grammar, AST, validation, layout, and renderer. For project facts, use `ProjectIndex`; panels/completion/hover/references must not independently re-parse resources.
