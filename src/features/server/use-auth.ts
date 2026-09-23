/**
 * Browser authentication state.
 *
 * The browser is told who it is by the server, and it never holds a credential
 * itself: `GET /api/me` answers with the signed-in user or `null`, and the
 * session is an HttpOnly cookie the page's JavaScript cannot read. That is the
 * whole design — there is no token in a variable here to leak through a log, a
 * crash report or a stray `console.log`, and signing out is a server call that
 * revokes the session rather than a local flag a reload would undo.
 *
 * Three states, because "we have not asked yet" is genuinely different from
 * "nobody is signed in": rendering a sign-in button while the answer is still in
 * flight makes the UI flicker and misleads the user about what they can do.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AuthenticatedUser,
  ServerApiClient,
} from "../../workspace/server/api-client";

/** What the app knows about the current session. */
export interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  /** The signed-in user, present exactly when `status` is `authenticated`. */
  user: AuthenticatedUser | null;
}

/** The authentication state and the two transitions a browser can ask for. */
export interface AuthHook extends AuthState {
  /** Leave for the provider's sign-in page, returning here afterwards. */
  signIn(): void;
  /** Authenticate with a local email/password account. */
  signInLocal?: (email: string, password: string) => Promise<void>;
  /** Create a pending local account. */
  registerLocal?: (
    email: string,
    password: string,
    displayName: string,
  ) => Promise<string>;
  /** Revoke the session server-side and become anonymous. */
  signOut(): Promise<void>;
  /** Ask the server again — after a redirect back from the provider, say. */
  refresh(): Promise<void>;
}

/**
 * Track the session, asking once on mount.
 *
 * A failure to ask is treated as anonymous rather than as an error: the app must
 * still work offline and in local mode, and an unreachable `/api/me` means server
 * projects are unavailable, not that the whole application is broken.
 */
export function useAuth(client: ServerApiClient): AuthHook {
  const [state, setState] = useState<AuthState>({
    status: "loading",
    user: null,
  });
  // Guards against a state update after unmount and against a stale answer
  // overwriting a newer one when `refresh` is called twice.
  const requestRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const ticket = (requestRef.current += 1);
    try {
      const user = await client.me();
      if (requestRef.current !== ticket) return;
      setState(
        user === null
          ? { status: "anonymous", user: null }
          : { status: "authenticated", user },
      );
    } catch {
      if (requestRef.current !== ticket) return;
      setState({ status: "anonymous", user: null });
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback((): void => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(client.loginUrl(returnTo));
  }, [client]);

  const signInLocal = useCallback(
    async (email: string, password: string): Promise<void> => {
      await client.loginLocal({ email, password });
      await refresh();
    },
    [client, refresh],
  );

  const registerLocal = useCallback(
    async (
      email: string,
      password: string,
      displayName: string,
    ): Promise<string> => {
      const result = await client.registerLocalAccount({
        email,
        password,
        displayName,
      });
      return result.message;
    },
    [client],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await client.logout();
    } finally {
      // Even a failed logout must leave the browser thinking it is signed out:
      // the alternative is a UI that keeps offering server projects the session
      // can no longer open.
      setState({ status: "anonymous", user: null });
    }
  }, [client]);

  return { ...state, signIn, signInLocal, registerLocal, signOut, refresh };
}
