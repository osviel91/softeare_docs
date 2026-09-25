/**
 * Abstract Syntax Tree for the event-flow DSL (`*.eventseq`).
 *
 * Event-driven documentation has a different shape from a sequence diagram: it
 * is about *who produces what, onto which channel, and who reacts*. Modelling
 * that as differently-styled arrows in the sequence DSL would lose exactly the
 * concepts the documentation is about, so it gets its own language and its own
 * model — while sharing the concepts that are genuinely common (services,
 * channels, source positions) and feeding the same project index.
 *
 * Every node is source-annotated, like the sequence AST, so diagnostics,
 * outline rows, hover and rename can point at the exact statement. The model is
 * deliberately *flat*: publications and subscriptions are edges, and the
 * fan-out and causal chains a reader sees are derived from them at layout time
 * rather than being encoded in the syntax. That is what lets one model support
 * several visualisations later (a sequence view, a dependency graph, a
 * producer/consumer matrix) without a second source language.
 *
 * Source positions are the same shape the sequence AST uses — a shared concept,
 * not a shared implementation — so the two languages agree about what a range
 * means without either owning the other.
 */
import type { SourceRange } from "../diagram/ast";

/** Re-exported so event-flow consumers do not have to reach into the sequence AST. */
export type { SourcePosition, SourceRange } from "../diagram/ast";

/** One `key: value` line inside an event's metadata block. */
export interface EventMetadataEntry {
  /** The key as written; compared case-insensitively. */
  key: string;
  /** Everything after the colon, trimmed. */
  value: string;
  range: SourceRange;
}

/** Conventional keys get prominent Catalog treatment; all other keys remain valid. */
export const CONVENTIONAL_EVENT_METADATA_KEYS = [
  "domain",
  "version",
  "schema",
] as const;

/**
 * An `event <Name>` declaration.
 *
 * Metadata is an open list rather than a fixed set of fields: version, domain,
 * schema, correlation key and whatever an organisation needs next are all just
 * entries. Well-known keys are interpreted by the index; unknown ones are kept
 * and shown, never rejected.
 */
export interface EventDeclaration {
  type: "event";
  name: string;
  /** The message kind; omitted declarations remain event-compatible. */
  kind?: MessageKind;
  /** The first `description` metadata value, normalized for consumers. */
  description?: string;
  /** Optional evidence-based boundary provenance; omitted means undocumented. */
  provenance?: EventProvenance;
  metadata: EventMetadataEntry[];
  range: SourceRange;
}

/** Normalized provenance for an event at the documented system boundary. */
export type EventProvenance = "external" | "internal" | "unknown";

/** Message-level distinction retained by causal projections. */
export type MessageKind = "event" | "command";

/** A known mechanism that initiated a causal root message. */
export type CausalInitiationKind =
  | "scheduled"
  | "external"
  | "manual"
  | "startup"
  | "unknown";

/** A `broker <Name>` declaration: the infrastructure events travel through. */
export interface BrokerDeclaration {
  type: "broker";
  name: string;
  range: SourceRange;
}

/** The logical channel kinds the language distinguishes. */
export type ChannelKind = "topic" | "queue" | "stream";

/**
 * A `topic` / `queue` / `stream` declaration.
 *
 * The kind is a documentation fact — a topic fans out to every subscriber, a
 * queue delivers to one — and `broker` optionally names the infrastructure that
 * hosts it.
 */
export interface ChannelDeclaration {
  type: "channel";
  name: string;
  channelKind: ChannelKind;
  broker?: string;
  range: SourceRange;
}

/** The role a service was declared with; a hint, not a constraint. */
export type ServiceRole = "producer" | "consumer" | "service";

/** A `producer` / `consumer` / `service` declaration. */
export interface ServiceDeclaration {
  type: "service";
  name: string;
  role: ServiceRole;
  range: SourceRange;
}

/**
 * `<Service> publishes <Event> [to <Channel>]`.
 *
 * This is the mission's `EventPublication { producer, event, channel }`, with
 * the channel optional because a document may not care which channel carries it.
 */
export interface EventPublication {
  type: "publication";
  producer: string;
  event: string;
  channel?: string;
  range: SourceRange;
}

/**
 * `<Service> consumes <Event> [from <Channel>]`.
 *
 * The mission's `EventSubscription { consumer, event, channel }`. Several
 * subscriptions for one event *are* the fan-out: the diagram draws one edge per
 * consumer rather than a single edge with a count.
 */
export interface EventSubscription {
  type: "subscription";
  consumer: string;
  event: string;
  channel?: string;
  range: SourceRange;
}

/** A named application responsibility, distinct from the service that hosts it. */
export interface EventFlowHandler {
  type: "handler";
  id: string;
  service?: string;
  description?: string;
  metadata: EventMetadataEntry[];
  /** Optional until a future source syntax can provide a source span. */
  range?: SourceRange;
}

/** Explicit causal input: this handler handles this event/message. */
export interface HandlerInput {
  type: "handler-input";
  handlerId: string;
  event: string;
  range?: SourceRange;
}

/** Explicit causal output: this handler causes this event/message. */
export interface HandlerOutput {
  type: "handler-output";
  handlerId: string;
  event: string;
  range?: SourceRange;
}

/** A meaningful non-event consequence owned by one handler. */
export interface HandlerEffect {
  type: "effect";
  id: string;
  handlerId: string;
  kind?: string;
  description: string;
  metadata: EventMetadataEntry[];
  range?: SourceRange;
}

/** Explicit root initiation, independent from message provenance. */
export interface CausalInitiation {
  type: "initiation";
  message: string;
  kind: CausalInitiationKind;
  range?: SourceRange;
}

/** Optional causal facts kept separate from publication/subscription topology. */
export interface EventFlowCausality {
  handlers: EventFlowHandler[];
  inputs: HandlerInput[];
  outputs: HandlerOutput[];
  effects: HandlerEffect[];
  initiations?: CausalInitiation[];
}

/** A title, e.g. `title Order Processing`. */
export interface EventFlowTitle {
  value: string;
  range: SourceRange;
}

/** Any statement an event-flow document can contain. */
export type EventFlowStatement =
  | EventDeclaration
  | BrokerDeclaration
  | ChannelDeclaration
  | ServiceDeclaration
  | EventPublication
  | EventSubscription;

/** The root document: an optional title followed by statements in source order. */
export interface EventFlow {
  title?: EventFlowTitle;
  /** Statements in source order, which is the order undeclared things appear in. */
  statements: EventFlowStatement[];
  /** Explicit causal facts; legacy flows omit this without changing meaning. */
  causal?: EventFlowCausality;
}

/** Every event declaration in a document, in source order. */
export function eventsOf(flow: EventFlow): EventDeclaration[] {
  return flow.statements.filter(
    (statement): statement is EventDeclaration => statement.type === "event",
  );
}

/** Every channel declaration in a document, in source order. */
export function channelsOf(flow: EventFlow): ChannelDeclaration[] {
  return flow.statements.filter(
    (statement): statement is ChannelDeclaration =>
      statement.type === "channel",
  );
}

/** Every broker declaration in a document, in source order. */
export function brokersOf(flow: EventFlow): BrokerDeclaration[] {
  return flow.statements.filter(
    (statement): statement is BrokerDeclaration => statement.type === "broker",
  );
}

/**
 * Every service a document mentions, declared or not, de-duplicated by name and
 * in first-appearance order.
 *
 * A service that only appears in a `publishes` line is still part of the
 * architecture — the validator reports that it was never declared, and the
 * layout still draws it, so a half-written document remains useful.
 */
export function servicesOf(flow: EventFlow): ServiceDeclaration[] {
  const seen = new Map<string, ServiceDeclaration>();
  const consider = (
    name: string,
    role: ServiceRole,
    range: SourceRange,
  ): void => {
    const existing = seen.get(name);
    // A declaration wins over an inferred mention; otherwise first mention wins.
    if (existing && existing.role !== "service") return;
    if (!existing || role !== "service")
      seen.set(name, { type: "service", name, role, range });
  };

  for (const statement of flow.statements) {
    switch (statement.type) {
      case "service":
        consider(statement.name, statement.role, statement.range);
        break;
      case "publication":
        consider(statement.producer, "producer", statement.range);
        break;
      case "subscription":
        consider(statement.consumer, "consumer", statement.range);
        break;
      default:
        break;
    }
  }
  return [...seen.values()];
}

/** Every publication in a document, in source order. */
export function publicationsOf(flow: EventFlow): EventPublication[] {
  return flow.statements.filter(
    (statement): statement is EventPublication =>
      statement.type === "publication",
  );
}

/** Every subscription in a document, in source order. */
export function subscriptionsOf(flow: EventFlow): EventSubscription[] {
  return flow.statements.filter(
    (statement): statement is EventSubscription =>
      statement.type === "subscription",
  );
}
