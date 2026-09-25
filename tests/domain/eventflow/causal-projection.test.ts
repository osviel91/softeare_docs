import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../../src/language/eventflow/parser";
import {
  downstreamCausalNeighbors,
  effectId,
  effectsForHandler,
  handlerNodeId,
  handlersForMessage,
  inputsForHandler,
  messageId,
  outputsForHandler,
  projectEventFlowToCausalView,
  upstreamCausalNeighbors,
} from "../../../src/domain/eventflow/causal-projection";

function project(source: string) {
  return projectEventFlowToCausalView(parseEventFlow(source).flow);
}

describe("projectEventFlowToCausalView", () => {
  it("keeps independent fan-out branches independent", () => {
    const view = project([
      "event UpOneTransactionRaisedEvent",
      "event AddAccountCommand",
      "event AddCorporateAccountCommand",
      "event SaveUpOneTransactionCommand {",
      "  kind: command",
      "}",
      "handler TransactionsHandler",
      "handler AccountsHandler",
      "UpOneTransactionRaisedEvent handled by TransactionsHandler",
      "UpOneTransactionRaisedEvent handled by AccountsHandler",
      "TransactionsHandler causes SaveUpOneTransactionCommand",
      "AccountsHandler causes AddAccountCommand",
      "AccountsHandler causes AddCorporateAccountCommand",
    ].join("\n"));

    expect(view.edges.map(({ type, from, to }) => [type, from, to])).toEqual([
      ["MESSAGE_HANDLED_BY_HANDLER", "message:UpOneTransactionRaisedEvent", "handler:TransactionsHandler"],
      ["MESSAGE_HANDLED_BY_HANDLER", "message:UpOneTransactionRaisedEvent", "handler:AccountsHandler"],
      ["HANDLER_CAUSES_MESSAGE", "handler:TransactionsHandler", "message:SaveUpOneTransactionCommand"],
      ["HANDLER_CAUSES_MESSAGE", "handler:AccountsHandler", "message:AddAccountCommand"],
      ["HANDLER_CAUSES_MESSAGE", "handler:AccountsHandler", "message:AddCorporateAccountCommand"],
    ]);
    expect(outputsForHandler(view, handlerNodeId("TransactionsHandler")).map((item) => item.name)).toEqual([
      "SaveUpOneTransactionCommand",
    ]);
    expect(outputsForHandler(view, handlerNodeId("AccountsHandler")).map((item) => item.name)).toEqual([
      "AddAccountCommand",
      "AddCorporateAccountCommand",
    ]);
    expect(view.messages.find((item) => item.name === "SaveUpOneTransactionCommand")?.kind).toBe("command");
  });

  it("does not infer causal edges from topology", () => {
    const view = project([
      "event A", "event B", "event C", "event D", "service S",
      "S consumes A", "S consumes C", "S publishes B", "S publishes D",
    ].join("\n"));
    expect(view.messages).toHaveLength(0);
    expect(view.edges).toEqual([]);
  });

  it("projects a chain, effect ownership, and source traceability", () => {
    const view = project([
      "event TransactionReceived", "event TransactionCreated",
      "handler TransactionHandler in TransactionsService",
      "TransactionReceived handled by TransactionHandler",
      "effect persist-transaction on TransactionHandler kind state: persist transaction",
      "TransactionHandler causes TransactionCreated",
    ].join("\n"));
    const handler = handlerNodeId("TransactionHandler");

    expect(handlersForMessage(view, messageId("TransactionReceived"))[0]).toMatchObject({
      id: handler, service: "TransactionsService",
    });
    expect(effectsForHandler(view, handler)).toMatchObject([
      { id: effectId("persist-transaction"), handlerId: handler, kind: "state" },
    ]);
    expect(downstreamCausalNeighbors(view, messageId("TransactionReceived"))).toEqual([handler]);
    expect(upstreamCausalNeighbors(view, messageId("TransactionCreated"))).toEqual([handler]);
    expect(view.messages.find((item) => item.name === "TransactionCreated")?.sourceNodeIds).toHaveLength(2);
    expect(view.handlers[0].sourceNodeIds).toHaveLength(1);
  });

  it("keeps fan-in messages singular and traversable", () => {
    const view = project([
      "event BlockACompleted", "event BlockBCompleted", "event ReportReady",
      "handler CompletionHandlerA", "handler CompletionHandlerB", "handler DeliveryHandler",
      "BlockACompleted handled by CompletionHandlerA", "CompletionHandlerA causes ReportReady",
      "BlockBCompleted handled by CompletionHandlerB", "CompletionHandlerB causes ReportReady",
      "ReportReady handled by DeliveryHandler",
    ].join("\n"));

    expect(view.messages.filter((item) => item.name === "ReportReady")).toHaveLength(1);
    expect(inputsForHandler(view, handlerNodeId("DeliveryHandler")).map((item) => item.name)).toEqual([
      "ReportReady",
    ]);
    expect(upstreamCausalNeighbors(view, messageId("ReportReady"))).toEqual([
      handlerNodeId("CompletionHandlerA"), handlerNodeId("CompletionHandlerB"),
    ]);
  });

  it("keeps the negative-balance chain readable with message kinds", () => {
    const view = project([
      "event MslTransactionCreated",
      "event TransactionLedgerBalanceThresholdExceededEvent",
      "event SendEmailCommand {", "  kind: command", "}",
      "handler MslTransactionCriteriaHandler",
      "handler NegativeBalanceNotificationHandler",
      "MslTransactionCreated handled by MslTransactionCriteriaHandler",
      "MslTransactionCriteriaHandler causes TransactionLedgerBalanceThresholdExceededEvent",
      "TransactionLedgerBalanceThresholdExceededEvent handled by NegativeBalanceNotificationHandler",
      "NegativeBalanceNotificationHandler causes SendEmailCommand",
    ].join("\n"));
    expect(view.edges.filter((edge) => edge.type === "HANDLER_CAUSES_MESSAGE")).toHaveLength(2);
    expect(view.messages.find((item) => item.name === "SendEmailCommand")?.kind).toBe("command");
  });

  it("keeps export completion fan-in singular without orchestration", () => {
    const view = project([
      "event ExportTransactionsProcessEndedEvent", "event ExportConsumptionsProcessEndedEvent", "event ExportCorporateBalanceProcessEndedEvent", "event WebhookExportCompleted",
      "handler TransactionsCompletionHandler", "handler ConsumptionsCompletionHandler", "handler CorporateBalanceCompletionHandler",
      "ExportTransactionsProcessEndedEvent handled by TransactionsCompletionHandler", "TransactionsCompletionHandler causes WebhookExportCompleted",
      "ExportConsumptionsProcessEndedEvent handled by ConsumptionsCompletionHandler", "ConsumptionsCompletionHandler causes WebhookExportCompleted",
      "ExportCorporateBalanceProcessEndedEvent handled by CorporateBalanceCompletionHandler", "CorporateBalanceCompletionHandler causes WebhookExportCompleted",
    ].join("\n"));
    expect(view.messages.filter((item) => item.name === "WebhookExportCompleted")).toHaveLength(1);
    expect(upstreamCausalNeighbors(view, messageId("WebhookExportCompleted"))).toHaveLength(3);
  });

  it("represents cycles, disconnected nodes, roots, and unknown provenance finitely", () => {
    const view = project([
      "event EventA", "event EventB", "event Isolated", "handler HandlerA", "handler HandlerB",
      "EventA handled by HandlerA", "HandlerA causes EventB",
      "EventB handled by HandlerB", "HandlerB causes EventA",
    ].join("\n"));

    expect(view.messages.find((item) => item.name === "EventA")?.causalRoot).toBe(false);
    expect(view.messages.find((item) => item.name === "Isolated")?.causalRoot).toBe(true);
    expect(view.components).toHaveLength(2);
    expect(view.components[0].rootNodeIds).toEqual([]);
    expect(view.components[1].nodeIds).toEqual(["message:Isolated"]);
    expect(view.messages.find((item) => item.name === "EventA")?.provenance).toBe("unknown");
  });

  it("keeps scheduled initiation separate from provenance", () => {
    const view = project([
      "event ResendNonReceivedWebhookEventsCommand {",
      "  kind: command",
      "  provenance: internal",
      "}",
      "event WebhookDeliveryRetried",
      "handler WebhookRetryHandler",
      "scheduled initiates ResendNonReceivedWebhookEventsCommand",
      "ResendNonReceivedWebhookEventsCommand handled by WebhookRetryHandler",
      "WebhookRetryHandler causes WebhookDeliveryRetried",
    ].join("\n"));
    expect(view.messages.find((item) => item.name === "ResendNonReceivedWebhookEventsCommand")).toMatchObject({
      kind: "command", provenance: "internal", initiation: "scheduled", causalRoot: true,
    });
  });

  it("keeps failure and retry edges distinct from ordinary causality", () => {
    const view = project([
      "event RetryCommand",
      "handler H",
      "failure processing-failed on handler H {",
      "  classification: processing",
      "}",
      "retry same-work for processing-failed {",
      "  mechanism: handler",
      "  target: same-execution",
      "}",
    ].join("\n"));
    expect(view.failures?.map((item) => item.failureId)).toEqual(["processing-failed"]);
    expect(view.retries?.[0].target).toBe("same-execution");
    expect(view.edges.map((edge) => edge.type)).toEqual(["ENTITY_FAILED", "FAILURE_RETRIED", "RETRY_TARGETS_HANDLER"]);
  });

  it("preserves deterministic ordering and legacy empty behavior", () => {
    const source = "event B\nevent A\nhandler H\nA handled by H\nH causes B";
    expect(project(source)).toEqual(project(source));
    expect(project("event A\nservice S\nS consumes A")).toEqual({
      messages: [], handlers: [], effects: [], edges: [], components: [],
    });
  });
});
