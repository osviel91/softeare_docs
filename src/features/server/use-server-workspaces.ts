/**
 * The server side of the workspace switcher (Phase 4A).
 *
 * This hook owns what `useWorkspace` deliberately does not: the *list* of
 * authenticated server projects, creating one, and opening one. A
 * {@link ServerWorkspaceRepository} addresses exactly one project, so "which
 * server project is open" is a decision made here and handed down as a single
 * active binding.
 *
 * Opening is asynchronous in a way a local project's is not: the caller's
 * permissions must be read before an editor is built, because a viewer's
 * repository must be genuinely read-only rather than merely hidden. The binding
 * is therefore only published once both the project and its access are known, so
 * no render ever shows a writable editor for a project the account cannot write.
 *
 * Signing out, or losing the session, closes the binding: a stale repository
 * would keep issuing requests that can only fail, and would leave another
 * person's project on screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ServerApiClient,
  ServerProject,
} from "../../workspace/server/api-client";
import {
  createServerWorkspaceRepository,
  type ServerWorkspaceRepository,
} from "../../workspace/server/server-workspace-repository";
import type { AuthState } from "./use-auth";

/** The one server project the editor is currently bound to. */
export interface ActiveServerWorkspace {
  project: ServerProject;
  repository: ServerWorkspaceRepository;
  /** Whether this account may change the project's resources. */
  writable: boolean;
}

/** The server project list and the active binding. */
export interface ServerWorkspacesHook {
  projects: ServerProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  /** The open binding, or `null` when the editor is on a local workspace. */
  active: ActiveServerWorkspace | null;
  /** True while a project is being opened (access is being read). */
  opening: boolean;
  /** A failure from the last open or create attempt, for the UI to show. */
  openError: string | null;
  refresh(): Promise<void>;
  openProject(project: ServerProject): Promise<void>;
  createProject(name: string): Promise<void>;
  close(): void;
}

/** The permission a writable repository requires. */
const WRITE_PERMISSION = "resource:write";

/**
 * Track the caller's server projects.
 *
 * @param client - The API client, shared with the rest of the app.
 * @param auth - The current session state; the list is loaded when it becomes
 *   authenticated and dropped when it stops being.
 */
export function useServerWorkspaces(
  client: ServerApiClient,
  auth: AuthState,
): ServerWorkspacesHook {
  const [projects, setProjects] = useState<ServerProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveServerWorkspace | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // A repository is bound to a project *and* to the session that opened it; a
  // second open must not be overwritten by the first one's slower answer.
  const openTicket = useRef(0);
  const authenticated = auth.status === "authenticated";

  const refresh = useCallback(async (): Promise<void> => {
    if (!authenticated) {
      setProjects([]);
      setProjectsError(null);
      return;
    }
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      setProjects(await client.listProjects());
    } catch (error) {
      setProjects([]);
      setProjectsError(
        error instanceof Error
          ? error.message
          : "The projects could not be loaded.",
      );
    } finally {
      setProjectsLoading(false);
    }
  }, [client, authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Losing the session closes whatever it had open. Keeping the binding would
  // leave one person's project rendered for the next person at the browser.
  useEffect(() => {
    if (!authenticated) {
      openTicket.current += 1;
      setActive(null);
      setOpenError(null);
      setOpening(false);
    }
  }, [authenticated]);

  const openProject = useCallback(
    async (project: ServerProject): Promise<void> => {
      const ticket = (openTicket.current += 1);
      setOpening(true);
      setOpenError(null);
      try {
        const access = await client.access(project.id);
        if (openTicket.current !== ticket) return;
        // One decision, used twice: the UI's read-only affordances and the
        // repository's own refusal must never disagree.
        const writable = access.permissions.includes(WRITE_PERMISSION);
        setActive({
          project,
          writable,
          repository: createServerWorkspaceRepository({
            client,
            projectId: project.id,
            projectName: project.name,
            writable,
          }),
        });
      } catch (error) {
        if (openTicket.current !== ticket) return;
        setActive(null);
        setOpenError(
          error instanceof Error
            ? error.message
            : "The project could not be opened.",
        );
      } finally {
        if (openTicket.current === ticket) setOpening(false);
      }
    },
    [client],
  );

  const createProject = useCallback(
    async (name: string): Promise<void> => {
      setOpenError(null);
      try {
        const created = await client.createProject(name);
        await refresh();
        await openProject(created);
      } catch (error) {
        setOpenError(
          error instanceof Error
            ? error.message
            : "The project could not be created.",
        );
      }
    },
    [client, refresh, openProject],
  );

  const close = useCallback((): void => {
    openTicket.current += 1;
    setActive(null);
    setOpenError(null);
  }, []);

  return {
    projects,
    projectsLoading,
    projectsError,
    active,
    opening,
    openError,
    refresh,
    openProject,
    createProject,
    close,
  };
}
