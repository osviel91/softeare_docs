/** Queries and invariants for explicit Event -> Handler -> Output causality. */
import {
  eventsOf,
  type EventFlow,
  type EventFlowHandler,
  type EventProvenance,
  type HandlerEffect,
  type HandlerInput,
  type HandlerOutput,
} from "./ast";

export function handlersFor(flow: EventFlow, event: string): EventFlowHandler[] {
  const causal = flow.causal;
  if (!causal) return [];
  const ids = new Set(
    causal.inputs
      .filter((input) => input.event === event)
      .map((input) => input.handlerId),
  );
  return causal.handlers.filter((handler) => ids.has(handler.id));
}

export function inputEventsFor(flow: EventFlow, handlerId: string): string[] {
  return unique(
    (flow.causal?.inputs ?? [])
      .filter((input) => input.handlerId === handlerId)
      .map((input) => input.event),
  );
}

export function effectsFor(flow: EventFlow, handlerId: string): HandlerEffect[] {
  return (flow.causal?.effects ?? []).filter(
    (effect) => effect.handlerId === handlerId,
  );
}

export function resultingEventsFor(flow: EventFlow, handlerId: string): string[] {
  return unique(
    (flow.causal?.outputs ?? [])
      .filter((output) => output.handlerId === handlerId)
      .map((output) => output.event),
  );
}

/** Omitted or invalid input is normalized without inferring from event names. */
export function normalizeEventProvenance(
  provenance: EventProvenance | string | undefined,
): EventProvenance {
  return provenance === "external" ||
    provenance === "internal" ||
    provenance === "unknown"
    ? provenance
    : "unknown";
}

export type CausalInvariantCode =
  | "duplicate-handler"
  | "duplicate-input"
  | "duplicate-output"
  | "duplicate-effect"
  | "unknown-handler"
  | "unknown-event"
  | "effect-without-handler";

export interface CausalInvariantViolation {
  code: CausalInvariantCode;
  message: string;
  reference: HandlerInput | HandlerOutput | HandlerEffect | EventFlowHandler;
}

/** Validate causal references without requiring a complete causal graph. */
export function validateEventFlowCausality(
  flow: EventFlow,
): CausalInvariantViolation[] {
  const causal = flow.causal;
  if (!causal) return [];

  const violations: CausalInvariantViolation[] = [];
  const eventNames = new Set(eventsOf(flow).map((event) => event.name));
  const handlers = new Set<string>();
  for (const handler of causal.handlers) {
    if (handlers.has(handler.id)) {
      violations.push({
        code: "duplicate-handler",
        message: `Handler "${handler.id}" is declared more than once`,
        reference: handler,
      });
    }
    handlers.add(handler.id);
  }

  const inputs = new Set<string>();
  for (const input of causal.inputs) {
    if (!handlers.has(input.handlerId)) violations.push(unknownHandler(input));
    if (!eventNames.has(input.event)) violations.push(unknownEvent(input));
    if (!addKey(inputs, `${input.handlerId}\u0000${input.event}`)) {
      violations.push({
        code: "duplicate-input",
        message: `Handler "${input.handlerId}" handles "${input.event}" more than once`,
        reference: input,
      });
    }
  }

  const outputs = new Set<string>();
  for (const output of causal.outputs) {
    if (!handlers.has(output.handlerId))
      violations.push(unknownHandler(output));
    if (!eventNames.has(output.event)) violations.push(unknownEvent(output));
    if (!addKey(outputs, `${output.handlerId}\u0000${output.event}`)) {
      violations.push({
        code: "duplicate-output",
        message: `Handler "${output.handlerId}" causes "${output.event}" more than once`,
        reference: output,
      });
    }
  }

  const effectIds = new Set<string>();
  for (const effect of causal.effects) {
    if (!handlers.has(effect.handlerId)) {
      violations.push({
        code: "effect-without-handler",
        message: `Effect "${effect.id}" belongs to unknown handler "${effect.handlerId}"`,
        reference: effect,
      });
    }
    if (!addKey(effectIds, effect.id)) {
      violations.push({
        code: "duplicate-effect",
        message: `Effect "${effect.id}" is declared more than once`,
        reference: effect,
      });
    }
  }
  return violations;
}

function unknownHandler(
  reference: HandlerInput | HandlerOutput,
): CausalInvariantViolation {
  return {
    code: "unknown-handler",
    message: `Causal relationship names unknown handler "${reference.handlerId}"`,
    reference,
  };
}

function unknownEvent(
  reference: HandlerInput | HandlerOutput,
): CausalInvariantViolation {
  return {
    code: "unknown-event",
    message: `Causal relationship names unknown event "${reference.event}"`,
    reference,
  };
}

function addKey(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false;
  keys.add(key);
  return true;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
