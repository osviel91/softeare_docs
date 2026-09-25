# Causal Event Flow MCP Dogfooding

## Finding

The external agent used the remote MCP service. The parser and D03 causal model
were implemented, but the remote service exposed only project resources while
its initialize guidance said the DSL grammar was available through resources.
There was therefore no discoverable public Event Flow reference containing the
`handler`, `handled by`, `causes`, `effect`, and provenance forms. The remote
`upsert_event_flow` description also did not say that causal validation happens
before persistence or return its diagnostics. A stale stdio prompt compounded
the ambiguity by describing handler/effect details as potentially unsupported.

## Correction

The remote MCP service now advertises and serves the generated Event Flow DSL
reference. Its instructions and `upsert_event_flow` contract describe explicit
causal authoring, event metadata provenance, Markdown's cross-cutting Note
boundary, and the distinction between useful Notes and unsupported Conceptual
or Database representations. Pre-write Event Flow validation now returns its
diagnostic codes and messages. The stdio prompt and capability table were
updated to match D03.

The remote MCP integration regression discovers the reference through
`resources/list` and `resources/read`, creates a minimal causal flow through
`upsert_event_flow`, and verifies an unknown handler is rejected without a
write.

## Representation selection regression

The UpOne fan-out is intentionally a dual-view case. Its Sequence remains valid
because it explains ordered collaboration from `UpOneTransactionRaisedEvent`
through handlers, commands, and persistence. The same evidence also warrants an
Event Flow when the asynchronous causal links are meaningful: message/event ->
handler -> caused messages/commands -> handlers -> effects. Guidance must not
force the agent to choose one representation or create an Event Flow for every
Sequence.

## Remaining limitations

Conceptual and Database remain unsupported representations. The correction does
not turn them into Markdown automatically; an agent should create a Markdown
Note only for genuinely cross-cutting context and otherwise report the missing
representation. Event Flow metadata remains open-ended and evidence-based;
retry, delivery, transaction, and other claims are not structured or inferred.
