import type { AuthState } from "./use-auth";
import type { ServerAdminUser } from "../../workspace/server/api-client";

export interface PlatformAdministrationProps {
  auth: AuthState;
  adminUsers: ServerAdminUser[];
  onSetUserStatus: (userId: string, status: ServerAdminUser["status"]) => void;
  onBack: () => void;
}

export default function PlatformAdministration({
  auth,
  adminUsers,
  onSetUserStatus,
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
