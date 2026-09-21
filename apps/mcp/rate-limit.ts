/**
 * Per-credential rate limiting (Phase 6 §34–36).
 *
 * Requests are metered by `credentialId`, not by IP: one agent's runaway loop
 * must not consume another agent's budget, and a shared NAT must not make two
 * unrelated agents look like one abuser. The class — read, search, render,
 * write, delete — comes from `Mcp-Method`/`Mcp-Name` when the client sends them
 * and from the JSON-RPC method otherwise, so a proxy could meter the same way
 * without parsing the body.
 *
 * ## Process-local, and honest about it
 *
 * The limiter is an in-memory fixed window. That is correct for a single MCP
 * instance and is *documented as such*: with N instances a credential gets N
 * times its budget. The {@link RateLimiter} interface exists so a deployment
 * that scales out can inject a shared implementation (Redis, a database, a
 * gateway) without touching the transport. Introducing Redis before scaling
 * requires it would be a dependency paid for with no benefit.
 */
import type { RateLimitClass, RateLimits } from "./config";

/** What the limiter is asked about. */
export interface RateLimitRequest {
  /** The credential the request authenticated with. Never the token itself. */
  credentialId: string;
  /** The traffic class, derived from the MCP method and tool name. */
  className: RateLimitClass;
  /** An optional secondary key, for a deployment that also meters by client. */
  clientKey?: string;
}

/** The limiter's answer. */
export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number; limit: number };

/** A rate limiter. Injectable so a scaled deployment can share state. */
export interface RateLimiter {
  check(request: RateLimitRequest): RateLimitDecision;
  /** Drop a window, for a test that wants a clean slate. */
  reset(): void;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * A fixed-window limiter over an in-memory map.
 *
 * The map is bounded by the number of live credentials times the number of
 * classes; an idle entry is dropped the next time its window is consulted, and
 * {@link ProcessRateLimiter.prune} exists for a deployment that wants to reclaim
 * memory eagerly.
 */
export class ProcessRateLimiter implements RateLimiter {
  private readonly limits: RateLimits;
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;

  constructor(limits: RateLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  private keyOf(request: RateLimitRequest): string {
    return `${request.credentialId}\u0000${request.className}\u0000${request.clientKey ?? ""}`;
  }

  check(request: RateLimitRequest): RateLimitDecision {
    const rule = this.limits[request.className];
    const key = this.keyOf(request);
    const now = this.now();
    const existing = this.windows.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return { allowed: true, remaining: rule.limit - 1 };
    }
    if (existing.count >= rule.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.resetAt - now) / 1000),
        ),
        limit: rule.limit,
      };
    }
    existing.count += 1;
    return { allowed: true, remaining: rule.limit - existing.count };
  }

  reset(): void {
    this.windows.clear();
  }

  /** Drop every window whose period has already elapsed. */
  prune(): void {
    const now = this.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

/** A limiter that allows everything, for a test that is not about limits. */
export function allowAllLimiter(): RateLimiter {
  return {
    check: () => ({ allowed: true, remaining: Number.MAX_SAFE_INTEGER }),
    reset: () => {},
  };
}
