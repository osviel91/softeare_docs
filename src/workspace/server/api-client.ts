/**
 * The browser's API client: the one place that knows what the server's HTTP
 * surface looks like.
 *
 * Nothing above this module — no React component, no workspace repository —
 * builds a URL, serializes a body or reads a status code. A caller asks for a
 * resource and gets either a typed value or one of the errors in
 * {@link ./api-errors}. That indirection is what lets the editor run unchanged
 * against IndexedDB and against the server: only the adapter below the
 * `WorkspaceRepository` seam knows there is a network at all.
 *
 * Two deliberate decisions:
 *
 * - **Authentication is ambient.** Every request is sent with
 *   `credentials: "same-origin"`, so the HttpOnly session cookie travels with it
 *   and no token ever exists in JavaScript. There is no `Authorization` header to
 *   leak, because the browser holds the credential and only the browser can read
 *   it back.
 * - **A transport failure is not a verdict.** A rejected `fetch` (offline, DNS,
 *   connection reset) becomes a {@link NetworkError}, never an {@link ApiError}:
 *   nothing was refused, so nothing may be reported as refused, and the caller
 *   must keep the user's content and offer a retry.
 */
import { apiErrorFromResponse, NetworkError } from "./api-errors";
import type { ResourceMetadata } from "../../domain/workspace/resource-metadata";
import type { ResourceAuthorship } from "../../domain/workspace/resource-revision";
import type { ResourceDiff } from "../../domain/diff/resource-diff";

/** The signed-in person, as `GET /api/me` reports them. */
export interface AuthenticatedUser {
  id: string;
  displayName: string;
  email: string | null;
  authType: string;
  scopes: readonly string[];
  accountStatus?: "PENDING" | "ACTIVE" | "SUSPENDED";
  platformAdmin?: boolean;
}

export interface ServerAdminUser {
  id: string;
  displayName: string;
  email: string | null;
  status: "PENDING" | "ACTIVE" | "SUSPENDED";
  platformAdmin: boolean;
  createdAt?: string;
}

/** A project listing, as the API renders it. */
export interface ServerProject {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  ownerId: string;
  role: string;
  resourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ServerWorkspaceRole = "ADMIN" | "EDITOR" | "VIEWER";

export interface ServerWorkspace {
  id: string;
  ownerId: string;
  name: string;
  isDefault: boolean;
  role: ServerWorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

export interface ServerWorkspaceMember {
  workspaceId: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: ServerWorkspaceRole;
  createdAt: string;
}

/** The type a server resource can carry. */
export type ServerResourceType =
  "sequence-diagram" | "event-flow" | "markdown-document";

/** A resource's identity and concurrency state, as the API renders it. */
export interface ServerResource {
  id: string;
  projectId: string;
  path: string;
  type: ServerResourceType;
  revision: number;
  metadata?: ResourceMetadata;
}

/** What the caller may do in a project, for rendering affordances. */
export interface ServerProjectAccess {
  projectId: string;
  role: string;
  permissions: readonly string[];
}

/** An agent identity, as `/api/agents` renders it. */
export interface ServerAgent {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
  disabled: boolean;
  credentialCount?: number;
  activeCredentialCount?: number;
}

/** A credential's metadata, as `/api/agents/:id/credentials` renders it. */
export interface ServerCredential {
  id: string;
  agentId: string;
  name: string;
  prefix: string;
  scopes: readonly string[];
  allowedProjectIds: readonly string[] | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "revoked" | "expired" | "disabled";
}

/** A newly created credential: its metadata plus the one-time plaintext. */
export interface CreatedServerCredential {
  /** The full `sdm_pat_…` value. The caller must show it and then forget it. */
  secret: string;
  credential: ServerCredential;
}

/** The agent list together with the scope vocabulary the server offers. */
export interface ServerAgentList {
  agents: ServerAgent[];
  scopes: string[];
  defaultScopes: string[];
}

/** A credential list together with the scope vocabulary the server offers. */
export interface ServerCredentialList {
  credentials: ServerCredential[];
  scopes: string[];
  defaultScopes: string[];
}

/** The `fetch` shape this client uses. Injectable so a test needs no network. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Options for {@link ServerApiClient}. */
export interface ServerApiClientOptions {
  /**
   * The API's origin. Defaults to the page's own origin, which is how the
   * deployment runs (one host, the API behind `/api` and `/auth`).
   */
  baseUrl?: string;
  /** Where requests are sent from. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** A resource that may or may not exist, as `GET` reports it. */
export interface ServerResourceRead {
  resource: ServerResource;
  content: string;
}

export interface ServerChangeProposal {
  id: string;
  resourceId: string;
  baseRevision: number;
  proposedContent: string;
  proposedMetadata?: ResourceMetadata;
  title: string;
  description?: string;
  author: ResourceAuthorship;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "open" | "closed";
  version: number;
}

export interface ServerChangeProposalDiff extends ResourceDiff {
  proposalId: string;
  resourceId: string;
  baseRevision: number;
  currentRevision: number;
  stale: boolean;
  type: "sequence-diagram" | "event-flow" | "markdown-document";
  baseContent: string;
  proposedContent: string;
  baseMetadata?: ResourceMetadata;
  proposedMetadata?: ResourceMetadata;
}

/**
 * A thin, typed wrapper over the server's HTTP API.
 *
 * Every method either resolves with the server's answer (already narrowed out of
 * its envelope) or throws a typed error. It never returns a `Response`, so no
 * caller has to remember which statuses are "fine".
 */
export class ServerApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ServerApiClientOptions = {}) {
    // A trailing slash would double up when joined with `/api/...`.
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The URL of the sign-in route, for a full-page navigation. */
  loginUrl(returnTo?: string): string {
    const query =
      returnTo === undefined || returnTo === ""
        ? ""
        : `?returnTo=${encodeURIComponent(returnTo)}`;
    return `${this.baseUrl}/auth/login${query}`;
  }

  /** The current user, or `null` when nobody is signed in. */
  async me(): Promise<AuthenticatedUser | null> {
    const body = await this.request<{ user: AuthenticatedUser | null }>(
      "GET",
      "/api/me",
    );
    return body.user ?? null;
  }

  async registerLocalAccount(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<{ status: "PENDING"; message: string }> {
    return this.request<{ status: "PENDING"; message: string }>(
      "POST",
      "/auth/register",
      input,
    );
  }

  async loginLocal(input: {
    email: string;
    password: string;
  }): Promise<{ status: "authenticated" }> {
    return this.request<{ status: "authenticated" }>(
      "POST",
      "/auth/local-login",
      input,
    );
  }

  async listAdminUsers(): Promise<ServerAdminUser[]> {
    const body = await this.request<{ users: ServerAdminUser[] }>(
      "GET",
      "/api/admin/users",
    );
    return body.users ?? [];
  }

  async setUserStatus(
    userId: string,
    status: ServerAdminUser["status"],
  ): Promise<ServerAdminUser> {
    const body = await this.request<{ user: ServerAdminUser }>(
      "PATCH",
      `/api/admin/users/${encodeURIComponent(userId)}`,
      { status },
    );
    return body.user;
  }

  async listWorkspaces(): Promise<ServerWorkspace[]> {
    const body = await this.request<{ workspaces: ServerWorkspace[] }>(
      "GET",
      "/api/workspaces",
    );
    return body.workspaces ?? [];
  }

  async createWorkspace(name: string): Promise<ServerWorkspace> {
    const body = await this.request<{ workspace: ServerWorkspace }>(
      "POST",
      "/api/workspaces",
      { name },
    );
    return body.workspace;
  }

  async renameWorkspace(
    workspaceId: string,
    name: string,
  ): Promise<ServerWorkspace> {
    const body = await this.request<{ workspace: ServerWorkspace }>(
      "PATCH",
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      { name },
    );
    return body.workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    );
  }

  async listWorkspaceMembers(
    workspaceId: string,
  ): Promise<ServerWorkspaceMember[]> {
    const body = await this.request<{ members: ServerWorkspaceMember[] }>(
      "GET",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
    );
    return body.members ?? [];
  }

  async setWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    role: ServerWorkspaceRole,
  ): Promise<ServerWorkspaceMember> {
    const body = await this.request<{ member: ServerWorkspaceMember }>(
      "PUT",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { role },
    );
    return body.member;
  }

  async removeWorkspaceMember(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
    );
  }

  /** Every project the caller can access in one workspace. */
  async listProjects(workspaceId: string): Promise<ServerProject[]> {
    const body = await this.request<{ projects: ServerProject[] }>(
      "GET",
      `/api/projects?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    return body.projects ?? [];
  }

  /** Create a project and return its listing (the caller becomes its owner). */
  async createProject(
    name: string,
    workspaceId: string,
  ): Promise<ServerProject> {
    const body = await this.request<{ project: ServerProject }>(
      "POST",
      "/api/projects",
      { name, workspaceId },
    );
    return body.project;
  }

  /** Rename a project, or change its slug. */
  async updateProject(
    projectId: string,
    changes: { name?: string; slug?: string },
  ): Promise<ServerProject> {
    const body = await this.request<{ project: ServerProject }>(
      "PATCH",
      `/api/projects/${encodeURIComponent(projectId)}`,
      changes,
    );
    return body.project;
  }

  /** Delete a project and everything it holds. */
  async deleteProject(projectId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
  }

  /** What the caller may do in a project. Advisory: the server re-checks. */
  async access(projectId: string): Promise<ServerProjectAccess> {
    return this.request<ServerProjectAccess>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/access`,
    );
  }

  /** Every resource a project records. */
  async listResources(projectId: string): Promise<ServerResource[]> {
    const body = await this.request<{ resources: ServerResource[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/resources`,
    );
    return body.resources ?? [];
  }

  /** Read one resource's record and text. */
  async readResource(
    projectId: string,
    resourceId: string,
  ): Promise<ServerResourceRead> {
    return this.request<ServerResourceRead>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
    );
  }

  async listChangeProposals(
    projectId: string,
    resourceId: string,
  ): Promise<ServerChangeProposal[]> {
    const body = await this.request<{ proposals: ServerChangeProposal[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/proposals`,
    );
    return body.proposals ?? [];
  }

  async getChangeProposal(id: string): Promise<ServerChangeProposal> {
    const body = await this.request<{ proposal: ServerChangeProposal }>(
      "GET",
      `/api/change-proposals/${encodeURIComponent(id)}`,
    );
    return body.proposal;
  }

  async getChangeProposalDiff(id: string): Promise<ServerChangeProposalDiff> {
    const body = await this.request<{ diff: ServerChangeProposalDiff }>(
      "GET",
      `/api/change-proposals/${encodeURIComponent(id)}/diff`,
    );
    return body.diff;
  }

  /** Create a resource at a path, refusing one that is already taken. */
  async createResource(
    projectId: string,
    input: { path: string; type: ServerResourceType; content: string; metadata?: ResourceMetadata },
  ): Promise<ServerResource> {
    const body = await this.request<{ resource: ServerResource }>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/resources`,
      input,
    );
    return body.resource;
  }

  /**
   * Replace a resource's content, refusing a stale `expectedRevision`.
   *
   * The revision is required by the server, and required here too: a write
   * without one is an instruction to overwrite whatever is there.
   */
  async updateResource(
    projectId: string,
    resourceId: string,
    input: { content: string; expectedRevision: number; metadata?: ResourceMetadata },
  ): Promise<ServerResource> {
    const body = await this.request<{ resource: ServerResource }>(
      "PUT",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
      input,
    );
    return body.resource;
  }

  /** Move a resource to another path, keeping its id. */
  async moveResource(
    projectId: string,
    resourceId: string,
    input: { path: string; expectedRevision: number },
  ): Promise<ServerResource> {
    const body = await this.request<{ resource: ServerResource }>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/move`,
      input,
    );
    return body.resource;
  }

  /** Delete a resource. */
  async deleteResource(projectId: string, resourceId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
    );
  }

  /** Revoke the session server-side and clear the cookie. */
  async logout(): Promise<void> {
    await this.request<unknown>("POST", "/auth/logout");
  }

  /** The caller's agents, with the scope vocabulary the server offers. */
  async listAgents(): Promise<ServerAgentList> {
    const body = await this.request<ServerAgentList>("GET", "/api/agents");
    return {
      agents: body.agents ?? [],
      scopes: body.scopes ?? [],
      defaultScopes: body.defaultScopes ?? [],
    };
  }

  /** Create an agent identity. */
  async createAgent(input: {
    name: string;
    description?: string | null;
  }): Promise<ServerAgent> {
    const body = await this.request<{ agent: ServerAgent }>(
      "POST",
      "/api/agents",
      input,
    );
    return body.agent;
  }

  /** Rename an agent, or change its description. */
  async renameAgent(
    agentId: string,
    changes: { name?: string; description?: string | null },
  ): Promise<ServerAgent> {
    const body = await this.request<{ agent: ServerAgent }>(
      "PATCH",
      `/api/agents/${encodeURIComponent(agentId)}`,
      changes,
    );
    return body.agent;
  }

  /** Disable an agent, invalidating every one of its credentials at once. */
  async disableAgent(agentId: string): Promise<ServerAgent> {
    const body = await this.request<{ agent: ServerAgent }>(
      "DELETE",
      `/api/agents/${encodeURIComponent(agentId)}`,
    );
    return body.agent;
  }

  /** Re-enable a disabled agent. */
  async enableAgent(agentId: string): Promise<ServerAgent> {
    const body = await this.request<{ agent: ServerAgent }>(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/enable`,
    );
    return body.agent;
  }

  /** Every credential of an agent, with the offered scope vocabulary. */
  async listCredentials(agentId: string): Promise<ServerCredentialList> {
    const body = await this.request<ServerCredentialList>(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}/credentials`,
    );
    return {
      credentials: body.credentials ?? [],
      scopes: body.scopes ?? [],
      defaultScopes: body.defaultScopes ?? [],
    };
  }

  /**
   * Create a credential and return its one-time plaintext.
   *
   * The secret is in the return value and nowhere else: it is the caller's job
   * to show it, and this class never stores, logs or caches it.
   */
  async createCredential(
    agentId: string,
    input: {
      name: string;
      scopes: readonly string[];
      expiresAt?: string | null;
      allowedProjectIds?: readonly string[] | null;
    },
  ): Promise<CreatedServerCredential> {
    return this.request<CreatedServerCredential>(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/credentials`,
      input,
    );
  }

  /** Rotate a credential: mint a replacement and revoke the old one. */
  async rotateCredential(
    agentId: string,
    credentialId: string,
  ): Promise<CreatedServerCredential & { replacedCredentialId: string }> {
    return this.request<
      CreatedServerCredential & { replacedCredentialId: string }
    >(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}/rotate`,
    );
  }

  /** Revoke a credential. It stops authenticating immediately. */
  async revokeCredential(agentId: string, credentialId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}`,
    );
  }

  /**
   * Send one request and unwrap its JSON envelope.
   *
   * @throws {ApiError} when the server refused the request.
   * @throws {NetworkError} when no answer arrived at all.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        cache: "no-store",
        // The session is a cookie, and the cookie is HttpOnly: the browser
        // attaches it, JavaScript never sees it.
        credentials: "same-origin",
        headers:
          body === undefined
            ? { accept: "application/json" }
            : {
                accept: "application/json",
                "content-type": "application/json",
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new NetworkError(
        "The server could not be reached. Check your connection and try again.",
        error,
      );
    }

    if (!response.ok) {
      throw apiErrorFromResponse(response.status, await readJson(response));
    }

    // 204 and an empty body are both legal answers for a mutation that carries
    // nothing back; a caller asking for a value would fail loudly on `undefined`
    // rather than silently reading a shape that was never sent.
    if (response.status === 204) return undefined as T;
    const parsed = await readJson(response);
    return parsed as T;
  }
}

/** Read a response body as JSON, tolerating an empty or malformed one. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
