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
A workspace owner or delegated workspace member allowed to manage that
workspace's members and invitations.
_Avoid_: Platform administrator, project owner

**Invitation**:
A single-use, expirable link bound to one email address and one workspace role.
The authenticated account must use the bound email before the invitation can be
accepted.
_Avoid_: Invite code, access token

**Default workspace**:
The one workspace automatically created for every user. It cannot be deleted,
but it can be renamed.
_Avoid_: Personal project, home project
