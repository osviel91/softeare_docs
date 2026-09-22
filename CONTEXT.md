# Accounts And Workspaces

This context covers human authentication, administrator approval, workspace
membership, invitations, and the projects contained by a workspace.

## Language

**User**:
A person with an account in the application. A user may authenticate locally or
through Google.
_Avoid_: Account, member (unless describing a workspace relationship)

**Account status**:
The approval state of a user: `PENDING`, `ACTIVE`, or `SUSPENDED`.
_Avoid_: Login status, session status

**Platform administrator**:
A user allowed to approve, suspend, and reactivate users and administer every
workspace.
_Avoid_: Project owner, workspace admin

**Workspace**:
A user-owned container that groups projects and collaborators. A workspace name
is a label and can be changed without changing its projects.
_Avoid_: Server project, project

**Workspace member**:
A user with access to a workspace through ownership, an accepted invitation, or
an administrator assignment.
_Avoid_: Project member

**Workspace administrator**:
A workspace member with the `ADMIN` role, allowed to manage that workspace's
members. Invitation management will use the same authority when invitations
are introduced.
_Avoid_: Platform administrator, project owner

**Workspace role**:
The role a user has inside one workspace: `ADMIN`, `EDITOR`, or `VIEWER`.
Workspace roles are separate from project roles.
_Avoid_: Project role

**Invitation**:
A single-use, expirable link bound to one email address and one workspace role.
The authenticated account must use the bound email before the invitation can be
accepted.
_Avoid_: Invite code, access token

**Default workspace**:
The one workspace automatically created for every user. It cannot be deleted,
but it can be renamed.
_Avoid_: Personal project, home project

## Current boundaries

- The default workspace and workspace membership model exist for existing and new
  users.
- Workspace administrators can list members, change roles, and remove members.
- Projects have a workspace association, but project authorization still uses
  project membership until the workspace-aware project phase is delivered.
- Local password credentials use scrypt hashes and approval-controlled sessions.
- Invitations, workspace creation and workspace selection are not yet part of the
  delivered model.
