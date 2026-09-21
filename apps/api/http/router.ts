/**
 * The route table (ADR-040).
 *
 * Routes are declared as `METHOD /pattern` with `:name` parameters, matched in
 * declaration order, and dispatched to a handler that receives the request plus
 * the captured parameters. There is no middleware stack and no plugin system:
 * the two things this API needs are "authenticate the request" and "run a use
 * case", and both are ordinary function calls a handler makes explicitly, which
 * is what keeps the security boundary visible in the handler's own body.
 */
import type { ServerRequest, ServerResponse } from "./http";
import { errorResponse, withSecurityHeaders } from "./http";

/** Parameters captured from a route pattern. */
export type RouteParams = Readonly<Record<string, string>>;

/** A handler bound to a matched route. */
export type BoundHandler = (
  request: ServerRequest,
  params: RouteParams,
) => Promise<ServerResponse>;

/** One declared route. */
export interface Route {
  method: string;
  pattern: string;
  handler: BoundHandler;
}

/** Whether a request path matches a pattern, and which parameters it captured. */
export function matchPattern(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter((part) => part !== "");
  const pathParts = path.split("/").filter((part) => part !== "");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (const [index, wanted] of patternParts.entries()) {
    const actual = pathParts[index];
    if (wanted.startsWith(":")) {
      if (actual === "") return null;
      params[wanted.slice(1)] = actual;
      continue;
    }
    if (wanted !== actual) return null;
  }
  return params;
}

/** The route table. */
export class Router {
  private readonly routes: Route[] = [];

  /** Declare a route. The first declaration of a pattern wins. */
  add(method: string, pattern: string, handler: BoundHandler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  get(pattern: string, handler: BoundHandler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: BoundHandler): this {
    return this.add("POST", pattern, handler);
  }

  put(pattern: string, handler: BoundHandler): this {
    return this.add("PUT", pattern, handler);
  }

  patch(pattern: string, handler: BoundHandler): this {
    return this.add("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: BoundHandler): this {
    return this.add("DELETE", pattern, handler);
  }

  /**
   * Dispatch a request.
   *
   * A path that matches a pattern for a different method answers `405` rather
   * than `404`, because the distinction is what tells a client its URL is right
   * and its verb is wrong.
   */
  async handle(request: ServerRequest): Promise<ServerResponse> {
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchPattern(route.pattern, request.path);
      if (params === null) continue;
      pathMatched = true;
      if (route.method !== request.method.toUpperCase()) continue;
      const response = await route.handler(request, params);
      return withSecurityHeaders(response);
    }
    return withSecurityHeaders(
      pathMatched
        ? errorResponse(
            405,
            "method_not_allowed",
            `${request.method} is not allowed here.`,
          )
        : errorResponse(404, "not_found", "No such route."),
    );
  }
}
