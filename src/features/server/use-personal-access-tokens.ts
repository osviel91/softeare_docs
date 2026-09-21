/**
 * Personal access token management state (Phase 5E).
 *
 * The hook owns the token *metadata* the screen renders and the two mutations
 * the screen performs. It deliberately does not own the one-time plaintext: a
 * created secret is returned to the caller, shown once, and never held here —
 * no state variable, no cache, no storage — so a re-render, a reload or a
 * navigation can never bring it back.
 *
 * Management is available only to an authenticated session. When the session
 * ends the list is dropped, exactly as the server project list is: a token
 * screen showing another person's credentials after a sign-out is a bug, not a
 * stale render.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreatedPersonalAccessToken,
  PersonalAccessToken,
  ServerApiClient,
} from "../../workspace/server/api-client";
import type { AuthState } from "./use-auth";

/** The token list and the operations the screen can perform. */
export interface PersonalAccessTokensHook {
  tokens: PersonalAccessToken[];
  /** The scope vocabulary the server accepts, as it reports it. */
  scopes: string[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /**
   * Create a token. The resolved value is the only place its plaintext exists;
   * the caller must show it and then discard it.
   */
  create(input: {
    name: string;
    scopes: readonly string[];
    expiresAt?: string | null;
  }): Promise<CreatedPersonalAccessToken>;
  rename(tokenId: string, name: string): Promise<void>;
  revoke(tokenId: string): Promise<void>;
}

/**
 * Track the caller's personal access tokens.
 *
 * @param client - The API client, shared with the rest of the app.
 * @param auth - The session state; the list is loaded only when signed in.
 */
export function usePersonalAccessTokens(
  client: ServerApiClient,
  auth: AuthState,
): PersonalAccessTokensHook {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards a state update after unmount and a stale list overwriting a newer
  // one when the screen is opened twice quickly.
  const ticket = useRef(0);
  const authenticated = auth.status === "authenticated";

  const refresh = useCallback(async (): Promise<void> => {
    if (!authenticated) {
      setTokens([]);
      setScopes([]);
      setError(null);
      return;
    }
    const mine = (ticket.current += 1);
    setLoading(true);
    setError(null);
    try {
      const answer = await client.listTokens();
      if (ticket.current !== mine) return;
      setTokens(answer.tokens);
      setScopes(answer.scopes);
    } catch (failure) {
      if (ticket.current !== mine) return;
      setTokens([]);
      setError(
        failure instanceof Error
          ? failure.message
          : "The access tokens could not be loaded.",
      );
    } finally {
      if (ticket.current === mine) setLoading(false);
    }
  }, [client, authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Losing the session clears the list rather than leaving one person's token
  // names on screen for the next person at the browser.
  useEffect(() => {
    if (!authenticated) {
      ticket.current += 1;
      setTokens([]);
      setScopes([]);
      setError(null);
      setLoading(false);
    }
  }, [authenticated]);

  const create = useCallback(
    async (input: {
      name: string;
      scopes: readonly string[];
      expiresAt?: string | null;
    }): Promise<CreatedPersonalAccessToken> => {
      const created = await client.createToken(input);
      await refresh();
      return created;
    },
    [client, refresh],
  );

  const rename = useCallback(
    async (tokenId: string, name: string): Promise<void> => {
      await client.renameToken(tokenId, name);
      await refresh();
    },
    [client, refresh],
  );

  const revoke = useCallback(
    async (tokenId: string): Promise<void> => {
      await client.revokeToken(tokenId);
      await refresh();
    },
    [client, refresh],
  );

  return {
    tokens,
    scopes,
    loading,
    error,
    refresh,
    create,
    rename,
    revoke,
  };
}
