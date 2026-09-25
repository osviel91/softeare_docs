/**
 * Addressable-node lookup for event-flow documents.
 *
 * The id format and the `nodeIdOf` function are shared with the sequence
 * language (see `src/domain/diagram/node-id.ts`); what differs is *which* nodes
 * a document has. Keeping the walk here means the two languages share one id
 * vocabulary and one format without either lookup having to know the other's
 * node types.
 *
 * These are what make hover, the outline and click-to-source work on an event
 * flow without any text matching: an id resolves back to the exact statement
 * that produced it.
 */
import type { SourcePosition, SourceRange } from "./ast";
import {
  nodeIdOf,
  parseNodeId,
  type AstNodeId,
  type AstNodeKind,
} from "../diagram/node-id";
import type { EventFlow } from "./ast";

/** One addressable node of an event-flow document. */
export interface EventFlowNode {
  id: AstNodeId;
  kind: AstNodeKind;
  range: SourceRange;
  /** A short human-readable label, for hover and diagnostics. */
  label: string;
}

/**
 * Every addressable node, in source order.
 *
 * Metadata entries are not addressable on their own: they always belong to their
 * event, and a rename or a navigation that landed on a metadata line would have
 * nothing useful to do there.
 */
export function eventFlowNodes(flow: EventFlow): EventFlowNode[] {
  const nodes: EventFlowNode[] = [];
  if (flow.title) {
    nodes.push({
      id: nodeIdOf("title", flow.title.range),
      kind: "title",
      range: flow.title.range,
      label: flow.title.value,
    });
  }
  for (const statement of flow.statements) {
    switch (statement.type) {
      case "event":
        nodes.push({
          id: nodeIdOf("event", statement.range),
          kind: "event",
          range: statement.range,
          label: statement.name,
        });
        break;
      case "broker":
        nodes.push({
          id: nodeIdOf("broker", statement.range),
          kind: "broker",
          range: statement.range,
          label: statement.name,
        });
        break;
      case "channel":
        nodes.push({
          id: nodeIdOf("channel", statement.range),
          kind: "channel",
          range: statement.range,
          label: statement.name,
        });
        break;
      case "service":
        nodes.push({
          id: nodeIdOf("service", statement.range),
          kind: "service",
          range: statement.range,
          label: statement.name,
        });
        break;
      case "publication":
        nodes.push({
          id: nodeIdOf("publication", statement.range),
          kind: "publication",
          range: statement.range,
          label: `${statement.producer} publishes ${statement.event}`,
        });
        break;
      case "subscription":
        nodes.push({
          id: nodeIdOf("subscription", statement.range),
          kind: "subscription",
          range: statement.range,
          label: `${statement.consumer} consumes ${statement.event}`,
        });
        break;
      default:
        break;
    }
  }
  for (const causal of [
    ...(flow.causal?.handlers ?? []).map((entry) => ({
      kind: "handler" as const,
      range: entry.range!,
      label: entry.id,
    })),
    ...(flow.causal?.inputs ?? []).map((entry) => ({
      kind: "handler-input" as const,
      range: entry.range!,
      label: `${entry.event} handled by ${entry.handlerId}`,
    })),
    ...(flow.causal?.outputs ?? []).map((entry) => ({
      kind: "handler-output" as const,
      range: entry.range!,
      label: `${entry.handlerId} causes ${entry.event}`,
    })),
    ...(flow.causal?.effects ?? []).map((entry) => ({
      kind: "effect" as const,
      range: entry.range!,
      label: entry.id,
    })),
  ]) {
    if (!causal.range) continue;
    nodes.push({
      id: nodeIdOf(causal.kind, causal.range),
      kind: causal.kind,
      range: causal.range,
      label: causal.label,
    });
  }
  return nodes;
}

/** The deepest addressable node containing `position`, or `null`. */
export function eventFlowNodeAtPosition(
  flow: EventFlow,
  position: SourcePosition,
): EventFlowNode | null {
  let found: EventFlowNode | null = null;
  for (const node of eventFlowNodes(flow)) {
    const { start, end } = node.range;
    if (position.line < start.line || position.line > end.line) continue;
    if (position.line === start.line && position.column < start.column)
      continue;
    if (position.line === end.line && position.column > end.column) continue;
    found = node;
  }
  return found;
}

/** The node an id names, or `null` when no node in this document has it. */
export function eventFlowNodeById(
  flow: EventFlow,
  id: AstNodeId,
): EventFlowNode | null {
  const parsed = parseNodeId(id);
  if (!parsed) return null;
  return (
    eventFlowNodes(flow).find(
      (node) =>
        node.kind === parsed.kind && node.range.start.line === parsed.line,
    ) ?? null
  );
}
