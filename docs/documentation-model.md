# Canonical Documentation Model

This document is the normative documentation model for Software Docs Manager.
It defines how humans and coding agents choose documentation boundaries,
representations, names, metadata, and granularity. The repository remains the
source of truth for implementation detail; this model records the semantic
knowledge that is expensive to reconstruct repeatedly.

## Purpose And Philosophy

Documentation should optimize for architectural understanding, business-flow
understanding, asynchronous behavior, important contracts, business rules,
invariants, infrastructure boundaries, operational constraints, and agent
discoverability.

It should not narrate source code line by line. A useful claim is grounded in
repository evidence and explains a responsibility, relationship, rule, or
outcome that is not obvious from the visual itself.

The canonical dimensions are:

| Representation | Primary question                         | Semantic dimension          | Current status                   |
| -------------- | ---------------------------------------- | --------------------------- | -------------------------------- |
| Sequence       | How does this flow execute?              | Execution / time            | Implemented as `.seq`            |
| Event Flow     | What causes what asynchronously?         | Causality / reaction        | Implemented as `.eventseq`       |
| Conceptual     | What concepts or components relate?      | Structure / relationships   | Future contract; not implemented |
| Database       | What data is persisted and how?          | Data / persistence          | Future contract; not implemented |
| Note           | What rule, decision, or context matters? | Context / rules / decisions | Implemented as Markdown (`.md`)  |

Conceptual and Database are semantic contracts for future representations, not
current product capabilities. Do not claim that the product can create,
render, search, or persist them as dedicated diagram types.

## Representation Selection

Use these questions to choose the first useful view; Sequence and Event Flow are
orthogonal projections, not mutually exclusive classifications:

1. A business or use-case execution: **Sequence**.
2. Asynchronous reactions and causal event chains: **Event Flow**.
3. Structural, domain, or architectural relationships: **Conceptual**.
4. Persistence schema and data relationships: **Database**.
5. A cross-cutting rule, decision, or context: **Note**.

Multiple views are appropriate when they answer different questions. A business
Sequence may include asynchronous messages when they are part of the ordered
collaboration, while an Event Flow can separately preserve the meaningful causal
chain behind those messages. Sequence answers execution, time, and component
collaboration; Event Flow answers asynchronous causality, message provenance,
handler responsibility, caused messages, and effects. For example, the UpOne
fan-out from `UpOneTransactionRaisedEvent` through multiple handlers, commands,
and persistence effects can remain a useful ordered Sequence and also be
documented as an Event Flow when that evidence forms a meaningful causal
context. Do not mechanically duplicate every Sequence as an Event Flow; add the
second view only when real asynchronous causal structure is present.

When two resources document substantially the same behavior from these different
angles, record a semantic `complementary-view` relationship. This is stronger
than a Markdown hyperlink: it is stored by stable resource id and exposes the
other resource as a navigable execution or causal view. Do not create the
relationship for merely adjacent topics, shared components, or every pair of a
Sequence and Event Flow.

Similarly, `Merge Change Proposal.seq` can show execution, a proposal
collaboration Event Flow can show asynchronous reactions, a future conceptual
view can show proposal relationships, and a future Database view can show
persistence. These views complement one another; they are not duplicate
accounts of the same fact.

### Assessment guidance

An **INCOMPLETE** representation uses the correct representation and semantic
boundary, but important knowledge is missing. A **MISREPRESENTED** resource uses
a representation whose semantics do not match the observed system behavior.
For example, synchronous HTTP routing represented as an asynchronous Event Flow
is MISREPRESENTED, not merely incomplete.

## Sequence Diagrams

### Contract

A Sequence Diagram documents one recognizable business or application flow.
It answers: **How does the system execute this business/use-case flow?**

Good boundaries include `Create Workspace`, `Approve Local Account`, `Merge
Change Proposal`, `Place Order`, and `Cancel Subscription`. A controller,
HTTP route, repository method, or database access is not a flow boundary.

The flow normally starts with a meaningful actor or system intention and ends
at the business or application outcome. Do not split a diagram merely because
the implementation crosses files, classes, layers, or services. Split when the
actor intent and business outcome are independently meaningful.

### Participants

Participants represent meaningful collaborators or responsibility boundaries:
an Actor, UI, API, Application Service, Domain Service, Repository, Database,
or External System. Avoid incidental classes and helper functions unless they
are architecturally significant. A reader should understand responsibility
boundaries without knowing the source tree.

### Granularity heuristic

Before creating a Sequence Diagram, ask:

1. Is there a recognizable actor or system intention?
2. Is there a meaningful business or application outcome?
3. Does understanding the collaboration cross multiple responsibilities or
   boundaries?
4. Would the diagram reduce the need to reconstruct the flow from source?

If the answers are generally yes, the flow is a valid candidate. Keep internal
steps in the same diagram when they exist primarily to serve one use case.
Prefer `Merge Change Proposal` over separate diagrams for loading the proposal,
analyzing it, saving a revision, and changing proposal status.

### Annotations

Annotations add semantics that the visual already does not provide. Prioritize:

- business rules and invariants;
- validation and authorization constraints;
- important request, response, query, or result contracts;
- transaction boundaries and concurrency behavior;
- idempotency requirements;
- external-system contracts;
- relevant failure behavior;
- non-obvious infrastructure behavior.

For example, an interaction with `PostgreSQL` may be annotated with “Returns
workspace, membership, and permissions” and “Invariant: workspace belongs to
the requesting tenant.” Avoid notes such as “Calls the repository” when the
message already says that.

## Event Flows

### Contract

An Event Flow is a connected view of asynchronous or event-driven behavior
within a meaningful event context. It answers:

- What causes what in the asynchronous system?
- How does the system react when an event occurs?

HTTP requests, synchronous calls, reverse-proxy routing, cron invocation,
logs/telemetry, and infrastructure topology do not establish an Event Flow by
themselves. A project may legitimately contain no Event Flow documentation.
Keep synchronous or structural behavior in its appropriate representation; do
not force it into Event Flow.

It is not merely `producer -> topic -> consumer`. The important model is:

`Event -> Handler -> Effects -> Resulting Events` is an investigation heuristic
when real asynchronous behavior exists, not a mandatory shape for every Event
Flow or every event-like trigger. No asynchronous event context observed is a
valid result, and is preferable to inventing Event Flow coverage.

Effects may include database mutations, external API calls, command dispatch,
notifications, state transitions, and resource creation or deletion.

### Event provenance

Distinguish provenance whenever repository evidence supports it:

- **External event**: enters the documented system boundary, such as a payment
  provider event, GitHub webhook, or message from another bounded context.
- **Internal event**: is produced by the documented application or system,
  such as `OrderPaid`, `ProposalMerged`, or `WorkspaceDeleted`.

Do not guess provenance when the system boundary is ambiguous. Record it as
unknown or omit the claim.

### Handlers and causal semantics

Handlers or consumers are separate semantic concepts in the causal model. When
real asynchronous behavior exists, a reader should be able to discover who
consumes an important event, which handler is responsible, what effects occur,
and what events can result. A broker or channel is infrastructure context, not
a substitute for handler responsibility. The model preserves incomplete
knowledge and does not infer a handler from a consuming service.

The domain representation is an optional causal aggregate alongside the legacy
topology relations: `Event -> Handler -> Effects / Resulting Events`. Handler
inputs and outputs are explicit, so fan-out branches do not create cross-product
edges. Effects have an identity, optional kind, description, and open metadata;
they are not coupled to a database, HTTP client, mail system, or other
technology. Commands and events remain one message-level concept, with an
optional explicit `kind: event|command` metadata value preserved by Causal.

Legacy projections still show services consuming and publishing events, while
the domain model now also carries explicit named handlers, effects, and
handler-specific resulting-event edges. No existing projection infers those
causal facts or changes its legacy appearance.

The canonical authoring form is line-oriented and reference-based:

```text
event TransactionReceived {
  provenance: external
}
event TransactionCreated
handler TransactionHandler in TransactionsService
TransactionReceived handled by TransactionHandler
effect persist-transaction on TransactionHandler kind state-update: Persist transaction
TransactionHandler causes TransactionCreated
```

The `effect` line has no resulting message requirement, so terminal handlers and
partially documented branches remain valid.

Semantic-diff handoff: causal declarations already have stable identities in the
domain model (`handler.id`, `effect.id`, and handler/message pairs) and source
ranges for evidence. A later diff can therefore report handler, input, output,
effect, and provenance additions/removals/changes without changing persistence;
the causal diff UI and proposal-specific presentation remain future work.

### Causal investigation view

The Event Flow **Causal** view is a presentation of explicit causal facts, not
another semantic model. Flow shows event movement, Catalog shows event facts,
and Topology shows service connectivity; Causal shows message-to-handler,
handler-to-message, and handler-to-effect relationships.

Selecting an event, handler, or effect keeps the full graph in place while
emphasizing its immediate causal neighborhood. Upstream means explicit paths
that may produce or precede the selection; downstream means explicit paths that
may follow it. Effects remain owned by their handler and are not rendered as
events in the causal chain. External, internal, and unknown provenance are
shown as message context, not as a causal claim. An optional causal initiation
line (`scheduled`, `external`, `manual`, `startup`, or `unknown` `initiates
<message>`) explains why a root message exists; initiation is independent from
provenance. A scheduler can initiate an internal command. Do not infer
initiation from publication topology.

Legacy topology-only flows intentionally have an empty Causal view. The view
explains that topology is documented but explicit Handler-based causality is
not; it does not infer relationships from `publishes` and `consumes`.

### Event annotations

Add annotations or metadata when they materially affect understanding. Useful
information includes:

- description and trigger/provenance;
- preconditions and business rules;
- reads and writes;
- produced or failure events;
- retry and idempotency behavior;
- ordering and delivery semantics;
- transaction boundary;
- correlation and causation identifiers;
- relevant schema or version.

These are recommendations, not a mandatory checklist. Never invent retry,
transaction, delivery, or idempotency behavior.

### Granularity and context boundaries

Unlike Sequence Diagrams, Event Flows are not one business flow per file. The
primary boundary is a bounded event context: a domain capability, connected
causal network, shared state transition, or strong producer/consumer cluster.
Examples include `Order Lifecycle Events`, `Payment Processing Events`,
`Resource Mutation Events`, and `Proposal Collaboration Events`.

Keep directly causal or strongly related events together even when the graph is
visually large. Split when the graph becomes semantically unrelated, not merely
because it has many nodes. Avoid one file per handler or event when those files
would hide one connected investigation context.

An Event Flow should support investigation. A reader should be able to ask:

- Where can this event originate, and is it external or internal?
- Who consumes it and which handler is responsible?
- What state does it affect and what events can it produce?
- What consumes those events and where does the chain terminate?
- Are there cycles, suspicious missing consumers, unexpected fan-outs, or
  hidden side effects?

## Current Event Flow Capability Gap Analysis

The current `.eventseq` model supports the legacy topology relation model plus
an optional explicit causal aggregate. It has `event`, `broker`,
`topic`/`queue`/`stream`, `producer`/`consumer`/`service`, publication,
subscription, event metadata, named handlers, handler inputs and outputs, and
handler-owned effects. Publications and subscriptions remain topology edges;
causal ordering and cycles are derived in the Flow projection, while the Causal
projection and investigation view use only explicit handler facts.

| Canonical need                                                           | Current status                           | Assessment                                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Events, producers, consumers, channels, brokers                          | Supported                                | Native AST, validation, index, outline, projections, and renderer                                                         |
| Event descriptions and schema/domain/version metadata                    | Supported                                | Open `key: value` metadata on event declarations; conventional keys include `domain`, `version`, and `schema`             |
| Publication/subscription relationships and fan-out                       | Supported                                | Native edges; validation reports unknown names and missing producers/consumers                                            |
| Derived causal ordering and cycle indication                             | Supported                                | Flow projection derives order and marks residual cycles                                                                   |
| Source traceability                                                      | Supported                                | Source ranges and stable node IDs cover declarations and edges; metadata entries belong to their event node               |
| Broker/channel topology                                                  | Supported                                | Channel kind and optional broker are represented and projected                                                            |
| Provenance: external versus internal                                     | Supported                                | Optional normalized event field; unknown is explicit and no naming inference is performed                                 |
| Handler identity and handler location                                    | Supported                                | Causal handlers have stable identity and optional hosting service; topology subscriptions remain independent              |
| Handler preconditions, reads, writes, and business effects               | Partially supported                      | Effects are first-class with open metadata; later phases may add richer structured semantics                              |
| Produced events as explicit handler results                              | Supported                                | Explicit handler-output edges preserve independent fan-out branches                                                       |
| Failure events, retries, idempotency, ordering, delivery semantics       | Expressible through annotations/metadata | No validation or structured semantics; unsupported claims must remain unknown                                             |
| Correlation and causation identifiers                                    | Expressible through annotations/metadata | No dedicated event or edge fields                                                                                         |
| Explicit event-to-handler-to-effect graph                                | Supported                                | Explicit `handler`, `handled by`, `causes`, and `effect` lines populate the causal aggregate |
| Trace exploration, fan-out investigation, missing-consumer investigation | Partially supported                      | The Causal investigation view exposes explicit paths and fan-out; topology-only flows remain intentionally non-causal |

This gap analysis is descriptive, not an implementation plan. D01 does not
change the DSL, AST, persistence, MCP surface, or renderer. Later evolution
must preserve current source traceability and avoid turning every annotation
into a required structured field prematurely.

## Notes

A Note is semantic supporting documentation for knowledge that does not need a
dedicated execution, causal, structural, or persistence representation. Good
subjects include authorization models, resource mutation invariants, deployment
constraints, idempotency strategy, transaction guarantees, external API
assumptions, business rules, and operational recovery behavior.

Use a diagram annotation when the information belongs directly to an element or
interaction in that diagram. Use a standalone Markdown Note when it spans
multiple flows, describes a cross-cutting policy or decision, would overload a
diagram, or deserves independent search and discovery. Do not duplicate one
authoritative explanation across diagrams; link or reference the Note when the
product supports that relationship.

## Metadata And Naming

Metadata is semantic context for humans and agents, not prose repeated in every
search result.

- **Title**: use a human-readable semantic name, such as `Merge Change
Proposal`, not `merge-change-proposal.seq`.
- **Description**: explain what the resource documents and why it matters.
  Improve discovery and do not merely repeat the title.
- **Tags**: use stable classification terms such as `proposals`,
  `collaboration`, `persistence`, `authorization`, `events`, and `deployment`.
  Reuse established project vocabulary instead of creating near-duplicates.

Resource paths should derive from semantic intent: `merge-change-proposal.seq`,
`workspace-authorization.md`, and `proposal-collaboration.eventflow` are good
examples. Avoid paths tied unnecessarily to implementation artifacts such as
`ChangeProposalController.seq`, `POST-api-proposals.seq`, or `handler2.eventflow`.
Current paths use `.seq` for Sequence, `.eventseq` for Event Flow, and `.md` for
Notes/documentation; this model does not introduce new extensions for future
Conceptual or Database views.

## Duplication And Evidence

Before creating a resource, inspect existing documentation. Search by title,
description, and tags, then read relevant diagrams and Notes. Prefer updating
the canonical resource or creating a Change Proposal against it. If two
resources substantially overlap, report the overlap instead of silently adding
a second version.

Every important claim should be classified mentally as:

- **Observed**: directly supported by source, tests, configuration, or an
  existing documented contract.
- **Inferred**: a reasoned conclusion from evidence, explicitly marked when it
  matters to a reader.
- **Unknown**: not established by available evidence; omit it or say it is
  unknown rather than guessing.

This rule is especially important for retry behavior, transaction boundaries,
event delivery guarantees, idempotency, authorization, and external/internal
event provenance.

Important claims should retain source references when the current
representation supports them. Current AST nodes carry source ranges and derive
stable node IDs for Sequence and Event Flow declarations and interactions.
Future representations should preserve equivalent traceability; D01 does not
add source-link infrastructure.

## Future Conceptual Diagram Contract

Conceptual Diagrams represent **structure and relationships**. They answer:
**What are the important concepts or components and how are they related?**

Domain examples include `Workspace contains Project` and `Membership grants
Role`. Architecture examples include `Browser -> Nginx -> Application Server`
with PostgreSQL, project volume, and OIDC provider relationships.

They must not represent temporal execution. Use Sequence when order and time
are central; use Event Flow when asynchronous causality and reaction are
central. A Conceptual Diagram should address one coherent structural question,
such as the workspace authorization model, documentation resource model,
deployment architecture, or proposal lifecycle relationships. Avoid an
unreadable “entire application architecture” catch-all graph.

## Future Database Diagram Contract

Database Diagrams represent **data and persistence**. They expose only
architecturally relevant tables or entities, fields, primary keys, foreign
keys, cardinality, uniqueness, important indexes, constraints, and
business-relevant persistence invariants. They should not replicate every
database implementation detail by default.

For example, a proposal persistence view may show `change_proposals` with its
revision, status, actor, and merge fields related to `resources`, annotated with
optimistic concurrency and immutable terminal transitions. This is a future
representation, not a current `.seq`, `.eventseq`, or `.md` capability.

## Coverage Model

Project coverage is a conceptual review model, not a score, dashboard,
persistence feature, or API. Assess whether the project has useful coverage of:

- **Business Flows**: recognizable application/use-case executions.
- **Event Contexts**: bounded asynchronous causal networks.
- **Concepts**: important domain or architecture relationships.
- **Persistence**: important data and storage relationships.
- **Cross-cutting Notes**: policies, constraints, decisions, and operational
  context.

An assessment can say, for example, that `Create Workspace` and `Approve
Account` are covered while `Delete Workspace` is missing, or that `Resource
Mutation Events` exists while `Proposal Collaboration Events` is missing.

## Canonical Agent Workflow

An agent documenting a repository should follow this order:

1. Inspect existing project documentation and metadata.
2. Inspect the repository architecture and relevant source.
3. Discover meaningful business/application flows.
4. Discover asynchronous and event behavior.
5. Discover important structural concepts.
6. Discover persistence boundaries and invariants.
7. Discover cross-cutting rules, constraints, and decisions.
8. Compare discovered knowledge with existing documentation.
9. Identify missing, stale, or overlapping resources.
10. Propose updates through Change Proposals where appropriate.

Discovery precedes authoring. An agent should not create a diagram merely
because it found the first interesting code path. The goal is semantic
consistency: agents inspecting approximately the same evidence should tend
toward comparable representation choices, boundaries, names, metadata,
annotations, and coverage assessments, without requiring byte-for-byte output.

## Dogfooding Plan

After MCP documentation guidance exists, use a coding agent to inspect this
repository with this model and produce a proposed plan covering Business
Flows, Event Contexts, Concepts, Persistence, and Notes. Compare it with the
existing project documentation. Apply any updates through Change Proposals,
not direct canonical mutation. This exercise is a future validation of
reproducibility and is not part of D01 execution.
