import { describe, expect, it } from "vitest";
import {
  effectsFor,
  handlersFor,
  inputEventsFor,
  normalizeEventProvenance,
  resultingEventsFor,
  validateEventFlowCausality,
} from "../../../src/domain/eventflow/causality";
import type { EventFlow } from "../../../src/domain/eventflow/ast";

const flow: EventFlow = {
  statements: [
    event("UpOneTransactionRaisedEvent", 0),
    event("SaveUpOneTransactionCommand", 1),
    event("AddAccountCommand", 2),
    event("AddCorporateAccountCommand", 3),
  ],
  causal: {
    handlers: [
      { type: "handler", id: "TransactionsHandler", metadata: [] },
      { type: "handler", id: "AccountsHandler", metadata: [] },
    ],
    inputs: [
      input("TransactionsHandler", "UpOneTransactionRaisedEvent"),
      input("AccountsHandler", "UpOneTransactionRaisedEvent"),
    ],
    outputs: [
      output("TransactionsHandler", "SaveUpOneTransactionCommand"),
      output("AccountsHandler", "AddAccountCommand"),
      output("AccountsHandler", "AddCorporateAccountCommand"),
    ],
    effects: [],
  },
};

describe("event-flow causality", () => {
  it("keeps fan-out branches independent", () => {
    expect(handlersFor(flow, "UpOneTransactionRaisedEvent").map((h) => h.id)).toEqual([
      "TransactionsHandler",
      "AccountsHandler",
    ]);
    expect(resultingEventsFor(flow, "TransactionsHandler")).toEqual([
      "SaveUpOneTransactionCommand",
    ]);
    expect(resultingEventsFor(flow, "AccountsHandler")).toEqual([
      "AddAccountCommand",
      "AddCorporateAccountCommand",
    ]);
  });

  it("queries effects and inputs without service inference", () => {
    const withEffect: EventFlow = {
      ...flow,
      causal: {
        ...flow.causal!,
        effects: [{
          type: "effect",
          id: "persist-transaction",
          handlerId: "TransactionsHandler",
          kind: "state-update",
          description: "Persist transaction",
          metadata: [],
        }],
      },
    };
    expect(inputEventsFor(withEffect, "TransactionsHandler")).toEqual([
      "UpOneTransactionRaisedEvent",
    ]);
    expect(effectsFor(withEffect, "TransactionsHandler")[0].description).toBe(
      "Persist transaction",
    );
    expect(resultingEventsFor(withEffect, "TransactionsHandler")).toEqual([
      "SaveUpOneTransactionCommand",
    ]);
  });

  it("represents a causal chain without sharing outputs between handlers", () => {
    const chain: EventFlow = {
      statements: [
        event("MslTransactionCreatedEvent", 10),
        event("ThresholdExceededEvent", 11),
        event("SendEmailCommand", 12),
      ],
      causal: {
        handlers: [
          { type: "handler", id: "CriteriaHandler", metadata: [] },
          { type: "handler", id: "NotificationHandler", metadata: [] },
        ],
        inputs: [
          input("CriteriaHandler", "MslTransactionCreatedEvent"),
          input("NotificationHandler", "ThresholdExceededEvent"),
        ],
        outputs: [
          output("CriteriaHandler", "ThresholdExceededEvent"),
          output("NotificationHandler", "SendEmailCommand"),
        ],
        effects: [],
      },
    };
    expect(resultingEventsFor(chain, "CriteriaHandler")).toEqual([
      "ThresholdExceededEvent",
    ]);
    expect(resultingEventsFor(chain, "NotificationHandler")).toEqual([
      "SendEmailCommand",
    ]);
  });

  it("allows incomplete knowledge and validates only broken references", () => {
    expect(validateEventFlowCausality({ statements: [] })).toEqual([]);
    expect(normalizeEventProvenance(undefined)).toBe("unknown");
    expect(normalizeEventProvenance("external")).toBe("external");
    expect(validateEventFlowCausality({
      statements: [],
      causal: {
        handlers: [],
        inputs: [],
        outputs: [],
        effects: [{
          type: "effect",
          id: "e",
          handlerId: "missing",
          description: "x",
          metadata: [],
        }],
      },
    })[0].code).toBe("effect-without-handler");
  });
});

function event(name: string, line: number) {
  return { type: "event" as const, name, metadata: [], range: range(line) };
}

function input(handlerId: string, event: string) {
  return { type: "handler-input" as const, handlerId, event };
}

function output(handlerId: string, event: string) {
  return { type: "handler-output" as const, handlerId, event };
}

function range(line: number) {
  return { start: { line, column: 0 }, end: { line, column: 1 } };
}
