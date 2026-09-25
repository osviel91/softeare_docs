# Resource Trajectory

Review navigation is project-scoped: the proposal sidebar lists every proposal
in the selected project, while resource indicators are derived from the same
proposal data and show only open changes.

The review compare workspace uses the available editor width and a shared
viewport group. BASE, CURRENT, and PROPOSED therefore participate in one linked
pan/zoom state without pairwise synchronization.

History entered from a resource is scoped to that resource. Project History
continues to show the project-wide branches. `ResourceTrajectory` is a derived
presentation model: revisions remain canonical snapshots, and proposal events
remain collaboration events. A merge can point at its resulting revision
without creating a synthetic revision.

The browser's server mode currently exposes proposal merge provenance but does
not expose the server revision/audit listing endpoints. Until those read APIs
exist, server History must not fabricate actors or merge events from incomplete
data.
