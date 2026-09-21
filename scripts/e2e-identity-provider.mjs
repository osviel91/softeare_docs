#!/usr/bin/env node
/**
 * A local, real OIDC provider for the browser E2E run.
 *
 * The API's authentication code talks to an identity provider over HTTP and
 * verifies a real RS256 signature with `jose`. A canned token would therefore
 * prove nothing: the E2E scenarios have to exercise discovery, the authorization
 * redirect, PKCE, the token exchange and signature verification exactly as a
 * deployment does. This provider is small but genuine — it generates an RSA key
 * pair, publishes a discovery document and a JWKS, signs ID tokens, and refuses a
 * token request whose `code_verifier` does not hash to the challenge it stored.
 *
 * It is deliberately test-only:
 *
 * - it binds loopback only;
 * - the control endpoint can only be reached from a loopback address and needs a
 *   per-run secret header, so it cannot be mistaken for an authentication
 *   surface;
 * - the subject the *next* authorization signs in as is chosen by that control
 *   endpoint, which is what lets one E2E run sign in as two different people
 *   (an owner and a viewer) without an external provider.
 *
 * Only `node:http` and `node:crypto` are used: no dependency is added to the
 * project just to run the E2E suite.
 *
 * Usage in a test: `const idp = await startIdentityProvider(); idp.issuer`.
 * Usage by hand:  `node scripts/e2e-identity-provider.mjs --port 8788`.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** Base64url encode bytes or a string, without padding. */
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** One generated signing identity, in the shape a JWKS publishes. */
function createSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicJwk = publicKey.export({ format: "jwk" });
  const kid = createHash("sha256")
    .update(String(publicJwk.n))
    .digest("hex")
    .slice(0, 16);
  return {
    privateKey,
    jwk: { ...publicJwk, alg: "RS256", use: "sig", kid },
    kid,
  };
}

/** Sign a compact JWS with RS256, as a real provider would. */
function signIdToken(claims, key) {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const signature = sign(
    "sha256",
    Buffer.from(signingInput, "utf8"),
    key.privateKey,
  );
  return `${signingInput}.${base64url(signature)}`;
}

/** Read a request body as text. */
async function readBodyText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Read and JSON-parse a request body, tolerating an empty or malformed one. */
async function readJsonBody(request) {
  const text = (await readBodyText(request)).trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Write a JSON response. */
function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

/** The address a request arrived from, as far as this provider is concerned. */
function isLoopback(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

/**
 * Start the provider.
 *
 * @param {object} [options]
 * @param {number} [options.port] - The port to bind. `0` picks a free one.
 * @param {string} [options.host] - The interface to bind. Loopback by default.
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {number} [options.tokenTtlSeconds]
 * @returns {Promise<{
 *   issuer: string,
 *   port: number,
 *   clientId: string,
 *   clientSecret: string,
 *   controlToken: string,
 *   setSubject(input: {sub: string, name?: string, email?: string|null}): void,
 *   close(): Promise<void>,
 * }>}
 */
export async function startIdentityProvider(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const clientId = options.clientId ?? "e2e-client";
  const clientSecret = options.clientSecret ?? "e2e-client-secret";
  const tokenTtlSeconds = options.tokenTtlSeconds ?? 300;
  const controlToken = randomUUID();
  const key = createSigningKey();

  // The subject the *next* authorization will sign in as. Mutable on purpose:
  // that is the whole point of the control endpoint.
  let nextSubject = {
    sub: "e2e-user-1",
    name: "E2E Owner",
    email: "owner@e2e.test",
  };
  /** Issued authorization codes, keyed by code. */
  const codes = new Map();
  // Assigned once the server is listening; `port` may have been 0 ("any port"),
  // and the issuer must name the port that was actually bound.
  let boundPort = port;

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${host}`);
        const remote = request.socket.remoteAddress ?? "";

        // ---- Test-only control surface -------------------------------------
        if (url.pathname.startsWith("/__control/")) {
          if (!isLoopback(remote)) {
            sendJson(response, 403, {
              error: "control_endpoint_is_loopback_only",
            });
            return;
          }
          if (request.headers["x-e2e-control"] !== controlToken) {
            sendJson(response, 403, {
              error: "control_endpoint_requires_token",
            });
            return;
          }
          if (
            url.pathname === "/__control/subject" &&
            request.method === "POST"
          ) {
            const body = await readJsonBody(request);
            if (typeof body.sub !== "string" || body.sub === "") {
              sendJson(response, 422, { error: "sub_is_required" });
              return;
            }
            nextSubject = {
              sub: body.sub,
              name:
                typeof body.name === "string" && body.name !== ""
                  ? body.name
                  : body.sub,
              email: typeof body.email === "string" ? body.email : null,
            };
            sendJson(response, 200, nextSubject);
            return;
          }
          sendJson(response, 404, { error: "unknown_control_route" });
          return;
        }

        // ---- Discovery and keys --------------------------------------------
        if (url.pathname === "/.well-known/openid-configuration") {
          const issuer = `http://${host}:${boundPort}`;
          sendJson(response, 200, {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            end_session_endpoint: `${issuer}/logout`,
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
          });
          return;
        }

        if (url.pathname === "/jwks") {
          sendJson(response, 200, { keys: [key.jwk] });
          return;
        }

        // ---- Authorization -------------------------------------------------
        if (url.pathname === "/authorize") {
          const codeChallenge = url.searchParams.get("code_challenge");
          const codeChallengeMethod = url.searchParams.get(
            "code_challenge_method",
          );
          const redirectUri = url.searchParams.get("redirect_uri");
          const state = url.searchParams.get("state");
          if (codeChallenge === null || codeChallenge === "") {
            sendJson(response, 400, { error: "code_challenge_is_required" });
            return;
          }
          if (codeChallengeMethod !== "S256") {
            sendJson(response, 400, {
              error: "unsupported_code_challenge_method",
            });
            return;
          }
          if (redirectUri === null || redirectUri === "") {
            sendJson(response, 400, { error: "redirect_uri_is_required" });
            return;
          }
          const code = `code-${randomUUID()}`;
          codes.set(code, {
            codeChallenge,
            nonce: url.searchParams.get("nonce") ?? "",
            subject: { ...nextSubject },
          });
          const target = new URL(redirectUri);
          target.searchParams.set("code", code);
          if (state !== null) target.searchParams.set("state", state);
          response.writeHead(303, { location: target.toString() });
          response.end();
          return;
        }

        // ---- Token ---------------------------------------------------------
        if (url.pathname === "/token" && request.method === "POST") {
          // The API sends an `application/x-www-form-urlencoded` body.
          const params = new URLSearchParams(await readBodyText(request));
          const code = params.get("code") ?? "";
          const issued = codes.get(code);
          if (issued === undefined) {
            sendJson(response, 400, { error: "invalid_grant" });
            return;
          }
          if (
            params.get("client_id") !== clientId ||
            params.get("client_secret") !== clientSecret
          ) {
            sendJson(response, 401, { error: "invalid_client" });
            return;
          }
          const verifier = params.get("code_verifier") ?? "";
          const challenge = base64url(
            createHash("sha256").update(verifier, "ascii").digest(),
          );
          if (challenge !== issued.codeChallenge) {
            sendJson(response, 400, {
              error: "invalid_grant",
              error_description: "PKCE verification failed.",
            });
            return;
          }
          codes.delete(code);
          const now = Math.floor(Date.now() / 1000);
          const idToken = signIdToken(
            {
              iss: `http://${host}:${boundPort}`,
              aud: clientId,
              sub: issued.subject.sub,
              name: issued.subject.name,
              email: issued.subject.email,
              iat: now,
              exp: now + tokenTtlSeconds,
              nonce: issued.nonce,
            },
            key,
          );
          sendJson(response, 200, {
            access_token: `access-${randomUUID()}`,
            token_type: "Bearer",
            expires_in: tokenTtlSeconds,
            id_token: idToken,
          });
          return;
        }

        // ---- End session ---------------------------------------------------
        if (url.pathname === "/logout") {
          const postLogout = url.searchParams.get("post_logout_redirect_uri");
          if (postLogout !== null && postLogout !== "") {
            response.writeHead(302, { location: postLogout });
            response.end();
            return;
          }
          sendJson(response, 200, { ok: true });
          return;
        }

        sendJson(response, 404, { error: "not_found" });
      } catch (error) {
        sendJson(response, 500, { error: String(error) });
      }
    })();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  boundPort = server.address().port;

  return {
    issuer: `http://${host}:${boundPort}`,
    port: boundPort,
    clientId,
    clientSecret,
    controlToken,
    setSubject(input) {
      nextSubject = {
        sub: input.sub,
        name: input.name ?? input.sub,
        email: input.email ?? null,
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Run the provider on its own, for manual use while developing the API. */
async function main() {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag === -1 ? 8788 : Number(process.argv[portFlag + 1]);
  const idp = await startIdentityProvider({ port });
  process.stdout.write(
    `e2e identity provider listening on ${idp.issuer} (client ${idp.clientId})\n`,
  );
  const stop = () => {
    void idp.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
