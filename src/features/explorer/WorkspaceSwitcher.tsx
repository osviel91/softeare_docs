/** Choose the local or authenticated server workspace that feeds the editor. */
import { useEffect, useState } from "react";
import type { AuthState } from "../server/use-auth";
import type { ServerProject } from "../../workspace/server/api-client";

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
  onOpenServerProject: (project: ServerProject) => void;
  onCreateServerProject: (name: string) => void;
  onReloadServerProjects?: () => void;
  onDownloadLocalCopy?: () => void;
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
  onOpenServerProject,
  onCreateServerProject,
  onReloadServerProjects,
  onDownloadLocalCopy,
}: WorkspaceSwitcherProps) {
  const [pendingName, setPendingName] = useState("");
  const [localExpanded, setLocalExpanded] = useState(mode !== "server");
  const [serverExpanded, setServerExpanded] = useState(mode === "server");
  const name = pendingName.trim();

  useEffect(() => {
    if (mode === "server") setServerExpanded(true);
    else setLocalExpanded(true);
  }, [mode]);

  useEffect(() => {
    if (auth.status === "authenticated") setServerExpanded(true);
  }, [auth.status]);

  const create = (): void => {
    if (name === "") return;
    onCreateServerProject(name);
    setPendingName("");
  };

  return (
    <nav className="workspaces" data-testid="workspace-switcher" aria-label="Workspaces">
      <section className="workspaces__group" aria-label="Local workspaces">
        <h2 className="workspaces__group-title">
          <button
            type="button"
            className="workspaces__group-toggle"
            data-testid="workspace-local-toggle"
            aria-expanded={localExpanded}
            onClick={() => setLocalExpanded((expanded) => !expanded)}
          >
            Local <span aria-hidden="true">{localExpanded ? "▾" : "▸"}</span>
          </button>
        </h2>
        {localExpanded && (
          <ul className="workspaces__list">
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
                {folderName ? `Folder: ${folderName}` : "Open local folder..."}
              </button>
            </li>
          </ul>
        )}
      </section>

      {auth.status === "authenticated" && (
        <section className="workspaces__group" aria-label="Server workspaces">
          <h2 className="workspaces__group-title">
            <button
              type="button"
              className="workspaces__group-toggle"
              data-testid="workspace-server-toggle"
              aria-expanded={serverExpanded}
              onClick={() => setServerExpanded((expanded) => !expanded)}
            >
              Server <span aria-hidden="true">{serverExpanded ? "▾" : "▸"}</span>
            </button>
          </h2>
          {serverExpanded && (
            <>
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
                <p className="workspaces__note" data-testid="workspace-server-projects-loading">
                  Loading projects...
                </p>
              )}
              {serverProjectsError !== null && (
                <p className="workspaces__error" data-testid="workspace-server-projects-error">
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
              {!serverProjectsLoading && serverProjectsError === null && serverProjects.length === 0 && (
                <p className="workspaces__note" data-testid="workspace-server-projects-empty">
                  No server projects yet.
                </p>
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
              {serverOpenError !== null && (
                <p className="workspaces__error" data-testid="workspace-server-error">
                  {serverOpenError}
                </p>
              )}
              {mode === "server" && onDownloadLocalCopy && (
                <button
                  type="button"
                  className="workspaces__download"
                  data-testid="workspace-download-local-copy"
                  onClick={onDownloadLocalCopy}
                >
                  Download local copy (.zip)
                </button>
              )}
            </>
          )}
        </section>
      )}
    </nav>
  );
}
