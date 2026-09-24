# Change Proposal Merge Analysis

Merge analysis is a read-only three-way comparison of a proposal's `BASE`, the
current canonical resource, and `PROPOSED` state. It reports:

- `stale`: the canonical revision advanced beyond the proposal base.
- `conflicted`: both sides changed incompatible semantic or source state.
- `autoMergeable`: a valid in-memory candidate can be constructed safely.

H17 does not execute merges, approve proposals, resolve conflicts, or mutate
canonical resources, proposals, revisions, journals, or audit records.

Event Flow uses event names and relationship identities rather than AST node
ids. Event metadata keys, publications, subscriptions, channels, and broker
fields are compared independently where the parser exposes them. Delete versus
modify and concurrent changes to one relationship are explicit conflicts.

Sequence interaction identity remains positional because the language does not
yet provide stable cross-version interaction identity. Concurrent interaction
changes are therefore reported conservatively as ambiguous rather than merged.

Markdown uses deterministic line-based three-way composition. Non-overlapping
hunks are composed from the original source lines; overlapping incompatible
hunks are conflicts. Candidate source is never produced by a lossy formatter.

Invalid proposed content is reported with `status: invalid-proposed` and parser
diagnostics, not as a semantic conflict. Invalid base or current canonical
content is reported as an integrity status. Candidate state is in memory only.
