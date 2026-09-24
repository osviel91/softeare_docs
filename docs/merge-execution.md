# Change Proposal Merge Execution

Merging is an application operation, not a client-side application of a previously returned analysis. The server reloads the open proposal, its immutable BASE revision, the latest CURRENT revision, and the candidate, then recomputes H17 analysis inside the operation. The H17 candidate is passed to the normal H13 canonical mutation path.

The existing `resource:update` permission authorizes a merge. A proposal author is not automatically allowed to merge; the merge actor must have the same canonical mutation permission as any other resource update.

An authorized merge may be stale when H17 reports it is compatible. In that case the candidate is built from CURRENT plus the compatible proposal changes; PROPOSED never replaces CURRENT wholesale. Conflicts, invalid BASE/CURRENT/PROPOSED states, and no-op candidates are rejected without changing canonical state. Manual conflict resolution is not available.

The canonical revision bump, immutable `ResourceRevision` snapshot, audit/journal entry, and `open` to `merged` proposal transition are committed in one database transaction. The proposal is conditionally updated by proposal id and version, and the resource is conditionally updated by its expected canonical revision. A race therefore fails rather than overwriting either newer canonical content or a newer candidate. The H13 journal stages and atomically promotes filesystem bytes and can recover an interrupted filesystem half.

Successful state-changing merges create exactly one canonical revision and record `mergedRevision`, `mergedAt`, and `mergeActor`. The original proposal author and BASE revision remain unchanged. Merged proposals are terminal and retain their candidate for inspection. No-op proposals are rejected as `no_op` and remain open; they do not create an empty revision.

HTTP uses `POST /api/change-proposals/:proposalId/merge`. MCP exposes `merge_change_proposal`. Both call the same application operation and return the resulting resource revision on success.
