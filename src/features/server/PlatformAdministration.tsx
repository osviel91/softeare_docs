import type { AuthState } from "./use-auth";
import type {
  ServerAdminUser,
  ServerWorkspace,
  ServerWorkspaceMember,
} from "../../workspace/server/api-client";

export interface PlatformAdministrationProps {
  auth: AuthState;
  adminUsers: ServerAdminUser[];
  onSetUserStatus: (userId: string, status: ServerAdminUser["status"]) => void;
  workspaces: ServerWorkspace[];
  workspaceMembersByWorkspaceId: Record<string, ServerWorkspaceMember[]>;
  onSetWorkspaceMemberRole: (
    workspaceId: string,
    userId: string,
    role: ServerWorkspaceMember["role"],
  ) => void;
  onRemoveWorkspaceMember: (workspaceId: string, userId: string) => void;
  onBack: () => void;
}

export default function PlatformAdministration({
  auth,
  adminUsers,
  onSetUserStatus,
  workspaces,
  workspaceMembersByWorkspaceId,
  onSetWorkspaceMemberRole,
  onRemoveWorkspaceMember,
  onBack,
}: PlatformAdministrationProps) {
  const user = auth.user;

  return (
    <main className="settings-page" data-testid="workspace-settings-page">
      <header className="settings-page__header">
        <div>
          <p className="settings-page__eyebrow">Server</p>
          <h1 className="settings-page__title">Workspace settings</h1>
          <p className="settings-page__lead">
            Manage your account and the people who can access this server.
          </p>
        </div>
        <button type="button" className="button" data-testid="workspace-settings-back" onClick={onBack}>
          ← Back to workspace
        </button>
      </header>

      <section className="settings-card" aria-labelledby="settings-account-title">
        <div className="settings-card__heading">
          <div>
            <p className="settings-card__eyebrow">Your account</p>
            <h2 id="settings-account-title">{user?.displayName || "Signed in"}</h2>
          </div>
          <span className="settings-card__badge">{user?.accountStatus ?? "ACTIVE"}</span>
        </div>
        <p className="settings-card__muted">{user?.email ?? "No email address available"}</p>
      </section>

      {workspaces.map((workspace) => (
        <section className="settings-card" aria-labelledby={`workspace-${workspace.id}-title`} key={workspace.id}>
          <div className="settings-card__heading">
            <div>
              <p className="settings-card__eyebrow">Workspace members</p>
              <h2 id={`workspace-${workspace.id}-title`}>{workspace.name}</h2>
            </div>
            <span className="settings-card__badge">{workspace.role}</span>
          </div>
          <p className="settings-card__muted">
            Manage who can access this workspace and what they can do.
          </p>
          <div className="settings-users" role="list">
            {(workspaceMembersByWorkspaceId[workspace.id] ?? []).map((member) => (
              <div className="settings-user" role="listitem" key={member.userId}>
                <div>
                  <strong>{member.displayName}</strong>
                  <span>{member.email ?? "No email address"}</span>
                </div>
                {workspace.role === "ADMIN" ? (
                  <div className="settings-user__actions">
                    <select
                      aria-label={`Workspace role for ${member.email ?? member.displayName}`}
                      value={member.role}
                      onChange={(event) => onSetWorkspaceMemberRole(
                        workspace.id,
                        member.userId,
                        event.target.value as ServerWorkspaceMember["role"],
                      )}
                    >
                      <option value="ADMIN">Admin</option>
                      <option value="EDITOR">Editor</option>
                      <option value="VIEWER">Viewer</option>
                    </select>
                    {member.userId !== user?.id && (
                      <button
                        type="button"
                        className="button button--small button--danger-text"
                        onClick={() => onRemoveWorkspaceMember(workspace.id, member.userId)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="settings-user__role">{member.role}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      {user?.platformAdmin ? (
        <section className="settings-card" aria-labelledby="settings-admin-title" data-testid="workspace-admin-users">
          <div className="settings-card__heading">
            <div>
              <p className="settings-card__eyebrow">Platform administration</p>
              <h2 id="settings-admin-title">Account approval</h2>
            </div>
            <span className="settings-card__count">{adminUsers.length} accounts</span>
          </div>
          <p className="settings-card__muted">
            Approve accounts before they can use server workspaces, or suspend access.
          </p>
          <div className="settings-users" role="list">
            {adminUsers.map((adminUser) => (
              <div className="settings-user" role="listitem" key={adminUser.id}>
                <div>
                  <strong>{adminUser.displayName}</strong>
                  <span>{adminUser.email ?? "No email address"}</span>
                </div>
                <select
                  aria-label={`Status for ${adminUser.email ?? adminUser.displayName}`}
                  value={adminUser.status}
                  onChange={(event) => onSetUserStatus(adminUser.id, event.target.value as ServerAdminUser["status"])}
                >
                  <option value="PENDING">Pending</option>
                  <option value="ACTIVE">Active</option>
                  <option value="SUSPENDED">Suspended</option>
                </select>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="settings-card">
          <p className="settings-card__eyebrow">Workspace access</p>
          <h2>Contact an administrator</h2>
          <p className="settings-card__muted">
            Workspace membership and account approval are managed by a platform administrator.
          </p>
        </section>
      )}
    </main>
  );
}
