import { describe, expect, it } from "vitest";
import {
  tokenizeEventFlow,
  tokenizeEventFlowLine,
} from "../../../src/language/eventflow/lexer";
import {
  EventFlowDiagnosticCode,
  analyzeEventFlow,
  eventFlowNames,
  parseEventFlow,
  validateEventFlow,
} from "../../../src/language/eventflow/parser";
import {
  brokersOf,
  channelsOf,
  eventsOf,
  publicationsOf,
  servicesOf,
  subscriptionsOf,
  type EventFlow,
} from "../../../src/domain/eventflow/ast";

const FLOW = [
  "title Order Processing",
  "",
  "# who publishes what",
  "event OrderCreated",
  "event PaymentAuthorized",
  "",
  "broker Kafka",
  "topic orders on Kafka",
  "queue billing",
  "",
  "producer OrderService",
  "consumer BillingService",
  "",
  "OrderService publishes OrderCreated to orders",
  "BillingService consumes OrderCreated from orders",
].join("\n");

/** Parse a document, failing loudly when it does not parse cleanly. */
function parse(source: string): EventFlow {
  return parseEventFlow(source).flow;
}

describe("event-flow lexer", () => {
  it("splits a line into words and punctuation with positions", () => {
    const tokens = tokenizeEventFlowLine("topic orders on Kafka", 3);
    expect(tokens.map((token) => token.value)).toEqual([
      "topic",
      "orders",
      "on",
      "Kafka",
    ]);
    expect(tokens[0].range.start).toEqual({ line: 3, column: 0 });
    expect(tokens[3].range).toEqual({
      start: { line: 3, column: 16 },
      end: { line: 3, column: 21 },
    });
  });

  it("tokenizes metadata braces and colons", () => {
    const tokens = tokenizeEventFlowLine("event X {", 0);
    expect(tokens.map((token) => token.type)).toEqual([
      "word",
      "word",
      "braceOpen",
    ]);
    expect(tokenizeEventFlowLine("version: 2", 1).map((t) => t.type)).toEqual([
      "word",
      "colon",
      "word",
    ]);
  });

  it("drops blank lines and whole-line comments", () => {
    const lines = tokenizeEventFlow("event A\n\n# note\nevent B");
    expect(lines.map((line) => line.line)).toEqual([0, 3]);
  });

  it("keeps a hash inside a value", () => {
    const flow = parse(
      [
        "event A {",
        "  schema: https://x/s.json#/Order",
        "}",
        "producer P",
        "P publishes A",
      ].join("\n"),
    );
    expect(eventsOf(flow)[0].metadata[0].value).toBe("https://x/s.json#/Order");
  });
});

describe("event-flow parser", () => {
  it("parses the declarations of a document", () => {
    const flow = parse(FLOW);
    expect(flow.title?.value).toBe("Order Processing");
    expect(eventsOf(flow).map((event) => event.name)).toEqual([
      "OrderCreated",
      "PaymentAuthorized",
    ]);
    expect(brokersOf(flow).map((broker) => broker.name)).toEqual(["Kafka"]);
    expect(channelsOf(flow)).toEqual([
      {
        type: "channel",
        name: "orders",
        channelKind: "topic",
        broker: "Kafka",
        range: channelsOf(flow)[0].range,
      },
      {
        type: "channel",
        name: "billing",
        channelKind: "queue",
        range: channelsOf(flow)[1].range,
      },
    ]);
    expect(servicesOf(flow).map((service) => service.name)).toEqual([
      "OrderService",
      "BillingService",
    ]);
  });

  it("parses a publication and a subscription into edges", () => {
    const flow = parse(FLOW);
    expect(publicationsOf(flow)).toEqual([
      {
        type: "publication",
        producer: "OrderService",
        event: "OrderCreated",
        channel: "orders",
        range: publicationsOf(flow)[0].range,
      },
    ]);
    expect(subscriptionsOf(flow)[0]).toMatchObject({
      type: "subscription",
      consumer: "BillingService",
      event: "OrderCreated",
      channel: "orders",
    });
  });

  it("accepts the verb-first spelling and produces the same edge", () => {
    const flow = parse(
      [
        "event A",
        "producer P",
        "consumer C",
        "publish A from P to orders",
        "consume A by C from orders",
      ].join("\n"),
    );
    expect(publicationsOf(flow)[0]).toMatchObject({
      producer: "P",
      event: "A",
    });
    expect(subscriptionsOf(flow)[0]).toMatchObject({
      consumer: "C",
      event: "A",
    });
  });

  it("leaves the channel optional", () => {
    const flow = parse(["event A", "producer P", "P publishes A"].join("\n"));
    expect(publicationsOf(flow)[0].channel).toBeUndefined();
  });

  it("parses an event's metadata block", () => {
    const flow = parse(
      [
        "event OrderCreated {",
        "  version: 2",
        "  domain: Orders",
        "  schema: schemas/order-created.json",
        "}",
        "producer OrderService",
        "OrderService publishes OrderCreated",
      ].join("\n"),
    );
    const [event] = eventsOf(flow);
    expect(event.metadata).toEqual([
      { key: "version", value: "2", range: event.metadata[0].range },
      { key: "domain", value: "Orders", range: event.metadata[1].range },
      {
        key: "schema",
        value: "schemas/order-created.json",
        range: event.metadata[2].range,
      },
    ]);
    // The declaration's range grows to cover the block.
    expect(event.range.end.line).toBe(4);
  });

  it("keeps metadata keys open-ended", () => {
    const flow = parse(
      [
        "event A {",
        "  partition-key: customerId",
        "  content-type: application/json",
        "}",
        "producer P",
        "P publishes A",
      ].join("\n"),
    );
    expect(eventsOf(flow)[0].metadata.map((entry) => entry.key)).toEqual([
      "partition-key",
      "content-type",
    ]);
  });

  it("projects the first description entry as a normalized semantic field", () => {
    const { flow, diagnostics } = parseEventFlow(
      [
        "event OrderCreated {",
        '  description: " Emitted after persistence. "',
        "  domain: Orders",
        "  description: ignored",
        "  custom: retained",
        "}",
      ].join("\n"),
    );
    const [event] = eventsOf(flow);
    expect(event.description).toBe("Emitted after persistence.");
    expect(event.metadata.map((entry) => entry.key)).toEqual([
      "description",
      "domain",
      "description",
      "custom",
    ]);
    expect(event.metadata[0].range.start.line).toBe(1);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      EventFlowDiagnosticCode.DuplicateMetadataKey,
    );
  });

  it("normalizes empty descriptions and reports unclosed quotes", () => {
    const empty = eventsOf(
      parseEventFlow('event A {\n  description: ""\n}').flow,
    )[0];
    expect(empty.description).toBeUndefined();

    const malformed = parseEventFlow(
      'event A {\n  description: "unfinished\n}',
    );
    expect(
      malformed.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain(EventFlowDiagnosticCode.MalformedDescription);
  });

  it("reports a malformed declaration instead of guessing", () => {
    const { diagnostics } = parseEventFlow("event");
    expect(diagnostics[0].code).toBe(
      EventFlowDiagnosticCode.MalformedDeclaration,
    );
    expect(diagnostics[0].range).toBeDefined();
  });

  it("reports trailing text on a declaration", () => {
    const { diagnostics } = parseEventFlow("event A B");
    expect(diagnostics.map((d) => d.code)).toContain(
      EventFlowDiagnosticCode.MalformedDeclaration,
    );
  });

  it("reports unsupported syntax", () => {
    const { diagnostics } = parseEventFlow("this is not event flow");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(EventFlowDiagnosticCode.UnsupportedSyntax);
    expect(diagnostics[0].severity).toBe("error");
  });

  it("reports duplicate declarations", () => {
    const { diagnostics } = parseEventFlow(
      [
        "event A",
        "event A",
        "producer P",
        "producer P",
        "topic t",
        "topic t",
        "broker K",
        "broker K",
      ].join("\n"),
    );
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain(EventFlowDiagnosticCode.DuplicateEvent);
    expect(codes).toContain(EventFlowDiagnosticCode.DuplicateService);
    expect(codes).toContain(EventFlowDiagnosticCode.DuplicateChannel);
    expect(codes).toContain(EventFlowDiagnosticCode.DuplicateBroker);
  });

  it("reports a repeated metadata key", () => {
    const { diagnostics } = parseEventFlow(
      ["event A {", "  version: 1", "  version: 2", "}"].join("\n"),
    );
    expect(diagnostics.map((d) => d.code)).toContain(
      EventFlowDiagnosticCode.DuplicateMetadataKey,
    );
  });

  it("reports an unclosed metadata block", () => {
    const { diagnostics } = parseEventFlow("event A {\n  version: 1");
    expect(diagnostics.map((d) => d.code)).toContain(
      EventFlowDiagnosticCode.UnclosedMetadata,
    );
  });

  it("reports a malformed metadata line", () => {
    const { diagnostics } = parseEventFlow("event A {\n  version 1\n}");
    expect(diagnostics.map((d) => d.code)).toContain(
      EventFlowDiagnosticCode.MalformedMetadata,
    );
  });

  it("keeps the first title and reports the rest", () => {
    const { flow, diagnostics } = parseEventFlow("title One\ntitle Two");
    expect(flow.title?.value).toBe("One");
    expect(diagnostics.map((d) => d.code)).toContain(
      EventFlowDiagnosticCode.DuplicateTitle,
    );
  });

  it("always returns a document, even from nonsense", () => {
    const { flow } = parseEventFlow("???");
    expect(flow.statements).toEqual([]);
    expect(flow.title).toBeUndefined();
  });
});

describe("event-flow services and names", () => {
  it("infers a service from an edge that mentions one", () => {
    const flow = parse(["event A", "Ghost publishes A"].join("\n"));
    expect(servicesOf(flow)[0]).toMatchObject({
      name: "Ghost",
      role: "producer",
    });
  });

  it("prefers a declaration's role over an inferred one", () => {
    const flow = parse(
      [
        "event A",
        "producer P",
        "consumer C",
        "P publishes A",
        "C consumes A",
      ].join("\n"),
    );
    expect(
      servicesOf(flow).map((service) => [service.name, service.role]),
    ).toEqual([
      ["P", "producer"],
      ["C", "consumer"],
    ]);
  });

  it("lists every name a document mentions", () => {
    expect(eventFlowNames(parse(FLOW))).toEqual({
      events: ["OrderCreated", "PaymentAuthorized"],
      services: ["OrderService", "BillingService"],
      channels: ["orders", "billing"],
      brokers: ["Kafka"],
    });
  });
});

describe("event-flow validation", () => {
  it("reports an edge that names an undeclared service, event or channel", () => {
    const flow = parse(["Ghost publishes Nowhere to missing"].join("\n"));
    const codes = validateEventFlow(flow).map((diagnostic) => diagnostic.code);
    expect(codes).toContain(EventFlowDiagnosticCode.UnknownService);
    expect(codes).toContain(EventFlowDiagnosticCode.UnknownEvent);
    expect(codes).toContain(EventFlowDiagnosticCode.UnknownChannel);
  });

  it("reports a channel naming an undeclared broker", () => {
    const flow = parse("topic orders on Nowhere");
    expect(validateEventFlow(flow).map((d) => d.code)).toContain(
      EventFlowDiagnosticCode.UnknownBroker,
    );
  });

  it("reports an event with no producer", () => {
    const flow = parse("event Lonely");
    const diagnostic = validateEventFlow(flow).find(
      (entry) => entry.code === EventFlowDiagnosticCode.EventWithoutProducer,
    );
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.message).toContain("Lonely");
  });

  it("reports an event that is published but never consumed", () => {
    const flow = parse(["event A", "producer P", "P publishes A"].join("\n"));
    expect(validateEventFlow(flow).map((d) => d.code)).toContain(
      EventFlowDiagnosticCode.EventWithoutConsumer,
    );
  });

  it("reports a channel nothing uses", () => {
    const flow = parse(
      [
        "event A",
        "producer P",
        "consumer C",
        "queue idle",
        "P publishes A",
        "C consumes A",
      ].join("\n"),
    );
    expect(validateEventFlow(flow).map((d) => d.code)).toContain(
      EventFlowDiagnosticCode.ChannelWithoutConsumer,
    );
  });

  it("reports a declared service that does nothing", () => {
    const flow = parse(
      [
        "event A",
        "producer P",
        "consumer C",
        "service Idle",
        "P publishes A",
        "C consumes A",
      ].join("\n"),
    );
    const diagnostic = validateEventFlow(flow).find(
      (entry) => entry.code === EventFlowDiagnosticCode.UnusedService,
    );
    expect(diagnostic?.severity).toBe("info");
  });

  it("reports only the genuine gaps in a realistic document", () => {
    // The sample declares PaymentAuthorized before anything publishes it, and
    // declares a `billing` queue no edge uses — both worth saying, nothing else.
    expect(
      validateEventFlow(parse(FLOW)).map((diagnostic) => diagnostic.code),
    ).toEqual([
      EventFlowDiagnosticCode.EventWithoutProducer,
      EventFlowDiagnosticCode.ChannelWithoutConsumer,
    ]);
  });

  it("accepts a document with no gaps at all", () => {
    const complete = [
      "event A",
      "event B",
      "producer P",
      "consumer C",
      "topic t",
      "P publishes A to t",
      "C consumes A from t",
      "P publishes B to t",
      "C consumes B from t",
    ].join("\n");
    expect(validateEventFlow(parse(complete))).toEqual([]);
  });

  it("combines syntax and semantic diagnostics", () => {
    const { diagnostics } = analyzeEventFlow("event A\n???\nP publishes A");
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain(EventFlowDiagnosticCode.UnsupportedSyntax);
    expect(codes).toContain(EventFlowDiagnosticCode.UnknownService);
  });
});

describe("event-flow causal syntax", () => {
  it("parses explicit message kind and causal initiation", () => {
    const { flow, diagnostics } = parseEventFlow([
      "event ResendNonReceivedWebhookEventsCommand {",
      "  kind: command",
      "}",
      "scheduled initiates ResendNonReceivedWebhookEventsCommand",
    ].join("\n"));
    expect(diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(flow.statements[0]).toMatchObject({ type: "event", kind: "command" });
    expect(flow.causal?.initiations).toMatchObject([
      { kind: "scheduled", message: "ResendNonReceivedWebhookEventsCommand" },
    ]);
  });
  it("keeps independent handler branches explicit", () => {
    const source = [
      "event UpOneTransactionRaisedEvent",
      "event SaveUpOneTransactionCommand",
      "event AddAccountCommand",
      "event AddCorporateAccountCommand",
      "handler TransactionsHandler",
      "handler AccountsHandler",
      "UpOneTransactionRaisedEvent handled by TransactionsHandler",
      "UpOneTransactionRaisedEvent handled by AccountsHandler",
      "TransactionsHandler causes SaveUpOneTransactionCommand",
      "AccountsHandler causes AddAccountCommand",
      "AccountsHandler causes AddCorporateAccountCommand",
    ].join("\n");
    const { flow, diagnostics } = analyzeEventFlow(source);
    expect(
      diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ).toEqual([]);
    expect(flow.causal?.handlers.map((handler) => handler.id)).toEqual([
      "TransactionsHandler",
      "AccountsHandler",
    ]);
    expect(
      flow.causal?.outputs
        .filter((output) => output.handlerId === "AccountsHandler")
        .map((output) => output.event),
    ).toEqual(["AddAccountCommand", "AddCorporateAccountCommand"]);
  });

  it("supports provenance, service ownership, effects, and terminal handlers", () => {
    const source = [
      "event TransactionReceived {",
      "  provenance: unknown",
      "}",
      "handler TransactionHandler in TransactionsService",
      "handler SendEmailHandler",
      "TransactionReceived handled by TransactionHandler",
      "effect persist-transaction on TransactionHandler kind state-update: Persist transaction",
      "TransactionHandler causes TransactionCreated",
      "effect send-email on SendEmailHandler kind notification: Send email",
    ].join("\n");
    const { flow, diagnostics } = analyzeEventFlow(source);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      EventFlowDiagnosticCode.CausalUnknownEvent,
    );
    expect(flow.causal?.handlers[0]).toMatchObject({
      id: "TransactionHandler",
      service: "TransactionsService",
    });
    expect(flow.causal?.effects).toMatchObject([
      {
        id: "persist-transaction",
        kind: "state-update",
        description: "Persist transaction",
      },
      { id: "send-email", kind: "notification", description: "Send email" },
    ]);
    expect(flow.causal?.outputs).toHaveLength(1);
    expect(flow.causal?.handlers[1].range).toBeDefined();
  });

  it("reports causal duplicates, bad references, and invalid provenance", () => {
    const { diagnostics } = analyzeEventFlow(
      [
        "event A {",
        "  provenance: invented",
        "}",
        "handler H",
        "handler H",
        "A handled by Missing",
        "A handled by Missing",
        "H causes MissingEvent",
        "H causes MissingEvent",
        "effect e on H: one",
        "effect e on H: two",
      ].join("\n"),
    );
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        EventFlowDiagnosticCode.InvalidProvenance,
        EventFlowDiagnosticCode.DuplicateHandler,
        EventFlowDiagnosticCode.UnknownHandler,
        EventFlowDiagnosticCode.CausalUnknownEvent,
        EventFlowDiagnosticCode.DuplicateCausalInput,
        EventFlowDiagnosticCode.DuplicateCausalOutput,
        EventFlowDiagnosticCode.DuplicateEffect,
      ]),
    );
    expect(diagnostics.every((diagnostic) => diagnostic.range)).toBe(true);
  });

  it("does not infer causal facts from topology", () => {
    const { flow } = analyzeEventFlow(
      ["event A", "consumer Service", "Service consumes A"].join("\n"),
    );
    expect(flow.causal).toBeUndefined();
  });

  it("parses the same causal source deterministically", () => {
    const source = [
      "event A {",
      "  provenance: external",
      "}",
      "handler H {",
      "  description: Handles A",
      "}",
      "A handled by H",
      "effect e on H kind state: Save state",
    ].join("\n");
    expect(parseEventFlow(source).flow).toEqual(parseEventFlow(source).flow);
  });

  it("parses rich details on events, handlers, and effects", () => {
    const source = [
      "event ThresholdExceeded {",
      "  kind: event",
      "  details: \"\"\"",
      "  Raised after criteria [x] evaluates the persisted MSL transaction.",
      "",
      "  It does not deliver notifications; unknown guarantees remain unknown.",
      "  \"\"\"",
      "}",
      "handler CriteriaHandler {",
      "  details: \"\"\"",
      "  Decides whether the configured threshold is exceeded.",
      "  \"\"\"",
      "}",
      "ThresholdExceeded handled by CriteriaHandler",
      "effect persist on CriteriaHandler kind state-update: Persist transaction {",
      "  details: \"\"\"",
      "  Writes the transaction; punctuation: { } : # is plain text.",
      "  \"\"\"",
      "}",
    ].join("\n");
    const { flow, diagnostics } = parseEventFlow(source);
    expect(diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(eventsOf(flow)[0].details).toBe(
      "Raised after criteria [x] evaluates the persisted MSL transaction.\n\nIt does not deliver notifications; unknown guarantees remain unknown.",
    );
    expect(flow.causal?.handlers[0].details).toBe(
      "Decides whether the configured threshold is exceeded.",
    );
    expect(flow.causal?.effects[0].details).toContain("punctuation: { } : #");
    expect(parseEventFlow(source).flow).toEqual(flow);
  });

  it("keeps absent and empty details absent and preserves legacy flows", () => {
    const legacy = parseEventFlow("event A\nhandler H\nA handled by H");
    expect(legacy.diagnostics).toEqual([]);
    expect(eventsOf(legacy.flow)[0].details).toBeUndefined();
    const empty = parseEventFlow([
      "event A {",
      "  details: \"\"\"",
      "  \"\"\"",
      "}",
    ].join("\n"));
    expect(empty.diagnostics).toEqual([]);
    expect(eventsOf(empty.flow)[0].details).toBeUndefined();
  });

  it("parses evidence-backed failure and distinct recovery semantics", () => {
    const { flow, diagnostics } = analyzeEventFlow([
      "event RetryCommand {",
      "  kind: command",
      "}",
      "handler DeliveryHandler",
      "failure delivery-failed on handler DeliveryHandler {",
      "  classification: processing",
      "  owner: handler",
      "}",
      "retry delivery-retry for delivery-failed {",
      "  mechanism: handler",
      "  target: same-execution",
      "  max-attempts: 3",
      "  delay: 2s",
      "  backoff: exponential",
      "  exhaustion: manual",
      "}",
    ].join("\n"));
    expect(diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(flow.causal?.failures?.[0]).toMatchObject({ id: "delivery-failed", target: { kind: "handler", id: "DeliveryHandler" }, classification: "processing" });
    expect(flow.causal?.retries?.[0]).toMatchObject({ id: "delivery-retry", mechanism: "handler", target: "same-execution", maxAttempts: 3, delay: "2s", exhaustion: "manual" });
  });

  it("keeps unknown policy absent and rejects impossible policy values", () => {
    const result = analyzeEventFlow([
      "failure f on message Missing",
      "retry r for f {",
      "  max-attempts: 0",
      "  delay: later",
      "}",
    ].join("\n"));
    expect(result.flow.causal?.retries?.[0].mechanism).toBeUndefined();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(EventFlowDiagnosticCode.InvalidRetryPolicy);
  });
});
