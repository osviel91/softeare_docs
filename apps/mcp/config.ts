/**
 * MCP service configuration (Phase 6 §3, §34–38, §47–51, §72–74).
 *
 * Configuration is read once, validated once, and passed down as a value — the
 * same rule the API follows (ADR-039). Nothing below this module reads
 * `process.env`, which is what lets a test build the whole service with no
 * environment and what stops a missing secret from being discovered halfway
 * through a tool call.
 *
 * ## What is different from the API's configuration
 *
 * The MCP service terminates no browser traffic, so it has no cookie secret and
 * no OIDC client. It does have a *canonical public URL*: the reverse proxy's
 * public identity for this host, used for the `WWW-Authenticate` challenge and
 * reserved for Phase 7's protected-resource metadata. That value is never
 * derived from an incoming `Host` header.
 *
 * ## TOKEN_PEPPER is required, and independent
 *
 * Phase 5 let `TOKEN_PEPPER` default to `COOKIE_SECRET`. That is a key-reuse
 * mistake: the cookie secret signs login state while this key authenticates
 * machine credentials, so a leak of one must not compromise the other, and the
 * two should rotate on different schedules. This loader requires a real pepper
 * in every environment (a short development default is generated only for
 * `test`), and refuses a placeholder in production.
 */
import type { PgliteOptions } from "../../src/persistence/pglite-client";
import type { PostgresOptions } from "../../src/persistence/postgres-client";
import type { ResourceType } from "../../src/domain/workspace/resource-id";

/** Where the service is running. */
export type NodeEnvironment = "development" | "test" | "production";

/** One rate-limit class: how many requests and over how long. */
export interface RateLimitRule {
  /** Requests allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** The traffic classes the limiter distinguishes. */
export type RateLimitClass = "read" | "search" | "render" | "write" | "delete";

/** A complete set of per-class limits. */
export type RateLimits = Readonly<Record<RateLimitClass, RateLimitRule>>;

/** Per-resource-type maximum document size in bytes. */
export type ResourceSizeLimits = Readonly<Record<ResourceType, number>>;

/** The complete, validated MCP service configuration. */
export interface McpConfig {
  environment: NodeEnvironment;
  host: string;
  port: number;
  /**
   * The canonical public URL of this MCP service, without a trailing slash.
   *
   * Used to build the `WWW-Authenticate` challenge and, in Phase 7, the OAuth
   * protected-resource identifier. Never read from a request header.
   */
  publicUrl: string;
  /** The path the MCP endpoint is mounted at. Defaults to `/mcp`. */
  mcpPath: string;
  database: PostgresOptions | PgliteOptions;
  projectVolume: string;
  /** The HMAC pepper agent credential digests are keyed with. Required. */
  tokenPepper: string;
  /** The largest MCP request body accepted, in bytes. */
  maxBodyBytes: number;
  /** Per-resource-type size ceilings, in bytes. */
  resourceSizeLimits: ResourceSizeLimits;
  /** Per-class, per-credential rate limits. */
  rateLimits: RateLimits;
  /**
   * How long a tool may run before its work is aborted, in milliseconds.
   * `null` disables the deadline (only sensible for a trusted single user).
   */
  toolTimeoutMs: number;
  /**
   * The addresses whose `X-Forwarded-*` and `Forwarded` headers are believed.
   *
   * Empty means "no proxy is trusted": forwarded headers are ignored entirely
   * and the socket address is used. A wildcard is deliberately not expressible —
   * trusting every client's `X-Forwarded-For` is the same as having no check.
   */
  trustedProxies: readonly string[];
  /**
   * Host header values this service will answer for, when configured.
   *
   * Empty means "do not check the Host header" — correct for a private network
   * where the proxy is the only client, and honest about the fact that a
   * canonical URL derived from configuration is what resource identifiers use.
   * A deployment that is reachable directly should set this so a Host-header
   * attack cannot make the service believe it is someone else (mission §51).
   */
  allowedHosts: readonly string[];
  /** Whether to emit Prometheus-style metrics at `/metrics`. */
  metricsEnabled: boolean;
  /**
   * The write-ahead staging directory used by the operation journal, relative
   * to each project's root. Kept configurable so a deployment can place it on
   * the same volume as the project.
   */
  stagingDirectory: string;
}

/** A configuration error: the service must not start. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Read an optional environment value, treating an empty string as absent. */
function optional(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** Read an optional positive integer. */
function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive number.`);
  }
  return Math.floor(value);
}

/** Read a comma-separated list. */
function listOf(
  env: Record<string, string | undefined>,
  name: string,
): string[] {
  const raw = optional(env, name);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** The default per-type resource ceilings (bytes). */
function defaultResourceLimits(): ResourceSizeLimits {
  return {
    // A sequence diagram is human-authored DSL; a megabyte is already enormous.
    "sequence-diagram": 1024 * 1024,
    "event-flow": 1024 * 1024,
    // Markdown documents legitimately grow; still far below "multi-gigabyte".
    "markdown-document": 4 * 1024 * 1024,
  };
}

/** The default per-class limits, tuned for an agent rather than a browser. */
function defaultRateLimits(): RateLimits {
  return {
    read: { limit: 600, windowMs: 60_000 },
    search: { limit: 120, windowMs: 60_000 },
    render: { limit: 60, windowMs: 60_000 },
    write: { limit: 60, windowMs: 60_000 },
    delete: { limit: 10, windowMs: 60_000 },
  };
}

/** Read one class's override, falling back to the default. */
function rateRule(
  env: Record<string, string | undefined>,
  className: RateLimitClass,
  fallback: RateLimitRule,
): RateLimitRule {
  const upper = className.toUpperCase();
  return {
    limit: positiveInteger(env, `MCP_RATE_${upper}_LIMIT`, fallback.limit),
    windowMs: positiveInteger(
      env,
      `MCP_RATE_${upper}_WINDOW_MS`,
      fallback.windowMs,
    ),
  };
}

/**
 * Build the MCP configuration from an environment.
 *
 * @param env - The environment to read. Injectable so a test can build a
 *   configuration without touching the process.
 */
export function loadMcpConfig(
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  const environment = (optional(env, "NODE_ENV") ??
    "development") as NodeEnvironment;
  if (!["development", "test", "production"].includes(environment)) {
    throw new ConfigurationError(
      `NODE_ENV must be development, test or production (got ${environment}).`,
    );
  }

  const port = positiveInteger(env, "PORT", 4100);
  if (port > 65535) {
    throw new ConfigurationError(`PORT must be a valid port number.`);
  }

  const publicUrl = (
    optional(env, "MCP_PUBLIC_URL") ?? `http://localhost:${port}`
  ).replace(/\/+$/, "");
  const mcpPath = optional(env, "MCP_PATH") ?? "/mcp";
  if (!mcpPath.startsWith("/")) {
    throw new ConfigurationError("MCP_PATH must start with '/'.");
  }

  const tokenPepper = loadTokenPepper(env, environment);

  const databaseUrl = optional(env, "DATABASE_URL");
  if (databaseUrl === undefined && environment !== "test") {
    throw new ConfigurationError(
      "DATABASE_URL is required (for example postgres://user:pass@localhost:5432/sequencediagrams).",
    );
  }
  const database: PostgresOptions | PgliteOptions = databaseUrl
    ? { connectionString: databaseUrl }
    : { dataDir: optional(env, "PGLITE_DIR") ?? "memory://" };

  const defaults = defaultResourceLimits();
  const resourceSizeLimits: ResourceSizeLimits = {
    "sequence-diagram": positiveInteger(
      env,
      "MCP_MAX_SEQ_BYTES",
      defaults["sequence-diagram"],
    ),
    "event-flow": positiveInteger(
      env,
      "MCP_MAX_EVENTSEQ_BYTES",
      defaults["event-flow"],
    ),
    "markdown-document": positiveInteger(
      env,
      "MCP_MAX_MARKDOWN_BYTES",
      defaults["markdown-document"],
    ),
  };

  const base = defaultRateLimits();
  const rateLimits: RateLimits = {
    read: rateRule(env, "read", base.read),
    search: rateRule(env, "search", base.search),
    render: rateRule(env, "render", base.render),
    write: rateRule(env, "write", base.write),
    delete: rateRule(env, "delete", base.delete),
  };

  return {
    environment,
    host: optional(env, "HOST") ?? "0.0.0.0",
    port,
    publicUrl,
    mcpPath,
    database,
    projectVolume: optional(env, "PROJECT_VOLUME") ?? "/data/projects",
    tokenPepper,
    maxBodyBytes: positiveInteger(env, "MCP_MAX_BODY_BYTES", 1024 * 1024),
    resourceSizeLimits,
    rateLimits,
    toolTimeoutMs: positiveInteger(env, "MCP_TOOL_TIMEOUT_MS", 30_000),
    trustedProxies: listOf(env, "TRUSTED_PROXIES"),
    allowedHosts: listOf(env, "MCP_ALLOWED_HOSTS"),
    metricsEnabled: optional(env, "MCP_METRICS") !== "false",
    stagingDirectory: optional(env, "MCP_STAGING_DIR") ?? ".sdd-staging",
  };
}

/**
 * Read the credential pepper.
 *
 * A test environment gets a deterministic default so a suite needs no setup; a
 * development or production deployment must supply one, and production refuses
 * a value that still looks like a placeholder.
 */
function loadTokenPepper(
  env: Record<string, string | undefined>,
  environment: NodeEnvironment,
): string {
  const supplied = optional(env, "TOKEN_PEPPER");
  if (supplied === undefined) {
    if (environment === "test") return "test-token-pepper-not-for-deployment";
    throw new ConfigurationError(
      "TOKEN_PEPPER is required and must be independent of COOKIE_SECRET (generate one with `openssl rand -base64 48`).",
    );
  }
  if (supplied.length < 32) {
    throw new ConfigurationError(
      "TOKEN_PEPPER must be at least 32 characters; generate one with `openssl rand -base64 48`.",
    );
  }
  if (
    environment === "production" &&
    /^(change|replace|secret|test|dev)/i.test(supplied)
  ) {
    throw new ConfigurationError(
      "TOKEN_PEPPER is still a placeholder. Generate a real secret before deploying.",
    );
  }
  return supplied;
}

/** The size ceiling for a resource type. */
export function limitFor(config: McpConfig, type: ResourceType): number {
  return config.resourceSizeLimits[type];
}

/** The rate-limit class a tool belongs to. */
export function classForTool(toolName: string): RateLimitClass {
  if (toolName === "delete_resource") return "delete";
  if (
    toolName === "create_project" ||
    toolName === "create_resource" ||
    toolName === "update_resource" ||
    toolName === "move_resource" ||
    toolName === "upsert_documentation" ||
    toolName === "upsert_sequence_diagram"
  ) {
    return "write";
  }
  if (
    toolName === "render_diagram" ||
    toolName === "validate_project" ||
    toolName === "get_event_catalog" ||
    toolName === "find_event_producers" ||
    toolName === "find_event_consumers"
  ) {
    return "search";
  }
  if (toolName === "search_project") return "search";
  return "read";
}
