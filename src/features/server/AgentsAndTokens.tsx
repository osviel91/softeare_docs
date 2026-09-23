/**
 * Agents and access tokens, the screen (ADR-043).
 *
 * A small settings surface, not a settings system: create an agent, give it a
 * credential with a scope and optional expiry and project restriction, copy the
 * secret exactly once, and revoke or rotate it. Everything the screen does is a
 * call into {@link useAgents}; it owns no rule.
 *
 * ## The plaintext is never persisted
 *
 * A created or rotated secret lives in one `useState` variable for as long as
 * the panel is on screen and is discarded when the user dismisses it or leaves
 * the page. It is never written to `localStorage`, `sessionStorage`, the URL, or
 * a module variable, and the client that produced it does not keep it either.
 * The panel says so in as many words.
 *
 * ## It is also the MCP connection screen
 *
 * The same page explains how to point a remote MCP client at this server: the
 * endpoint, the bearer scheme, and an example configuration whose token is a
 * literal placeholder. The user's real token is never interpolated into the
 * example or a URL.
 */
import { useEffect, useState } from "react";
import type {
  ServerApiClient,
  ServerCredential,
  ServerProject,
} from "../../workspace/server/api-client";
import type { AuthHook } from "./use-auth";
import { useAgents } from "./use-agents";

/** The expiry choices the form offers. */
const EXPIRY_CHOICES = [
  { id: "never", label: "No expiry", days: null },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days (recommended)", days: 90 },
  { id: "365", label: "1 year", days: 365 },
] as const;

/** Convert an expiry choice into the ISO value the API expects. */
function expiresAtFor(choice: string): string | null {
  const found = EXPIRY_CHOICES.find((entry) => entry.id === choice);
  if (!found || found.days === null) return null;
  return new Date(Date.now() + found.days * 24 * 60 * 60 * 1000).toISOString();
}

/** A short human description of a credential scope. */
function scopeLabel(scope: string): string {
  switch (scope) {
    case "project:read":
      return "Read projects";
    case "project:create":
      return "Create projects";
    case "project:update":
      return "Rename projects";
    case "resource:read":
      return "Read resources";
    case "resource:write":
      return "Write resources (create, update, move, delete)";
    case "resource:create":
      return "Create resources";
    case "resource:update":
      return "Update resources";
    case "resource:move":
      return "Move resources";
    case "resource:delete":
      return "Delete resources";
    case "diagram:render":
      return "Render diagrams";
    case "project:search":
      return "Search";
    case "project:validate":
      return "Validate";
    case "project:export":
      return "Export";
    default:
      return scope;
  }
}

/** Format an ISO timestamp, or a dash. */
function when(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** Describe whether a credential inherits all owner-visible projects or narrows them. */
function projectAccess(
  credential: ServerCredential,
  projects: readonly ServerProject[],
): string {
  if (credential.allowedProjectIds === null) {
    return "All accessible server projects";
  }
  const names = credential.allowedProjectIds.flatMap((id) => {
    const project = projects.find((entry) => entry.id === id);
    return project === undefined ? [] : [project.name];
  });
  return names.length > 0
    ? names.join(", ")
    : `${credential.allowedProjectIds.length} selected project${credential.allowedProjectIds.length === 1 ? "" : "s"}`;
}

/** Props for {@link AgentsAndTokens}. */
export interface AgentsAndTokensProps {
  client: ServerApiClient;
  auth: AuthHook;
  /** Leave the page and return to the workspace. */
  onBack: () => void;
}

export default function AgentsAndTokens({
  client,
  auth,
  onBack,
}: AgentsAndTokensProps) {
  const agents = useAgents(client, auth);
  const [agentName, setAgentName] = useState("Hermes Documentation");
  const [agentDescription, setAgentDescription] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [credentialName, setCredentialName] = useState("MacMini");
  const [expiry, setExpiry] = useState<string>("90");
  const [allowedProjects, setAllowedProjects] = useState<string[]>([]);
  const [projects, setProjects] = useState<ServerProject[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    secret: string;
    label: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The default scope set is the server's, not the screen's.
  useEffect(() => {
    setSelectedScopes((current) =>
      current.length === 0 ? [...agents.defaultScopes] : current,
    );
  }, [agents.defaultScopes]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    let cancelled = false;
    client
      .listWorkspaces()
      .then((workspaces) =>
        Promise.all(
          workspaces.map((workspace) => client.listProjects(workspace.id)),
        ),
      )
      .then((lists) => {
        const listed = lists.flat();
        if (!cancelled) setProjects(listed);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, auth.status]);

  const toggle = (
    value: string,
    list: string[],
    set: (next: string[]) => void,
  ): void => {
    set(
      list.includes(value)
        ? list.filter((entry) => entry !== value)
        : [...list, value],
    );
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The operation failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const expand = (agentId: string): void => {
    setExpanded((current) => (current === agentId ? null : agentId));
    void run(() => agents.loadCredentials(agentId));
  };

  if (auth.status !== "authenticated") {
    return (
      <main className="tokens" data-testid="agents-page" aria-label="Agents">
        <header className="tokens__header">
          <div>
            <p className="tokens__eyebrow">Settings</p>
            <h1 className="tokens__title">Agents &amp; access tokens</h1>
          </div>
          <button
            type="button"
            className="button"
            data-testid="agents-back"
            onClick={onBack}
          >
            ← Back to workspace
          </button>
        </header>
        <p className="tokens__lead" data-testid="agents-signin-required">
          Sign in to create or revoke agent credentials.
        </p>
        <button
          type="button"
          className="button button--primary"
          data-testid="agents-signin"
          onClick={auth.signIn}
        >
          Sign in
        </button>
      </main>
    );
  }

  return (
    <main className="tokens" data-testid="agents-page" aria-label="Agents">
      <header className="tokens__header">
        <div>
          <p className="tokens__eyebrow">Settings</p>
          <h1 className="tokens__title">Agents &amp; access tokens</h1>
          <p className="tokens__lead">
            An agent is a named automation that acts on your behalf. Give it one
            credential per machine, restrict what each may do, and revoke any of
            them at any time. Agents never hold authority you do not have.
          </p>
        </div>
        <button
          type="button"
          className="button"
          data-testid="agents-back"
          onClick={onBack}
        >
          ← Back to workspace
        </button>
      </header>

      {created !== null ? (
        <section
          className="tokens__secret"
          aria-label="New credential secret"
          data-testid="credential-secret-panel"
        >
          <h2 className="tokens__heading">Copy your credential now</h2>
          <p className="tokens__warning">
            This is the only time it is shown. It is not stored on the server in
            a readable form, and it cannot be retrieved again — if you lose it,
            rotate it and create another.
          </p>
          <div className="tokens__secret-row">
            <input
              type="text"
              readOnly
              className="tokens__secret-value"
              data-testid="credential-secret"
              value={created.secret}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="button button--primary"
              data-testid="credential-copy"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(created.secret)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="button"
              data-testid="credential-dismiss"
              onClick={() => setCreated(null)}
            >
              I saved it
            </button>
          </div>
        </section>
      ) : null}

      <section className="tokens__panel" aria-label="Create an agent">
        <h2 className="tokens__heading">Create an agent</h2>
        <div className="tokens__row">
          <label className="tokens__field">
            <span>Name</span>
            <input
              type="text"
              data-testid="agent-name"
              value={agentName}
              maxLength={100}
              onChange={(event) => setAgentName(event.target.value)}
            />
          </label>
          <label className="tokens__field tokens__field--wide">
            <span>Description</span>
            <input
              type="text"
              data-testid="agent-description"
              value={agentDescription}
              maxLength={500}
              onChange={(event) => setAgentDescription(event.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          className="button button--primary"
          data-testid="agent-create"
          disabled={busy || agentName.trim() === ""}
          onClick={() => {
            void run(async () => {
              await agents.createAgent({
                name: agentName,
                description:
                  agentDescription.trim() === "" ? null : agentDescription,
              });
              setAgentDescription("");
            });
          }}
        >
          Create agent
        </button>
        {error !== null ? (
          <p className="tokens__error" role="alert" data-testid="agents-error">
            {error}
          </p>
        ) : null}
      </section>

      <section className="tokens__panel" aria-label="Your agents">
        <h2 className="tokens__heading">Your agents</h2>
        {agents.loading ? (
          <p data-testid="agents-loading">Loading…</p>
        ) : agents.agents.length === 0 ? (
          <p data-testid="agents-empty">You have no agents yet.</p>
        ) : (
          <ul className="agents__list">
            {agents.agents.map((agent) => {
              const credentials = agents.credentialsOf(agent.id);
              return (
                <li
                  key={agent.id}
                  className="tokens__panel agents__card"
                  data-testid={`agent-${agent.id}`}
                >
                  <div className="agents__card-header">
                    <div>
                      {renaming === agent.id ? (
                        <input
                          type="text"
                          data-testid={`agent-rename-input-${agent.id}`}
                          value={renameValue}
                          maxLength={100}
                          onChange={(event) =>
                            setRenameValue(event.target.value)
                          }
                        />
                      ) : (
                        <strong data-testid={`agent-name-${agent.id}`}>
                          {agent.name}
                        </strong>
                      )}
                      <span
                        className="agents__status"
                        data-testid={`agent-status-${agent.id}`}
                      >
                        {agent.disabled ? "disabled" : "active"}
                      </span>
                      <p className="tokens__note">
                        {agent.description ?? "No description."} ·{" "}
                        {agent.credentialCount ?? 0} credentials (
                        {agent.activeCredentialCount ?? 0} active)
                      </p>
                    </div>
                    <div className="tokens__actions">
                      {renaming === agent.id ? (
                        <>
                          <button
                            type="button"
                            className="button"
                            data-testid={`agent-rename-save-${agent.id}`}
                            onClick={() => {
                              void run(async () => {
                                await agents.renameAgent(agent.id, {
                                  name: renameValue,
                                });
                                setRenaming(null);
                              });
                            }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="button"
                            onClick={() => setRenaming(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="button"
                          data-testid={`agent-rename-${agent.id}`}
                          onClick={() => {
                            setRenaming(agent.id);
                            setRenameValue(agent.name);
                          }}
                        >
                          Rename
                        </button>
                      )}
                      <button
                        type="button"
                        className="button"
                        data-testid={`agent-toggle-${agent.id}`}
                        onClick={() => {
                          void run(() =>
                            agents.setDisabled(agent.id, !agent.disabled),
                          );
                        }}
                      >
                        {agent.disabled ? "Enable" : "Disable"}
                      </button>
                      <button
                        type="button"
                        className="button"
                        data-testid={`agent-credentials-${agent.id}`}
                        onClick={() => expand(agent.id)}
                      >
                        {expanded === agent.id
                          ? "Hide credentials"
                          : "Credentials"}
                      </button>
                    </div>
                  </div>

                  {expanded === agent.id ? (
                    <div
                      className="agents__credentials"
                      data-testid={`agent-credentials-panel-${agent.id}`}
                    >
                      {credentials === null ? (
                        <p>Loading…</p>
                      ) : credentials.length === 0 ? (
                        <p data-testid={`credentials-empty-${agent.id}`}>
                          No credentials yet.
                        </p>
                      ) : (
                        <table className="tokens__table">
                          <thead>
                            <tr>
                              <th scope="col">Name</th>
                              <th scope="col">Scopes</th>
                              <th scope="col">Project access</th>
                              <th scope="col">Created</th>
                              <th scope="col">Last used</th>
                              <th scope="col">Expires</th>
                              <th scope="col">Status</th>
                              <th scope="col">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {credentials.map((credential) => (
                              <tr
                                key={credential.id}
                                data-testid={`credential-${credential.id}`}
                                className={
                                  credential.status === "active"
                                    ? undefined
                                    : "tokens__row--revoked"
                                }
                              >
                                <td>{credential.name}</td>
                                <td>
                                  <code>{credential.scopes.join(", ")}</code>
                                </td>
                                <td
                                  data-testid={`credential-project-access-${credential.id}`}
                                >
                                  {projectAccess(credential, projects)}
                                </td>
                                <td>{when(credential.createdAt)}</td>
                                <td>{when(credential.lastUsedAt)}</td>
                                <td>{when(credential.expiresAt)}</td>
                                <td
                                  data-testid={`credential-status-${credential.id}`}
                                >
                                  {credential.status}
                                </td>
                                <td className="tokens__actions">
                                  {credential.status === "revoked" ? null : (
                                    <>
                                      <button
                                        type="button"
                                        className="button"
                                        data-testid={`credential-rotate-${credential.id}`}
                                        disabled={busy}
                                        onClick={() => {
                                          void run(async () => {
                                            const rotated =
                                              await agents.rotateCredential(
                                                agent.id,
                                                credential.id,
                                              );
                                            setCreated({
                                              secret: rotated.secret,
                                              label: credential.name,
                                            });
                                            setCopied(false);
                                          });
                                        }}
                                      >
                                        Rotate
                                      </button>
                                      {pendingRevoke === credential.id ? (
                                        <>
                                          <button
                                            type="button"
                                            className="button button--danger"
                                            data-testid={`credential-revoke-confirm-${credential.id}`}
                                            onClick={() => {
                                              void run(async () => {
                                                await agents.revokeCredential(
                                                  agent.id,
                                                  credential.id,
                                                );
                                                setPendingRevoke(null);
                                              });
                                            }}
                                          >
                                            Confirm revoke
                                          </button>
                                          <button
                                            type="button"
                                            className="button"
                                            onClick={() =>
                                              setPendingRevoke(null)
                                            }
                                          >
                                            Cancel
                                          </button>
                                        </>
                                      ) : (
                                        <button
                                          type="button"
                                          className="button"
                                          data-testid={`credential-revoke-${credential.id}`}
                                          onClick={() =>
                                            setPendingRevoke(credential.id)
                                          }
                                        >
                                          Revoke
                                        </button>
                                      )}
                                    </>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      <h3 className="tokens__heading">New credential</h3>
                      <div className="tokens__row">
                        <label className="tokens__field">
                          <span>Credential name</span>
                          <input
                            type="text"
                            data-testid={`credential-name-${agent.id}`}
                            value={credentialName}
                            maxLength={100}
                            onChange={(event) =>
                              setCredentialName(event.target.value)
                            }
                          />
                        </label>
                        <label className="tokens__field">
                          <span>Expiry</span>
                          <select
                            data-testid={`credential-expiry-${agent.id}`}
                            value={expiry}
                            onChange={(event) => setExpiry(event.target.value)}
                          >
                            {EXPIRY_CHOICES.map((choice) => (
                              <option key={choice.id} value={choice.id}>
                                {choice.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <fieldset className="tokens__scopes">
                        <legend>Scopes</legend>
                        {agents.scopes.map((scope) => (
                          <label key={scope} className="tokens__scope">
                            <input
                              type="checkbox"
                              data-testid={`credential-scope-${scope}`}
                              checked={selectedScopes.includes(scope)}
                              onChange={() =>
                                toggle(scope, selectedScopes, setSelectedScopes)
                              }
                            />
                            <span>{scopeLabel(scope)}</span>
                          </label>
                        ))}
                      </fieldset>

                      <fieldset className="tokens__scopes">
                        <legend>Project access</legend>
                        {projects.length === 0 ? (
                          <p data-testid="credential-projects-empty">
                            This credential will automatically access every
                            server project you own or join. Local browser and
                            folder projects are not available to remote MCP. Use
                            Back to workspace, then create a project in the
                            Server section.
                          </p>
                        ) : (
                          <>
                            <p>
                              Leave every project unticked to allow every server
                              project you can access. Select projects only to
                              restrict this credential.
                            </p>
                            {projects.map((project) => (
                              <label key={project.id} className="tokens__scope">
                                <input
                                  type="checkbox"
                                  data-testid={`credential-project-${project.id}`}
                                  checked={allowedProjects.includes(project.id)}
                                  onChange={() =>
                                    toggle(
                                      project.id,
                                      allowedProjects,
                                      setAllowedProjects,
                                    )
                                  }
                                />
                                <span>{project.name}</span>
                              </label>
                            ))}
                          </>
                        )}
                      </fieldset>

                      <button
                        type="button"
                        className="button button--primary"
                        data-testid={`credential-create-${agent.id}`}
                        disabled={
                          busy ||
                          credentialName.trim() === "" ||
                          selectedScopes.length === 0
                        }
                        onClick={() => {
                          void run(async () => {
                            const createdCredential =
                              await agents.createCredential(agent.id, {
                                name: credentialName,
                                scopes: selectedScopes,
                                expiresAt: expiresAtFor(expiry),
                                allowedProjectIds:
                                  allowedProjects.length === 0
                                    ? null
                                    : allowedProjects,
                              });
                            setCreated({
                              secret: createdCredential.secret,
                              label: credentialName,
                            });
                            setCopied(false);
                          });
                        }}
                      >
                        Create credential
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <McpConnectionGuide />
    </main>
  );
}

/**
 * How to point a remote MCP client at this server.
 *
 * The example carries a literal `<YOUR_PAT>` placeholder and is built from
 * `window.location.origin`, never from a token. That is the one rule this panel
 * must not break: connection instructions are documentation, and documentation
 * outlives the session.
 */
function McpConnectionGuide() {
  const origin =
    typeof window === "undefined"
      ? "https://your-server"
      : window.location.origin;
  const endpoint = `${origin}/mcp`;
  const example = `{
  "mcpServers": {
    "software-docs": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer <YOUR_PAT>"
      }
    }
  }
}`;
  return (
    <section
      className="tokens__panel"
      aria-label="Connect a remote MCP client"
      data-testid="mcp-connection-guide"
    >
      <h2 className="tokens__heading">Connect a remote MCP client</h2>
      <p>
        The remote MCP endpoint is{" "}
        <code data-testid="mcp-endpoint">{endpoint}</code>. Authenticate with an
        agent credential as a bearer token — the same secret you created above,
        copied into the client's configuration.
      </p>
      <pre className="tokens__code" data-testid="mcp-config-example">
        {example}
      </pre>
      <p className="tokens__note">
        The credential is a machine credential, not a browser session. It is
        sent only in the <code>Authorization</code> header by the client; this
        page never puts it in a URL or in stored configuration.
      </p>
    </section>
  );
}
