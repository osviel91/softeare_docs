# Resource Diff

`ResourceDiff` is a pure comparison of two complete `ResourceState` values. A
state contains content, resource type, and semantic resource metadata. A
`ResourceRevision` and a proposal candidate can both be projected into this
shape without exposing database rows to the diff engine.

The common envelope contains:

- `metadata`: description and case-insensitive tag changes;
- `content`: a representation-specific semantic diff and parser diagnostics;
- `source`: deterministic bounded line hunks for exact or fallback review;
- `summary`: stable counts by change kind and entity.

Event Flow uses event names as identity. Publications are matched by event and
producer; subscriptions by event and consumer. Channel and broker declaration
changes are reported separately, and relationship channel changes are modified
relationships. Event metadata is an open, case-insensitive key map, so unknown
keys remain diffable. Event renames are intentionally an added event plus a
removed event.

Sequence messages have no stable cross-version node identity. H15 therefore uses
deterministic positional message alignment, which is conservative when messages
are inserted or reordered. Participant ids are stable identities; formatting-only
changes produce no semantic changes.

Markdown uses deterministic line/block changes rather than NLP. All
representations also retain bounded source hunks. If either DSL has an error,
semantic content is marked unavailable while source hunks and diagnostics remain
available.

Proposal diffs always compare `baseRevision` to the candidate. The current
canonical revision and `stale` flag are reported separately. A semantic diff is
not merge, conflict detection, or approval; those concerns are deliberately
outside H15.
