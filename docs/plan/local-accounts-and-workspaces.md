# Local Accounts And Workspaces

This plan adds local accounts, approval-controlled Google and local
authentication, user-owned workspaces, workspace invitations, and a central
administration surface. Every phase is a deployable vertical slice with an
observable browser workflow and automated tests.

## Rules

- Google remains an authentication method; it does not bypass approval.
- Local registration and first Google sign-in create `PENDING` users.
- Only a platform administrator can activate, suspend, or reactivate users.
- Pending and suspended users cannot create sessions.
- A suspended user's sessions and agent credentials stop working.
- Every user has exactly one non-deletable default workspace.
- Users can create, rename, and manage their own workspaces.
- Workspace owners and workspace administrators manage members and invitations.
- Project roles remain separate from workspace roles.
- An invitation is a single-use, expirable link bound to one normalized email.
- The invitation email must match the authenticated local or verified Google email.

## Phases

### Phase 1 — Approval-aware authentication (delivered)

Deliver a complete browser-testable account flow:

- [x] Local registration form.
- [x] Local login form.
- [x] Google login continuing through the existing OIDC flow.
- [x] Pending-account response after Google authentication.
- [x] Platform-admin bootstrap through `PLATFORM_ADMIN_EMAIL`.
- [x] Minimal admin user list and activate/suspend controls.
- [x] `/api/me` exposes the account status needed by the browser.
- [x] Audit events for registration, activation, suspension, and rejected login.

Delivered checkpoint: approval-aware Google and local authentication, account status
handling, platform-admin API and browser controls (`6bb15c5`, `49680f4`).

Acceptance workflow:

1. Register a local account and see “pending approval”.
2. Sign in with Google and see the same pending state.
3. Activate the user as platform administrator.
4. Sign in again and access the authenticated application.
5. Suspend the user and observe that the existing session is rejected.

### Phase 2 — User and identity storage (delivered)

- [x] Move provider identities into `user_identities`.
- [x] Add `local_credentials` with `scrypt` password hashes.
- [x] Add account status and activation metadata.
- [x] Preserve existing Google users through a migration.
- [x] Add repository and migration tests.

Acceptance workflow status: local registration creates a pending account, pending
accounts cannot log in, and an activated account can log in through an HttpOnly
session.

### Phase 3 — Workspace foundation (foundation delivered)

- [x] Add `workspaces` and `workspace_members`.
- [x] Create one default workspace per existing and newly created user.
- [ ] Add workspace listing, creation, rename, and deletion rules.
- [x] Add `projects.workspace_id`.
- [x] Migrate existing projects into owner default workspaces.
- [x] List workspaces and manage member roles (`ADMIN`, `EDITOR`, `VIEWER`).

Acceptance workflow status: the foundation and membership management are
deployed, but workspace creation, rename, deletion and selection are still
pending.

### Phase 4 — Workspace-aware projects (not started)

- Create projects inside a selected workspace.
- List projects only through accessible workspaces.
- Require workspace membership before project authorization.
- Preserve existing project roles and resource behavior.

Acceptance workflow: switching workspaces changes the visible project list and
does not leak projects from another workspace.

### Phase 5 — Invitations (not started)

- Add `workspace_invitations`.
- Generate long random tokens and store only token hashes.
- Bind each invitation to a normalized email, workspace, inviter, and role.
- Add expiration, revocation, and one-time acceptance.
- Carry the token safely through local and Google authentication.
- Require verified Google email or exact local email match.
- Keep membership pending until platform approval is complete.

Acceptance workflow: an admin creates a link, a recipient creates a local or
Google account, a mismatched email is refused, and the correct account receives
the role after approval.

### Phase 6 — Workspace administration (partially implemented)

- [x] Default workspace creator is an administrator automatically.
- [x] Workspace administrators list, change roles, and remove members.
- [ ] Workspace administrators invite members.
- [ ] Platform administrators can intervene in any workspace.
- [ ] Add workspace and membership audit events.

Acceptance workflow: workspace admins can manage members, regular members
cannot, and platform administrators retain emergency access.

### Phase 7 — Configuration backend (not started)

- Add a typed admin configuration boundary.
- Add settings only when their behavior is defined.
- Start with registration policy, password policy, session lifetime, and allowed
  authentication providers.
- Audit every setting change.

Do not build a generic key/value settings editor.

## Verification

Each phase must pass its focused tests and browser workflow before deployment.
The phase checkpoint also runs `npm test`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, and `npm run build`.

## Current checkpoint

`bf0411b` is the deployed workspace-foundation checkpoint. The current working tree
also delivers local credentials and passes the full Vitest suite, typecheck, web/API
builds, and container verification. Project authorization still uses project
membership; invitations and workspace-aware project listing remain intentionally
undelivered.
