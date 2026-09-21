/**
 * Authentication challenges (Phase 6 §53, §77 — Phase 7 preparation).
 *
 * The mission is explicit that Phase 6 must not scatter `WWW-Authenticate`
 * responses through handlers, and that Phase 7 will add OAuth Protected Resource
 * Metadata discovery. This module is the single construction point, so Phase 7
 * changes one file rather than every refusal.
 *
 * ## What Phase 6 emits
 *
 * A bare `Bearer` challenge naming the realm. It does **not** advertise an
 * authorization server, because there is no OAuth authorization server yet and
 * pointing a client at one that does not exist would be worse than saying
 * nothing. The `resource` identifier is the canonical MCP URL from
 * configuration — never an incoming `Host` header — which is the value Phase 7
 * will publish as the protected resource.
 *
 * ## Why the resource is in the challenge already
 *
 * A client that receives a challenge with no parameters learns only "a bearer
 * token is required". Publishing the canonical resource now means a Phase 7
 * client can be pointed at the same identifier the metadata document will use,
 * with no migration of the challenge format.
 */

/** What a challenge needs to know. */
export interface ChallengeContext {
  /** The canonical public URL of this MCP service, from configuration. */
  publicUrl: string;
  /** Whether Phase 7's protected-resource metadata is available. */
  resourceMetadataUrl?: string;
}

/**
 * Build the `WWW-Authenticate` value for a `401`.
 *
 * Quoted-string parameters are escaped as RFC 7235 requires; a URL never needs
 * it today, but the escaping is what keeps a future configurable realm from
 * producing a malformed header.
 */
export function bearerChallenge(context: ChallengeContext): string {
  const params: string[] = ['realm="sequencediagrams"'];
  params.push(`resource="${escapeQuoted(context.publicUrl)}"`);
  if (context.resourceMetadataUrl !== undefined) {
    params.push(
      `resource_metadata="${escapeQuoted(context.resourceMetadataUrl)}"`,
    );
  }
  return `Bearer ${params.join(", ")}`;
}

/** Escape a value for a quoted-string parameter. */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
