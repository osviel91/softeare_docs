/**
 * Constant-time comparison for secrets.
 *
 * Phase 6 moved the implementation into `src/persistence/constant-time.ts` so
 * the MCP host and the API host share one comparison rather than two copies
 * that could drift. This module stays as the API-local name, so existing
 * imports keep working and the security-relevant function still has exactly one
 * implementation.
 */
export { constantTimeEquals } from "../../../src/persistence/constant-time";
