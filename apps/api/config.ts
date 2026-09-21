/**
 * API host configuration.
 *
 * Configuration is read once, validated once, and then passed down as a value.
 * Nothing below this module reads `process.env` (ADR-039), which is what lets a
 * use case run in a test with no environment at all, and what stops a missing
 * secret from being discovered halfway through a request.
 *
 * The one rule enforced here is that the server refuses to start in an unsafe
 * configuration rather than starting and hoping: a production deployment without
 * an OIDC issuer, or with a placeholder cookie secret, is a misconfiguration
 * that should fail loudly at boot.
 */
import type { PgliteOptions } from "../../src/persistence/pglite-client";
import type { PostgresOptions } from "../../src/persistence/postgres-client";

/** Where the server is running. */
export type NodeEnvironment = "development" | "test" | "production";

/** OIDC settings for the identity provider the browser authenticates against. */
export interface OidcSettings {
  /** The issuer, exactly as it appears in the `iss` claim. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /**
   * The redirect URI registered with the provider. Defaults to
   * `<publicUrl>/auth/callback`.
   */
  redirectUri: string;
  /** Where to send the user after logout. Defaults to `<publicUrl>/`. */
  postLogoutRedirectUri: string;
}

/** The complete, validated configuration. */
export interface ServerConfig {
  environment: NodeEnvironment;
  /** The host the API binds to. */
  host: string;
  port: number;
  /** The externally visible base URL, used to build redirect URIs. */
  publicUrl: string;
  /** Secret used to sign the short-lived login-state cookie. */
  cookieSecret: string;
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number;
  database: PostgresOptions | PgliteOptions;
  projectVolume: string;
  oidc: OidcSettings | null;
  /** Whether requests carry a `Secure` cookie; false only for local HTTP. */
  secureCookies: boolean;
}

/** A configuration error: the server must not start. */
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

/** Read a required environment value. */
function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = optional(env, name);
  if (value === undefined) {
    throw new ConfigurationError(`${name} is required.`);
  }
  return value;
}

/**
 * Build the configuration from an environment.
 *
 * @param env - The environment to read. Injectable so a test can build a
 *   configuration without touching the process.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const environment = (optional(env, "NODE_ENV") ??
    "development") as NodeEnvironment;
  if (!["development", "test", "production"].includes(environment)) {
    throw new ConfigurationError(
      `NODE_ENV must be development, test or production (got ${environment}).`,
    );
  }

  const port = Number(optional(env, "PORT") ?? 4000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigurationError(
      `PORT must be a valid port number (got ${port}).`,
    );
  }

  const publicUrl = (
    optional(env, "PUBLIC_URL") ?? `http://localhost:${port}`
  ).replace(/\/+$/, "");

  const cookieSecret = required(env, "COOKIE_SECRET");
  if (cookieSecret.length < 32) {
    throw new ConfigurationError(
      "COOKIE_SECRET must be at least 32 characters; generate one with `openssl rand -base64 48`.",
    );
  }
  if (
    environment === "production" &&
    /^(change|replace|secret|test)/i.test(cookieSecret)
  ) {
    throw new ConfigurationError(
      "COOKIE_SECRET is still a placeholder. Generate a real secret before deploying.",
    );
  }

  const sessionTtlSeconds = Number(
    optional(env, "SESSION_TTL_SECONDS") ?? 60 * 60 * 24 * 14,
  );
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new ConfigurationError(
      "SESSION_TTL_SECONDS must be a positive number.",
    );
  }

  const projectVolume = optional(env, "PROJECT_VOLUME") ?? "/data/projects";
  const databaseUrl = optional(env, "DATABASE_URL");
  if (databaseUrl === undefined && environment !== "test") {
    throw new ConfigurationError(
      "DATABASE_URL is required (for example postgres://user:pass@localhost:5432/sequencediagrams).",
    );
  }

  const database: PostgresOptions | PgliteOptions = databaseUrl
    ? { connectionString: databaseUrl }
    : { dataDir: optional(env, "PGLITE_DIR") ?? "memory://" };

  const oidc = loadOidc(env, publicUrl, environment);
  // An insecure cookie over plain HTTP is only tolerable on a loopback address.
  const secureCookies =
    optional(env, "SECURE_COOKIES") !== "false" &&
    (environment === "production" ||
      !/^http:\/\/(localhost|127\.0\.0\.1)/.test(publicUrl));

  return {
    environment,
    host: optional(env, "HOST") ?? "0.0.0.0",
    port,
    publicUrl,
    cookieSecret,
    sessionTtlSeconds,
    database,
    projectVolume,
    oidc,
    secureCookies,
  };
}

/** Read and validate the OIDC settings, which are all-or-nothing. */
function loadOidc(
  env: Record<string, string | undefined>,
  publicUrl: string,
  environment: NodeEnvironment,
): OidcSettings | null {
  const issuer = optional(env, "OIDC_ISSUER");
  const clientId = optional(env, "OIDC_CLIENT_ID");
  const clientSecret = optional(env, "OIDC_CLIENT_SECRET");

  if (
    issuer === undefined &&
    clientId === undefined &&
    clientSecret === undefined
  ) {
    if (environment === "production") {
      throw new ConfigurationError(
        "OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required in production.",
      );
    }
    // Development may run without an identity provider; the login route then
    // reports that it is not configured instead of half-working.
    return null;
  }

  if (
    issuer === undefined ||
    clientId === undefined ||
    clientSecret === undefined
  ) {
    throw new ConfigurationError(
      "OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set together.",
    );
  }
  if (!issuer.startsWith("https://") && environment === "production") {
    throw new ConfigurationError("OIDC_ISSUER must use https in production.");
  }

  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    redirectUri:
      optional(env, "OIDC_REDIRECT_URI") ?? `${publicUrl}/auth/callback`,
    postLogoutRedirectUri:
      optional(env, "OIDC_POST_LOGOUT_REDIRECT_URI") ?? `${publicUrl}/`,
  };
}
