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

### Phase 1 — Approval-aware authentication

Deliver a complete browser-testable account flow:

- Local registration form.
- Local login form.
- Google login continuing through the existing OIDC flow.
- Pending-account response after either authentication method.
- Platform-admin bootstrap command.
- Minimal admin user list and activate/suspend controls.
- `/api/me` exposes the account status needed by the browser.
- Audit events for registration, activation, suspension, and rejected login.

Acceptance workflow:

1. Register a local account and see “pending approval”.
2. Sign in with Google and see the same pending state.
3. Activate the user as platform administrator.
4. Sign in again and access the authenticated application.
5. Suspend the user and observe that the existing session is rejected.

### Phase 2 — User and identity storage

- Move provider identities into `user_identities`.
- Add `local_credentials` with `scrypt` password hashes.
- Add account status and activation metadata.
- Preserve existing Google users through a migration.
- Add repository and migration tests.

### Phase 3 — Workspace foundation

- Add `workspaces` and `workspace_members`.
- Create one default workspace per existing and newly activated user.
- Add workspace listing, creation, rename, and deletion rules.
- Move projects under `projects.workspace_id`.
- Migrate existing projects into owner default workspaces.

Acceptance workflow: a user creates, renames, selects, and lists workspaces;
another user cannot see them.

### Phase 4 — Workspace-aware projects

- Create projects inside a selected workspace.
- List projects only through accessible workspaces.
- Require workspace membership before project authorization.
- Preserve existing project roles and resource behavior.

Acceptance workflow: switching workspaces changes the visible project list and
does not leak projects from another workspace.

### Phase 5 — Invitations

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

### Phase 6 — Workspace administration

- Workspace owner is an administrator automatically.
- Workspace administrators list, invite, change roles, and remove members.
- Platform administrators can intervene in any workspace.
- Add workspace and membership audit events.

Acceptance workflow: workspace admins can manage members, regular members
cannot, and platform administrators retain emergency access.

### Phase 7 — Configuration backend

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
