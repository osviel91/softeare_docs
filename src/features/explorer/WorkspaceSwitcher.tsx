/** Choose the local or authenticated server workspace that feeds the editor. */
import { useEffect, useState } from "react";
import type { AuthState } from "../server/use-auth";
import type {
  ServerAdminUser,
  ServerProject,
} from "../../workspace/server/api-client";

export type WorkspaceMode = "local" | "folder" | "server";

export interface WorkspaceSwitcherProps {
  mode: WorkspaceMode;
  folderName?: string | null;
  folderSupported?: boolean;
  auth: AuthState;
  serverProjects?: ServerProject[];
  serverProjectsLoading?: boolean;
  serverProjectsError?: string | null;
  activeServerProjectId?: string | null;
  serverOpenError?: string | null;
  onOpenLocal: () => void;
  onOpenFolder: () => void;
  onSignIn?: () => void;
  onSignOut?: () => Promise<void>;
  onOpenServerProject: (project: ServerProject) => void;
  onCreateServerProject: (name: string) => void;
  onReloadServerProjects?: () => void;
  onDownloadLocalCopy?: () => void;
  adminUsers?: ServerAdminUser[];
  onSetUserStatus?: (userId: string, status: ServerAdminUser["status"]) => void;
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
  onSignIn = () => {},
  onSignOut = async () => {},
  onOpenServerProject,
  onCreateServerProject,
  onReloadServerProjects,
  onDownloadLocalCopy,
  adminUsers = [],
  onSetUserStatus,
}: WorkspaceSwitcherProps) {
  const [pendingName, setPendingName] = useState("");
  const [localExpanded, setLocalExpanded] = useState(mode !== "server");
  const [serverExpanded, setServerExpanded] = useState(mode === "server");
  const name = pendingName.trim();

  useEffect(() => {
    if (auth.status === "authenticated" || mode === "server") {
      setServerExpanded(true);
    } else {
      setLocalExpanded(true);
    }
  }, [auth.status, mode]);

  const create = (): void => {
    if (name === "") return;
    onCreateServerProject(name);
    setPendingName("");
  };

  return (
    <nav className="workspaces" data-testid="workspace-switcher" aria-label="Workspaces">
      <h2 className="workspaces__title">Workspaces</h2>

      <section className="workspaces__group" aria-label="Local workspaces">
        <h3 className="workspaces__group-title">
          <button
            type="button"
            className="workspaces__group-toggle"
            data-testid="workspace-local-toggle"
            aria-expanded={localExpanded}
            onClick={() => setLocalExpanded((expanded) => !expanded)}
          >
            Local <span aria-hidden="true">{localExpanded ? "▾" : "▸"}</span>
          </button>
        </h3>
        {localExpanded && <ul className="workspaces__list">
          <li>
            <button
              type="button"
              className={`workspaces__item${mode === "local" ? " workspaces__item--active" : ""}`}
              data-testid="workspace-local"
              aria-current={mode === "local" ? "true" : undefined}
              onClick={onOpenLocal}
            >
              <span className="workspaces__item-icon" aria-hidden="true">▤</span>
              Browser projects
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`workspaces__item${mode === "folder" ? " workspaces__item--active" : ""}`}
              data-testid="workspace-open-folder"
              aria-current={mode === "folder" ? "true" : undefined}
              disabled={!folderSupported}
              onClick={onOpenFolder}
            >
              <span className="workspaces__item-icon" aria-hidden="true">⌸</span>
              {folderName ? `Folder: ${folderName}` : "Open local folder…"}
            </button>
          </li>
        </ul>}
      </section>

      <section className="workspaces__group" aria-label="Server workspaces">
        {auth.status === "authenticated" ? (
          <h3 className="workspaces__group-title">
            <button
              type="button"
              className="workspaces__group-toggle"
              data-testid="workspace-server-toggle"
              aria-expanded={serverExpanded}
              onClick={() => setServerExpanded((expanded) => !expanded)}
            >
              Server <span aria-hidden="true">{serverExpanded ? "▾" : "▸"}</span>
            </button>
          </h3>
        ) : (
          <h3 className="workspaces__group-title">Server</h3>
        )}

        {auth.status === "loading" && (
          <p className="workspaces__note" data-testid="workspace-server-loading">
            Checking sign-in…
          </p>
        )}

        {auth.status === "anonymous" && (
          <div className="workspaces__signed-out">
            <p className="workspaces__note" data-testid="workspace-server-signed-out">
              Sign in to access server projects
            </p>
            <button type="button" className="button" data-testid="workspace-sign-in" onClick={onSignIn}>
              Sign in
            </button>
          </div>
        )}

        {auth.status === "authenticated" && serverExpanded &&
          (auth.user?.accountStatus === "PENDING" || auth.user?.accountStatus === "SUSPENDED") &&
          !auth.user?.platformAdmin && (
            <p className="workspaces__note" data-testid="workspace-account-pending">
              Your account is awaiting administrator approval.
            </p>
          )}

        {auth.status === "authenticated" &&
          auth.user?.accountStatus !== "PENDING" &&
          auth.user?.accountStatus !== "SUSPENDED" && (
            <>
              <div className="workspaces__user" data-testid="workspace-user">
                <span className="workspaces__user-name">
                  {auth.user?.displayName || auth.user?.id || "Signed in"}
                </span>
                <button type="button" className="workspaces__sign-out" data-testid="workspace-sign-out" onClick={() => void onSignOut()}>
                  Sign out
                </button>
              </div>

              {auth.user?.platformAdmin && onSetUserStatus && (
                <details data-testid="workspace-admin-users">
                  <summary>Platform administration</summary>
                  <ul className="workspaces__list">
                    {adminUsers.map((user) => (
                      <li key={user.id}>
                        <span>{user.email ?? user.displayName}</span>
                        <select
                          aria-label={`Status for ${user.email ?? user.displayName}`}
                          value={user.status}
                          onChange={(event) => onSetUserStatus(user.id, event.target.value as ServerAdminUser["status"])}
                        >
                          <option value="PENDING">Pending</option>
                          <option value="ACTIVE">Active</option>
                          <option value="SUSPENDED">Suspended</option>
                        </select>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <form
                className="workspaces__create"
                onSubmit={(event) => {
                  event.preventDefault();
                  create();
                }}
              >
                <label className="visually-hidden" htmlFor="server-project-name">New server project name</label>
                <input
                  id="server-project-name"
                  className="explorer__input"
                  data-testid="workspace-new-server-project-input"
                  value={pendingName}
                  onChange={(event) => setPendingName(event.target.value)}
                  placeholder="New server project"
                />
                <button type="submit" className="workspaces__create-button" data-testid="workspace-new-server-project-button" disabled={name === ""}>
                  Create
                </button>
              </form>

              {serverProjectsLoading && <p className="workspaces__note" data-testid="workspace-server-projects-loading">Loading projects…</p>}
              {serverProjectsError !== null && (
                <p className="workspaces__error" data-testid="workspace-server-projects-error">
                  {serverProjectsError}
                  {onReloadServerProjects && <button type="button" className="workspaces__retry" data-testid="workspace-server-projects-retry" onClick={onReloadServerProjects}>Retry</button>}
                </p>
              )}
              {!serverProjectsLoading && serverProjectsError === null && serverProjects.length === 0 && (
                <p className="workspaces__note" data-testid="workspace-server-projects-empty">No server projects yet.</p>
              )}
              {serverProjects.length > 0 && (
                <ul className="workspaces__list">
                  {serverProjects.map((project) => (
                    <li key={project.id}>
                      <button
                        type="button"
                        className={`workspaces__item${project.id === activeServerProjectId ? " workspaces__item--active" : ""}`}
                        data-testid="workspace-server-project"
                        aria-current={project.id === activeServerProjectId ? "true" : undefined}
                        onClick={() => onOpenServerProject(project)}
                      >
                        <span className="workspaces__item-icon" aria-hidden="true">☁</span>
                        {project.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {serverOpenError !== null && <p className="workspaces__error" data-testid="workspace-server-error">{serverOpenError}</p>}
              {onDownloadLocalCopy && (
                <button type="button" className="workspaces__download" data-testid="workspace-download-local-copy" onClick={onDownloadLocalCopy}>
                  Download local copy (.zip)
                </button>
              )}
            </>
          )}
      </section>
    </nav>
  );
}
