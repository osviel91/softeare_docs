/**
 * The workspace switcher (Phase 4A).
 *
 * The application can edit two kinds of workspace — local (in-browser or an
 * opened folder) and authenticated server projects — and the user must be able to
 * tell which one they are in and move between them. This component is that
 * surface, and nothing more: it renders sources and reports intent.
 *
 * It is deliberately separate from the explorer's project tree. A local project
 * and a server project are not the same object (one is a directory of files, the
 * other a row plus a volume), and mixing them into one list would make the
 * editor's "open this project" path ambiguous. So the switcher picks the
 * *source*, and the tree below it shows what that source holds.
 *
 * Anonymous users are not asked to sign in to use the app: the server section
 * says what it would take, and local mode keeps working exactly as before.
 */
import { useState } from "react";
import type { AuthState } from "../server/use-auth";
import type { ServerProject } from "../../workspace/server/api-client";

/** Which source the editor is bound to. */
export type WorkspaceMode = "local" | "folder" | "server";

export interface WorkspaceSwitcherProps {
  /** The source currently feeding the editor. */
  mode: WorkspaceMode;
  /** The opened folder's name, when a folder is the active local source. */
  folderName?: string | null;
  /** Whether the browser supports opening a folder at all. */
  folderSupported?: boolean;
  /** The current session state. */
  auth: AuthState;
  /** Every server project the signed-in user can see. */
  serverProjects?: ServerProject[];
  /** True while the server project list is loading. */
  serverProjectsLoading?: boolean;
  /** A failure from loading the server project list, if any. */
  serverProjectsError?: string | null;
  /** The id of the open server project, or `null`. */
  activeServerProjectId?: string | null;
  /** A failure from opening or creating a server project, if any. */
  serverOpenError?: string | null;
  /** Switch to the in-browser projects. */
  onOpenLocal: () => void;
  /** Open (or close) a local folder. */
  onOpenFolder: () => void;
  /** Leave for the identity provider. */
  onSignIn: () => void;
  /** Revoke the session. */
  onSignOut: () => void;
  /** Open one server project in the editor. */
  onOpenServerProject: (project: ServerProject) => void;
  /** Create a server project and open it. */
  onCreateServerProject: (name: string) => void;
  /** Ask for the server project list again. */
  onReloadServerProjects?: () => void;
}

export default function WorkspaceSwitcher({
  mode,
  folderName = null,
  folderSupported = false,
  auth,
  serverProjects = [],
  serverProjectsLoading = false,
  serverProjectsError = null,
  activeServerProjectId = null,
  serverOpenError = null,
  onOpenLocal,
  onOpenFolder,
  onSignIn,
  onSignOut,
  onOpenServerProject,
  onCreateServerProject,
  onReloadServerProjects,
}: WorkspaceSwitcherProps) {
  const [pendingName, setPendingName] = useState<string>("");
  const name = pendingName.trim();

  const create = (): void => {
    if (name === "") return;
    onCreateServerProject(name);
    setPendingName("");
  };

  return (
    <nav
      className="workspaces"
      data-testid="workspace-switcher"
      aria-label="Workspaces"
    >
      <h2 className="workspaces__title">Workspaces</h2>

      <section className="workspaces__group" aria-label="Local workspaces">
        <h3 className="workspaces__group-title">Local</h3>
        <ul className="workspaces__list">
          <li>
            <button
              type="button"
              className={`workspaces__item${
                mode === "local" ? " workspaces__item--active" : ""
              }`}
              data-testid="workspace-local"
              aria-current={mode === "local" ? "true" : undefined}
              onClick={onOpenLocal}
            >
              <span className="workspaces__item-icon" aria-hidden="true">
                ▤
              </span>
              Browser projects
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`workspaces__item${
                mode === "folder" ? " workspaces__item--active" : ""
              }`}
              data-testid="workspace-open-folder"
              aria-current={mode === "folder" ? "true" : undefined}
              disabled={!folderSupported}
              onClick={onOpenFolder}
            >
              <span className="workspaces__item-icon" aria-hidden="true">
                ⌸
              </span>
              {folderName ? `Folder: ${folderName}` : "Open local folder…"}
            </button>
          </li>
        </ul>
      </section>

      <section className="workspaces__group" aria-label="Server workspaces">
        <h3 className="workspaces__group-title">Server</h3>

        {auth.status === "loading" && (
          <p
            className="workspaces__note"
            data-testid="workspace-server-loading"
          >
            Checking sign-in…
          </p>
        )}

        {auth.status === "anonymous" && (
          <div className="workspaces__signed-out">
            <p
              className="workspaces__note"
              data-testid="workspace-server-signed-out"
            >
              Sign in to access server projects
            </p>
            <button
              type="button"
              className="button"
              data-testid="workspace-sign-in"
              onClick={onSignIn}
            >
              Sign in
            </button>
          </div>
        )}

        {auth.status === "authenticated" && (
          <>
            <div className="workspaces__user" data-testid="workspace-user">
              <span className="workspaces__user-name">
                {auth.user?.displayName || auth.user?.id || "Signed in"}
              </span>
              <button
                type="button"
                className="workspaces__sign-out"
                data-testid="workspace-sign-out"
                onClick={onSignOut}
              >
                Sign out
              </button>
            </div>

            <form
              className="workspaces__create"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <label className="visually-hidden" htmlFor="server-project-name">
                New server project name
              </label>
              <input
                id="server-project-name"
                className="explorer__input"
                data-testid="workspace-new-server-project-input"
                value={pendingName}
                onChange={(event) => setPendingName(event.target.value)}
                placeholder="New server project"
              />
              <button
                type="submit"
                className="workspaces__create-button"
                data-testid="workspace-new-server-project-button"
                disabled={name === ""}
              >
                Create
              </button>
            </form>

            {serverProjectsLoading && (
              <p
                className="workspaces__note"
                data-testid="workspace-server-projects-loading"
              >
                Loading projects…
              </p>
            )}
            {serverProjectsError !== null && (
              <p
                className="workspaces__error"
                data-testid="workspace-server-projects-error"
              >
                {serverProjectsError}
                {onReloadServerProjects && (
                  <button
                    type="button"
                    className="workspaces__retry"
                    data-testid="workspace-server-projects-retry"
                    onClick={onReloadServerProjects}
                  >
                    Retry
                  </button>
                )}
              </p>
            )}
            {!serverProjectsLoading &&
              serverProjectsError === null &&
              serverProjects.length === 0 && (
                <p
                  className="workspaces__note"
                  data-testid="workspace-server-projects-empty"
                >
                  No server projects yet.
                </p>
              )}

            {serverProjects.length > 0 && (
              <ul className="workspaces__list">
                {serverProjects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={`workspaces__item${
                        project.id === activeServerProjectId
                          ? " workspaces__item--active"
                          : ""
                      }`}
                      data-testid="workspace-server-project"
                      aria-current={
                        project.id === activeServerProjectId
                          ? "true"
                          : undefined
                      }
                      onClick={() => onOpenServerProject(project)}
                    >
                      <span
                        className="workspaces__item-icon"
                        aria-hidden="true"
                      >
                        ☁
                      </span>
                      {project.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {serverOpenError !== null && (
              <p
                className="workspaces__error"
                data-testid="workspace-server-error"
              >
                {serverOpenError}
              </p>
            )}
          </>
        )}
      </section>
    </nav>
  );
}
