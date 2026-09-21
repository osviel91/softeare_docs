/**
 * A real MCP service for the integration tests (Phase 6 §62–66).
 *
 * This builds the production composition root — the same one `main.ts` uses —
 * against an in-memory PostgreSQL and a temporary project volume, then listens
 * on an ephemeral port. Nothing is stubbed: the tests speak Streamable HTTP to
 * a real socket with the official MCP client SDK, which is what the mission asks
 * for instead of poking the transport by hand.
 *
 * The harness also exposes the pieces a test needs to set up identity: a user, a
 * project, an agent and a credential, all through the same repositories the API
 * uses.
 */
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMcpConfig, type McpConfig } from "../../apps/mcp/config";
import { createMcpService, type McpService } from "../../apps/mcp/app";
import { createMcpHttpServer } from "../../apps/mcp/http/node-server";
import { createAgentService } from "../../src/application/agent-service";
import { createCredentialMint } from "../../src/persistence/agent-authentication";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import type { ApplicationContext } from "../../src/application/context";

/** A running MCP service plus the fixtures a test needs. */
export interface McpHarness {
  service: McpService;
  config: McpConfig;
  server: Server;
  /** The URL the client connects to; ends with `/mcp`. */
  url: string;
  /** The origin the server was actually bound to. */
  origin: string;
  close(): Promise<void>;
  /** A fresh user, as a login would create one. */
  aUser(name?: string): Promise<string>;
  /** A project owned by a user, with its storage directory materialised. */
  aProject(ownerId: string, name?: string): Promise<string>;
  /** An agent credential for a user; returns its plaintext and ids. */
  aToken(
    ownerId: string,
    scopes?: readonly string[],
    projectIds?: readonly string[],
  ): Promise<{ token: string; credentialId: string; agentId: string }>;
  /** The token's pepper, for a test that must forge a bad credential. */
  pepper: string;
  /**
   * A second HTTP listener over the *same* backend.
   *
   * The mission's stateless test sends request 1 to instance A, request 2 to
   * instance B and request 3 back to A. Two listeners on one runtime share the
   * database and the volume but nothing in memory at the HTTP layer, so a
   * request that needed hidden per-process protocol state would fail. True
   * multi-process sharing is what the container integration test covers.
   */
  addInstance(): Promise<{
    url: string;
    origin: string;
    close: () => Promise<void>;
  }>;
}

/** Options a test may override. */
export interface HarnessOptions {
  /** Extra environment for `loadMcpConfig`. */
  env?: Record<string, string | undefined>;
}

/** Start a real MCP service on an ephemeral port. */
export async function startHarness(
  options: HarnessOptions = {},
): Promise<McpHarness> {
  const volume = await mkdtemp(path.join(tmpdir(), "sd-mcp-svc-"));
  const config = loadMcpConfig({
    NODE_ENV: "test",
    PORT: "4100",
    PGLITE_DIR: "memory://",
    PROJECT_VOLUME: volume,
    MCP_PUBLIC_URL: "http://localhost:4100",
    ...options.env,
  });

  // A silent logger keeps the suite's output about assertions rather than about
  // the structured lines the service would write in production.
  const service = await createMcpService(config, {
    logger: { log: () => {} },
  });
  const server = createMcpHttpServer({
    config,
    observability: service.observability,
    handleMcp: service.handleMcp,
    ready: service.ready,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the MCP test server did not bind a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  // The agents service is what the API's credential routes call; using it here
  // means a test credential is minted exactly as a real one is.
  const agents = createAgentService({
    agents: service.runtime.agentIdentities,
    credentials: service.runtime.credentials,
    projects: service.runtime.projects,
    audit: service.runtime.audit,
    mint: createCredentialMint(config.tokenPepper),
  });

  const harness: McpHarness = {
    service,
    config,
    server,
    url: `${origin}${config.mcpPath}`,
    origin,
    pepper: config.tokenPepper,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
      await rm(volume, { recursive: true, force: true });
    },
    async addInstance() {
      const instance = createMcpHttpServer({
        config,
        observability: service.observability,
        handleMcp: service.handleMcp,
        ready: service.ready,
      });
      await new Promise<void>((resolve, reject) => {
        instance.once("error", reject);
        instance.listen(0, "127.0.0.1", () => resolve());
      });
      const address = instance.address();
      if (address === null || typeof address === "string") {
        throw new Error("the second MCP instance did not bind a TCP port");
      }
      const instanceOrigin = `http://127.0.0.1:${address.port}`;
      return {
        url: `${instanceOrigin}${config.mcpPath}`,
        origin: instanceOrigin,
        close: () =>
          new Promise<void>((resolve) => instance.close(() => resolve())),
      };
    },
    async aUser(name = "MCP User") {
      const user = await service.runtime.users.findOrCreateByExternalIdentity({
        issuer: "https://idp.test",
        subject: `subject-${Math.random().toString(36).slice(2)}`,
        displayName: name,
        email: null,
      });
      return user.id;
    },
    async aProject(ownerId, name = "MCP Project") {
      const project = await service.runtime.projects.create({
        ownerId,
        name,
      });
      await service.runtime.storageFor(project.id).list();
      return project.id;
    },
    async aToken(ownerId, scopes, projectIds) {
      // Managing agents is session-only and additionally requires the manage
      // capabilities, exactly as the settings API demands.
      const session: ApplicationContext = {
        requestId: "req-harness",
        principal: {
          subjectUserId: ownerId,
          actor: { kind: "user", userId: ownerId },
          authType: "session",
          scopes: [...ALL_PERMISSIONS],
        },
      };
      const agent = await agents.createAgent(session, {
        name: "Harness agent",
      });
      const created = await agents.createCredential(session, agent.id, {
        name: "Harness credential",
        scopes: (scopes ?? [
          "project:read",
          "resource:read",
          "diagram:render",
          "project:search",
          "project:validate",
          "resource:write",
        ]) as never,
        ...(projectIds === undefined ? {} : { allowedProjectIds: projectIds }),
      });
      return {
        token: created.token,
        credentialId: created.credential.id,
        agentId: agent.id,
      };
    },
  };

  return harness;
}
