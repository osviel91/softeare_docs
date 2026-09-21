/**
 * Personal access tokens, the screen (Phase 5E).
 *
 * A small settings surface, not a settings system: list your tokens, mint one
 * with a scope, copy its secret exactly once, and revoke one. Everything the
 * screen does is a call into {@link usePersonalAccessTokens}; it owns no rule.
 *
 * ## The plaintext is never persisted
 *
 * A created secret lives in one `useState` variable for as long as the panel is
 * on screen and is discarded when the user dismisses it or leaves the page. It
 * is never written to `localStorage`, `sessionStorage`, the URL, or a module
 * variable, and the client that produced it does not keep it either. The panel
 * says so in as many words, because a user who expects to find it later will
 * otherwise treat a revoke-and-recreate as a bug.
 *
 * ## It is also the MCP connection screen
 *
 * The same page explains how to point a remote MCP client at this server: the
 * endpoint, the bearer scheme, and an example configuration whose token is a
 * literal placeholder. The user's real token is never interpolated into the
 * example or a URL.
 */
import { useEffect, useState } from "react";
import type { ServerApiClient } from "../../workspace/server/api-client";
import type { AuthHook } from "./use-auth";
import { usePersonalAccessTokens } from "./use-personal-access-tokens";

/** The expiry choices the form offers. */
const EXPIRY_CHOICES = [
  { id: "never", label: "No expiry", days: null },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "365", label: "1 year", days: 365 },
] as const;

/** Convert an expiry choice into the ISO value the API expects. */
function expiresAtFor(choice: string): string | null {
  const found = EXPIRY_CHOICES.find((entry) => entry.id === choice);
  if (!found || found.days === null) return null;
  return new Date(Date.now() + found.days * 24 * 60 * 60 * 1000).toISOString();
}

/** A short human description of a scope. */
function scopeHint(scope: string): string {
  if (scope === "projects:write") return "Read and change documents";
  if (scope === "projects:read") return "Read documents only";
  return scope;
}

/** Format an ISO timestamp, or a dash. */
function when(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** Props for {@link PersonalAccessTokens}. */
export interface PersonalAccessTokensProps {
  client: ServerApiClient;
  auth: AuthHook;
  /** Leave the page and return to the workspace. */
  onBack: () => void;
}

export default function PersonalAccessTokens({
  client,
  auth,
  onBack,
}: PersonalAccessTokensProps) {
  const tokens = usePersonalAccessTokens(client, auth);
  const [name, setName] = useState("My agent");
  const [selected, setSelected] = useState<string[]>(["projects:read"]);
  const [expiry, setExpiry] = useState<string>("never");
  const [created, setCreated] = useState<{
    secret: string;
    id: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // The scope vocabulary belongs to the server; default to the read scope once
  // it is known, without overwriting a choice the user already made.
  useEffect(() => {
    setSelected((current) =>
      current.length === 0 && tokens.scopes.length > 0
        ? [tokens.scopes[0]]
        : current,
    );
  }, [tokens.scopes]);

  const toggleScope = (scope: string): void => {
    setSelected((current) =>
      current.includes(scope)
        ? current.filter((entry) => entry !== scope)
        : [...current, scope],
    );
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const answer = await tokens.create({
        name,
        scopes: selected,
        expiresAt: expiresAtFor(expiry),
      });
      // The secret is held for display only; it never leaves this component.
      setCreated({ secret: answer.secret, id: answer.token.id });
      setCopied(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The token could not be created.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (created === null) return;
    try {
      await navigator.clipboard?.writeText(created.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const revoke = async (tokenId: string): Promise<void> => {
    setError(null);
    try {
      await tokens.revoke(tokenId);
      setPendingRevoke(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The token could not be revoked.",
      );
    }
  };

  const commitRename = async (tokenId: string): Promise<void> => {
    setError(null);
    try {
      await tokens.rename(tokenId, renameValue);
      setRenaming(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The token could not be renamed.",
      );
    }
  };

  if (auth.status !== "authenticated") {
    return (
      <main
        className="tokens"
        data-testid="tokens-page"
        aria-label="Access tokens"
      >
        <header className="tokens__header">
          <div>
            <p className="tokens__eyebrow">Settings</p>
            <h1 className="tokens__title">Personal access tokens</h1>
          </div>
          <button
            type="button"
            className="button"
            data-testid="tokens-back"
            onClick={onBack}
          >
            ← Back to workspace
          </button>
        </header>
        <p className="tokens__lead" data-testid="tokens-signin-required">
          Sign in to create or revoke personal access tokens.
        </p>
        <button
          type="button"
          className="button button--primary"
          data-testid="tokens-signin"
          onClick={auth.signIn}
        >
          Sign in
        </button>
      </main>
    );
  }

  return (
    <main
      className="tokens"
      data-testid="tokens-page"
      aria-label="Access tokens"
    >
      <header className="tokens__header">
        <div>
          <p className="tokens__eyebrow">Settings</p>
          <h1 className="tokens__title">Personal access tokens</h1>
          <p className="tokens__lead">
            Machine credentials for remote MCP clients and other tools. A token
            acts as you, inside the projects you belong to, and can be revoked
            at any time.
          </p>
        </div>
        <button
          type="button"
          className="button"
          data-testid="tokens-back"
          onClick={onBack}
        >
          ← Back to workspace
        </button>
      </header>

      <section className="tokens__panel" aria-label="Create a token">
        <h2 className="tokens__heading">Create a token</h2>
        <div className="tokens__row">
          <label className="tokens__field">
            <span>Name</span>
            <input
              type="text"
              data-testid="token-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="tokens__field">
            <span>Expiry</span>
            <select
              data-testid="token-expiry"
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
          {tokens.scopes.map((scope) => (
            <label key={scope} className="tokens__scope">
              <input
                type="checkbox"
                data-testid={`token-scope-${scope}`}
                checked={selected.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              <span>
                <code>{scope}</code> — {scopeHint(scope)}
              </span>
            </label>
          ))}
        </fieldset>

        <button
          type="button"
          className="button button--primary"
          data-testid="token-create"
          disabled={busy || name.trim() === "" || selected.length === 0}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? "Creating…" : "Create token"}
        </button>

        {error !== null ? (
          <p className="tokens__error" role="alert" data-testid="token-error">
            {error}
          </p>
        ) : null}
      </section>

      {created !== null ? (
        <section
          className="tokens__secret"
          aria-label="New token secret"
          data-testid="token-secret-panel"
        >
          <h2 className="tokens__heading">Copy your token now</h2>
          <p className="tokens__warning">
            This is the only time it is shown. It is not stored on the server in
            a readable form, and it cannot be retrieved again — if you lose it,
            revoke it and create another.
          </p>
          <div className="tokens__secret-row">
            <input
              type="text"
              readOnly
              className="tokens__secret-value"
              data-testid="token-secret"
              value={created.secret}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="button button--primary"
              data-testid="token-copy"
              onClick={() => {
                void copy();
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="button"
              data-testid="token-dismiss"
              onClick={() => setCreated(null)}
            >
              I saved it
            </button>
          </div>
        </section>
      ) : null}

      <section className="tokens__panel" aria-label="Your tokens">
        <h2 className="tokens__heading">Your tokens</h2>
        {tokens.loading ? (
          <p data-testid="tokens-loading">Loading…</p>
        ) : tokens.tokens.length === 0 ? (
          <p data-testid="tokens-empty">You have no access tokens yet.</p>
        ) : (
          <table className="tokens__table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.tokens.map((token) => (
                <tr
                  key={token.id}
                  data-testid={`token-row-${token.id}`}
                  className={token.revoked ? "tokens__row--revoked" : undefined}
                >
                  <td>
                    {renaming === token.id ? (
                      <input
                        type="text"
                        data-testid={`token-rename-input-${token.id}`}
                        value={renameValue}
                        maxLength={100}
                        onChange={(event) => setRenameValue(event.target.value)}
                      />
                    ) : (
                      <span data-testid={`token-name-${token.id}`}>
                        {token.name}
                        {token.revoked ? " (revoked)" : ""}
                      </span>
                    )}
                  </td>
                  <td>
                    <code>{token.scopes.join(", ")}</code>
                  </td>
                  <td>{when(token.createdAt)}</td>
                  <td>{when(token.lastUsedAt)}</td>
                  <td>{when(token.expiresAt)}</td>
                  <td className="tokens__actions">
                    {renaming === token.id ? (
                      <>
                        <button
                          type="button"
                          className="button"
                          data-testid={`token-rename-save-${token.id}`}
                          onClick={() => {
                            void commitRename(token.id);
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
                        data-testid={`token-rename-${token.id}`}
                        disabled={token.revoked}
                        onClick={() => {
                          setRenaming(token.id);
                          setRenameValue(token.name);
                        }}
                      >
                        Rename
                      </button>
                    )}
                    {token.revoked ? null : pendingRevoke === token.id ? (
                      <>
                        <button
                          type="button"
                          className="button button--danger"
                          data-testid={`token-revoke-confirm-${token.id}`}
                          onClick={() => {
                            void revoke(token.id);
                          }}
                        >
                          Confirm revoke
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => setPendingRevoke(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="button"
                        data-testid={`token-revoke-${token.id}`}
                        onClick={() => setPendingRevoke(token.id)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
    "sequencediagrams": {
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
        <code data-testid="mcp-endpoint">{endpoint}</code>. Authenticate with a
        personal access token as a bearer credential — the same token you
        created above, copied into the client's configuration.
      </p>
      <pre className="tokens__code" data-testid="mcp-config-example">
        {example}
      </pre>
      <p className="tokens__note">
        The token is a machine credential, not a browser session. It is sent
        only in the <code>Authorization</code> header by the client; this page
        never puts it in a URL or in stored configuration.
      </p>
    </section>
  );
}
