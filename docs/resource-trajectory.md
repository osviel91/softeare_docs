# Resource Trajectory

Review navigation is project-scoped: the proposal sidebar lists every proposal
in the selected project, while resource indicators are derived from the same
proposal data and show only open changes.

The review compare workspace uses the available editor width and a shared
viewport group. BASE, CURRENT, and PROPOSED therefore participate in one linked
pan/zoom state without pairwise synchronization.

History entered from a resource is scoped to that resource. Project History and
Resource History now use the same bounded server projection; the latter is only
the project result filtered by resource id. `ResourceTrajectory` is a derived
read model over `resource_revisions` and terminal `change_proposals`. No
trajectory table or document-content copy is persisted.

Entries are `RESOURCE_CREATED`, `RESOURCE_UPDATED`, and `PROPOSAL_MERGED`.
Direct revision authorship and immutable revision timestamps supply actor and
time. A merged proposal is attached to the revision named by
`merged_revision`; its proposal author and merge actor remain distinct. Entries
are ordered by occurred time descending, then stable entry id descending.

Reads are authorized as `resource:read`, capped at 100 entries per request, and
continue with a numeric offset cursor. The SQL projection is bounded before the
application returns the page and avoids one query per history entry.

`Create checkpoint` remains a browser-local version-history operation. It does
not create a server `ResourceRevision`, so it is not labeled as a canonical
`CHECKPOINT_CREATED` event. Server checkpoint provenance should be added only
when a server checkpoint operation exists and can persist actor/time atomically.

Legacy baseline revisions created by the H13 backfill retain system authorship;
the UI renders missing/unknown provenance as `Unknown` rather than guessing.
Historical proposals are fetched by their stable id and opened read-only from a
trajectory merge entry. The existing proposal route already serves terminal
proposals; the review action disables merge and reopen behavior.
