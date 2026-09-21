/**
 * Constant-time comparison for secrets.
 *
 * One implementation, because three near-identical copies of a comparison are
 * three chances for one of them to lose the length check or reach for `===`.
 * Node's `timingSafeEqual` needs equal-length buffers, so the length test comes
 * first — and, for a hash or a signature, its own timing is not a leak: the
 * lengths are public.
 *
 * Phase 6 moved this from `apps/api/auth/secret-compare.ts` into the shared
 * persistence layer so the MCP host compares credential digests with the same
 * function the API does, rather than a copy that could drift.
 */
import { timingSafeEqual } from "node:crypto";

/** Whether two strings are equal, without leaking where they first differ. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
