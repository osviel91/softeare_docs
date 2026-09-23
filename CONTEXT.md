# Product Vocabulary

This glossary names the concepts used by the product and its documentation. It
describes the current model without prescribing implementation.

## Concepts

**User**: A person who can use the application through an authenticated account.

**Agent identity**: A named non-human identity used by an automation or coding
agent to access server capabilities.

**Agent credential**: A credential belonging to an agent identity. It lets an
agent authenticate without a human browser session and can be revoked
independently.

**Workspace**: A collaboration boundary that groups projects and its members.
Every user has a default workspace; additional workspaces can be created and
managed by their owners.

**Project**: A named documentation set inside one workspace. A project groups
resources and has its own project-level roles and permissions.

**Resource**: A project document with a name, content, identity, and type. The
current resource types are sequence diagram, event flow, and documentation.
The domain distinguishes a resource's identity and content from stored semantic
metadata (`description` and `tags`) and from derived presentation information
such as its effective title. Visualization is not resource metadata.

Stored semantic metadata is persisted and exposed by the server resource API and
remote MCP discovery/read/update surfaces. Existing titles remain content- or
name-derived, with no second independently editable title source.

**Current revision**: The optimistic-concurrency number on the canonical server
resource. It is a historical sequence, not a semantic/product version.

**Resource revision**: An immutable server-side snapshot of a resource's content,
type, metadata, authorship, and creation time. Revisions are ordered by number.
The initial H13 snapshot preserves an existing resource's current number; unknown
earlier states are not invented.

**Representation**: Derived output resolved from revision content and type. It is
not stored in revision snapshots.

**Diagram**: A visual document rendered from one of the project's diagram DSLs.

**Sequence diagram**: A diagram describing participants and ordered interactions
using `.seq` source.

**Event flow**: A diagram describing events and their producers, consumers,
brokers, channels, publications, and subscriptions using `.eventseq` source.

**Documentation / note**: A Markdown resource using `.md` source. It explains a
system and can link to other project resources.

**MCP**: Model Context Protocol. In this product it is the agent-facing surface
for discovering, reading, writing, validating, rendering, and searching project
documentation. The stdio service works on local files; the remote service works
with authenticated server projects.

## Current Boundaries

- Workspace membership gates project visibility and access. Project roles still
  determine what an authorized member can do inside that project.
- Switching workspaces changes the projects available in the browser.
- Workspace administrators can manage current workspace membership and roles.
- Invitations are not delivered yet.
- Human users and agent identities are distinct actors, even when they access
  the same project.
- Server resource creation, content updates, metadata updates, and moves atomically
  write the canonical row and its matching revision snapshot. Delete cascades
  history with the current resource; local resources remain non-revisioned.
- Revisions are groundwork for future proposals, review, and merge. Those features
  are not implemented here.
