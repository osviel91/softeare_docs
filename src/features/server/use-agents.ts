/**
 * Agent and credential management state (ADR-043).
 *
 * The hook owns the *metadata* the settings screen renders and the mutations it
 * performs. It deliberately does not own the one-time plaintext: a created or
 * rotated secret is returned to the caller, shown once, and never held here —
 * no state variable, no cache, no storage — so a re-render, a reload or a
 * navigation can never bring it back.
 *
 * Management is available only to an authenticated session. When the session
 * ends the lists are dropped, exactly as the server project list is: a settings
 * screen showing another person's agents after a sign-out is a bug, not a stale
 * render.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreatedServerCredential,
  ServerAgent,
  ServerApiClient,
  ServerCredential,
} from "../../workspace/server/api-client";
import type { AuthState } from "./use-auth";

/** The agent list, the credentials seen so far, and the mutations. */
export interface AgentsHook {
  agents: ServerAgent[];
  /** The scope vocabulary the server offers for a new credential. */
  scopes: string[];
  /** The conservative scopes a new credential starts from. */
  defaultScopes: string[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  createAgent(input: {
    name: string;
    description?: string | null;
  }): Promise<ServerAgent>;
  renameAgent(
    agentId: string,
    changes: { name?: string; description?: string | null },
  ): Promise<void>;
  setDisabled(agentId: string, disabled: boolean): Promise<void>;
  /** Credentials loaded for one agent, or `null` when not loaded yet. */
  credentialsOf(agentId: string): ServerCredential[] | null;
  loadCredentials(agentId: string): Promise<void>;
  createCredential(
    agentId: string,
    input: {
      name: string;
      scopes: readonly string[];
      expiresAt?: string | null;
      allowedProjectIds?: readonly string[] | null;
    },
  ): Promise<CreatedServerCredential>;
  rotateCredential(
    agentId: string,
    credentialId: string,
  ): Promise<CreatedServerCredential>;
  revokeCredential(agentId: string, credentialId: string): Promise<void>;
}

/**
 * Track the caller's agents and their credentials.
 *
 * @param client - The API client, shared with the rest of the app.
 * @param auth - The session state; the list is loaded only when signed in.
 */
export function useAgents(
  client: ServerApiClient,
  auth: AuthState,
): AgentsHook {
  const [agents, setAgents] = useState<ServerAgent[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [defaultScopes, setDefaultScopes] = useState<string[]>([]);
  const [credentials, setCredentials] = useState<
    Record<string, ServerCredential[]>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards a state update after unmount and a stale list overwriting a newer
  // one when the screen is opened twice quickly.
  const ticket = useRef(0);
  const authenticated = auth.status === "authenticated";

  const refresh = useCallback(async (): Promise<void> => {
    if (!authenticated) {
      setAgents([]);
      setCredentials({});
      setError(null);
      return;
    }
    const mine = (ticket.current += 1);
    setLoading(true);
    setError(null);
    try {
      const answer = await client.listAgents();
      if (ticket.current !== mine) return;
      setAgents(answer.agents);
      setScopes(answer.scopes);
      setDefaultScopes(answer.defaultScopes);
    } catch (failure) {
      if (ticket.current !== mine) return;
      setAgents([]);
      setError(
        failure instanceof Error
          ? failure.message
          : "The agents could not be loaded.",
      );
    } finally {
      if (ticket.current === mine) setLoading(false);
    }
  }, [client, authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Losing the session clears the lists rather than leaving one person's agent
  // names on screen for the next person at the browser.
  useEffect(() => {
    if (!authenticated) {
      ticket.current += 1;
      setAgents([]);
      setCredentials({});
      setError(null);
      setLoading(false);
    }
  }, [authenticated]);

  const loadCredentials = useCallback(
    async (agentId: string): Promise<void> => {
      const answer = await client.listCredentials(agentId);
      setCredentials((current) => ({
        ...current,
        [agentId]: answer.credentials,
      }));
    },
    [client],
  );

  const createAgent = useCallback(
    async (input: { name: string; description?: string | null }) => {
      const created = await client.createAgent(input);
      await refresh();
      return created;
    },
    [client, refresh],
  );

  const renameAgent = useCallback(
    async (
      agentId: string,
      changes: { name?: string; description?: string | null },
    ): Promise<void> => {
      await client.renameAgent(agentId, changes);
      await refresh();
    },
    [client, refresh],
  );

  const setDisabled = useCallback(
    async (agentId: string, disabled: boolean): Promise<void> => {
      if (disabled) await client.disableAgent(agentId);
      else await client.enableAgent(agentId);
      await refresh();
      await loadCredentials(agentId).catch(() => {});
    },
    [client, refresh, loadCredentials],
  );

  const createCredential = useCallback(
    async (
      agentId: string,
      input: {
        name: string;
        scopes: readonly string[];
        expiresAt?: string | null;
        allowedProjectIds?: readonly string[] | null;
      },
    ): Promise<CreatedServerCredential> => {
      const created = await client.createCredential(agentId, input);
      await refresh();
      await loadCredentials(agentId).catch(() => {});
      return created;
    },
    [client, refresh, loadCredentials],
  );

  const rotateCredential = useCallback(
    async (
      agentId: string,
      credentialId: string,
    ): Promise<CreatedServerCredential> => {
      const rotated = await client.rotateCredential(agentId, credentialId);
      await loadCredentials(agentId).catch(() => {});
      return rotated;
    },
    [client, loadCredentials],
  );

  const revokeCredential = useCallback(
    async (agentId: string, credentialId: string): Promise<void> => {
      await client.revokeCredential(agentId, credentialId);
      await loadCredentials(agentId).catch(() => {});
      await refresh();
    },
    [client, refresh, loadCredentials],
  );

  const credentialsOf = useCallback(
    (agentId: string): ServerCredential[] | null =>
      credentials[agentId] ?? null,
    [credentials],
  );

  return {
    agents,
    scopes,
    defaultScopes,
    loading,
    error,
    refresh,
    createAgent,
    renameAgent,
    setDisabled,
    credentialsOf,
    loadCredentials,
    createCredential,
    rotateCredential,
    revokeCredential,
  };
}
