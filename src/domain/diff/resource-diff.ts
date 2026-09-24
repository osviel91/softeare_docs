import type { ResourceRepresentation } from "../workspace/resource-id";
import { resourceRepresentationOfType } from "../workspace/resource-id";
import {
  normalizeResourceMetadata,
  type ResourceMetadata,
} from "../workspace/resource-metadata";
import type { ResourceState } from "./resource-state";
import { analyze } from "../../language/analyze";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import {
  channelsOf,
  eventsOf,
  publicationsOf,
  subscriptionsOf,
  type EventFlow,
} from "../eventflow/ast";
import {
  walkStatements,
  type MessageNode,
  type SequenceDiagram,
} from "../diagram/ast";

export type ChangeKind = "added" | "removed" | "modified";

export interface SemanticChange {
  kind: ChangeKind;
  entity: string;
  identity: string;
  details?: Record<string, unknown>;
}

export interface MetadataChange {
  kind: ChangeKind;
  field: "description" | "tag";
  identity: string;
  oldValue?: string;
  newValue?: string;
}

export interface MetadataDiff {
  changed: boolean;
  changes: MetadataChange[];
}

export interface SourceDiffHunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export interface SourceDiff {
  changed: boolean;
  hunks: SourceDiffHunk[];
  truncated: boolean;
  totalHunks: number;
  returnedHunks: number;
}

export interface RepresentationDiff {
  representation: ResourceRepresentation;
  available: boolean;
  changes: SemanticChange[];
  diagnostics: unknown[];
  truncated: boolean;
  totalChanges: number;
  returnedChanges: number;
}

export interface ResourceDiffSummary {
  semanticChanges: number;
  sourceHunks: number;
  byKind: Record<ChangeKind, number>;
  byEntity: Record<string, number>;
}

export interface ResourceDiff {
  changed: boolean;
  metadata: MetadataDiff;
  content: RepresentationDiff;
  source: SourceDiff;
  summary: ResourceDiffSummary;
}

const MAX_CHANGES = 2_000;
const MAX_HUNKS = 200;
const MAX_LINES_PER_HUNK = 200;
const MAX_LCS_CELLS = 4_000_000;

function metadataDiff(
  base?: ResourceMetadata,
  proposed?: ResourceMetadata,
): MetadataDiff {
  const before = normalizeResourceMetadata(base);
  const after = normalizeResourceMetadata(proposed);
  const changes: MetadataChange[] = [];
  if (before.description !== after.description) {
    changes.push({
      kind:
        before.description === undefined
          ? "added"
          : after.description === undefined
            ? "removed"
            : "modified",
      field: "description",
      identity: "description",
      ...(before.description === undefined
        ? {}
        : { oldValue: before.description }),
      ...(after.description === undefined
        ? {}
        : { newValue: after.description }),
    });
  }
  const oldTags = new Map(
    before.tags?.map((tag) => [tag.toLowerCase(), tag]) ?? [],
  );
  const newTags = new Map(
    after.tags?.map((tag) => [tag.toLowerCase(), tag]) ?? [],
  );
  for (const [key, tag] of oldTags) {
    if (!newTags.has(key))
      changes.push({
        kind: "removed",
        field: "tag",
        identity: key,
        oldValue: tag,
      });
  }
  for (const [key, tag] of newTags) {
    if (!oldTags.has(key))
      changes.push({
        kind: "added",
        field: "tag",
        identity: key,
        newValue: tag,
      });
  }
  return { changed: changes.length > 0, changes };
}

function sourceDiff(before: string, after: string): SourceDiff {
  const oldLines = before.replace(/\r\n?/g, "\n").split("\n");
  const newLines = after.replace(/\r\n?/g, "\n").split("\n");
  if (before === after)
    return {
      changed: false,
      hunks: [],
      truncated: false,
      totalHunks: 0,
      returnedHunks: 0,
    };
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return {
      changed: true,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          oldLines: oldLines.slice(0, MAX_LINES_PER_HUNK),
          newLines: newLines.slice(0, MAX_LINES_PER_HUNK),
        },
      ],
      truncated: true,
      totalHunks: 1,
      returnedHunks: 1,
    };
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table: number[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(0),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(
              table[oldIndex + 1][newIndex],
              table[oldIndex][newIndex + 1],
            );
    }
  }
  const hunks: SourceDiffHunk[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const hunk: SourceDiffHunk = {
      oldStart: oldIndex + 1,
      newStart: newIndex + 1,
      oldLines: [],
      newLines: [],
    };
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      if (oldLines[oldIndex] === newLines[newIndex]) break;
      if (
        newIndex >= newLines.length ||
        (oldIndex < oldLines.length &&
          table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1])
      ) {
        hunk.oldLines.push(oldLines[oldIndex++]);
      } else {
        hunk.newLines.push(newLines[newIndex++]);
      }
    }
    hunks.push(hunk);
  }
  return {
    changed: true,
    hunks: hunks.slice(0, MAX_HUNKS).map((hunk) => ({
      ...hunk,
      oldLines: hunk.oldLines.slice(0, MAX_LINES_PER_HUNK),
      newLines: hunk.newLines.slice(0, MAX_LINES_PER_HUNK),
    })),
    truncated:
      hunks.length > MAX_HUNKS ||
      hunks.some(
        (hunk) =>
          hunk.oldLines.length > MAX_LINES_PER_HUNK ||
          hunk.newLines.length > MAX_LINES_PER_HUNK,
      ),
    totalHunks: hunks.length,
    returnedHunks: Math.min(hunks.length, MAX_HUNKS),
  };
}

function eventMetadata(event: {
  description?: string;
  metadata: { key: string; value: string }[];
}): Map<string, string> {
  const values = new Map<string, string>();
  if (event.description !== undefined)
    values.set("description", event.description);
  for (const entry of event.metadata) {
    if (entry.key.toLowerCase() !== "description")
      values.set(entry.key.toLowerCase(), entry.value);
  }
  return values;
}

export function eventFlowDiff(
  before: EventFlow,
  after: EventFlow,
): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const oldEvents = new Map(
    eventsOf(before).map((event) => [event.name, event]),
  );
  const newEvents = new Map(
    eventsOf(after).map((event) => [event.name, event]),
  );
  for (const name of [...oldEvents.keys()].sort())
    if (!newEvents.has(name))
      changes.push({ kind: "removed", entity: "event", identity: name });
  for (const name of [...newEvents.keys()].sort())
    if (!oldEvents.has(name))
      changes.push({ kind: "added", entity: "event", identity: name });
  for (const name of [...oldEvents.keys()]
    .filter((key) => newEvents.has(key))
    .sort()) {
    const oldMetadata = eventMetadata(oldEvents.get(name)!);
    const newMetadata = eventMetadata(newEvents.get(name)!);
    const keys = [
      ...new Set([...oldMetadata.keys(), ...newMetadata.keys()]),
    ].sort();
    for (const key of keys) {
      if (oldMetadata.get(key) === newMetadata.get(key)) continue;
      changes.push({
        kind: oldMetadata.has(key)
          ? newMetadata.has(key)
            ? "modified"
            : "removed"
          : "added",
        entity: "event-metadata",
        identity: `${name}:${key}`,
        details: {
          event: name,
          key,
          ...(oldMetadata.has(key) ? { oldValue: oldMetadata.get(key) } : {}),
          ...(newMetadata.has(key) ? { newValue: newMetadata.get(key) } : {}),
        },
      });
    }
  }
  const oldChannels = new Map(
    channelsOf(before).map((channel) => [channel.name, channel]),
  );
  const newChannels = new Map(
    channelsOf(after).map((channel) => [channel.name, channel]),
  );
  for (const name of [
    ...new Set([...oldChannels.keys(), ...newChannels.keys()]),
  ].sort()) {
    const oldChannel = oldChannels.get(name);
    const newChannel = newChannels.get(name);
    if (!oldChannel || !newChannel) {
      changes.push({
        kind: oldChannel ? "removed" : "added",
        entity: "channel",
        identity: name,
      });
    } else if (
      oldChannel.channelKind !== newChannel.channelKind ||
      oldChannel.broker !== newChannel.broker
    ) {
      changes.push({
        kind: "modified",
        entity: "channel",
        identity: name,
        details: {
          old: {
            channelKind: oldChannel.channelKind,
            broker: oldChannel.broker,
          },
          new: {
            channelKind: newChannel.channelKind,
            broker: newChannel.broker,
          },
        },
      });
    }
  }
  relationshipChanges(changes, before, after, "publication", "producer");
  relationshipChanges(changes, before, after, "subscription", "consumer");
  return changes;
}

function relationshipChanges(
  changes: SemanticChange[],
  before: EventFlow,
  after: EventFlow,
  type: "publication" | "subscription",
  subject: "producer" | "consumer",
): void {
  const oldEntries =
    type === "publication" ? publicationsOf(before) : subscriptionsOf(before);
  const newEntries =
    type === "publication" ? publicationsOf(after) : subscriptionsOf(after);
  const keyOf = (entry: {
    event: string;
    channel?: string;
    producer?: string;
    consumer?: string;
  }) => `${entry.event}|${entry[subject]}`;
  const oldMap = new Map(oldEntries.map((entry) => [keyOf(entry), entry]));
  const newMap = new Map(newEntries.map((entry) => [keyOf(entry), entry]));
  for (const key of [...oldMap.keys()].sort())
    if (!newMap.has(key))
      changes.push({ kind: "removed", entity: type, identity: key });
  for (const key of [...newMap.keys()].sort())
    if (!oldMap.has(key))
      changes.push({ kind: "added", entity: type, identity: key });
  for (const key of [...oldMap.keys()]
    .filter((value) => newMap.has(value))
    .sort()) {
    const oldEntry = oldMap.get(key)!;
    const newEntry = newMap.get(key)!;
    if (oldEntry.channel !== newEntry.channel)
      changes.push({
        kind: "modified",
        entity: type,
        identity: key,
        details: { oldChannel: oldEntry.channel, newChannel: newEntry.channel },
      });
  }
}

/** The fields that make two interactions semantically comparable. */
interface InteractionShape {
  from: string;
  to: string;
  label: string;
  arrowStyle: string;
  lineStyle: string;
}

function interactionShape(message: MessageNode): InteractionShape {
  return {
    from: message.from,
    to: message.to,
    label: message.label,
    arrowStyle: message.arrowStyle,
    lineStyle: message.lineStyle,
  };
}

function interactionSignature(message: MessageNode): string {
  const shape = interactionShape(message);
  return [
    shape.from,
    shape.to,
    shape.label,
    shape.arrowStyle,
    shape.lineStyle,
  ].join("\u0000");
}

/**
 * Whether an old and a new message could be the same message after an edit.
 *
 * A modification is only claimed when the pair still shares something
 * unmistakable — the same endpoints, the same label, or a swapped direction. A
 * pair with none of those is a coincidental alignment, so it is reported as a
 * removal plus an addition instead of an invented modification.
 */
function plausiblySame(oldMessage: MessageNode, newMessage: MessageNode): boolean {
  const sameEndpoints =
    oldMessage.from === newMessage.from && oldMessage.to === newMessage.to;
  const sameLabel = oldMessage.label === newMessage.label;
  const swapped =
    oldMessage.from === newMessage.to && oldMessage.to === newMessage.from;
  return sameEndpoints || sameLabel || swapped;
}

/**
 * Index pairs of messages that are byte-for-byte unchanged on both sides, found
 * by longest common subsequence over their semantic signatures. Insertions and
 * removals therefore do not shift every later message into a false
 * modification, which positional alignment alone cannot avoid.
 */
function unchangedMessagePairs(
  oldMessages: MessageNode[],
  newMessages: MessageNode[],
): Array<[number, number]> {
  if (oldMessages.length * newMessages.length > MAX_LCS_CELLS) {
    // ponytail: huge diagrams fall back to no anchors, so every message is
    // compared in order; fine at this size, swap in a banded LCS if it matters.
    return [];
  }
  const oldSignatures = oldMessages.map(interactionSignature);
  const newSignatures = newMessages.map(interactionSignature);
  const rows = oldMessages.length + 1;
  const cols = newMessages.length + 1;
  const table: number[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(0),
  );
  for (let oldIndex = oldMessages.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newMessages.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        oldSignatures[oldIndex] === newSignatures[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(
              table[oldIndex + 1][newIndex],
              table[oldIndex][newIndex + 1],
            );
    }
  }
  const pairs: Array<[number, number]> = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldMessages.length && newIndex < newMessages.length) {
    if (oldSignatures[oldIndex] === newSignatures[newIndex]) {
      pairs.push([oldIndex, newIndex]);
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }
  return pairs;
}

function sequenceDiff(
  before: SequenceDiagram,
  after: SequenceDiagram,
): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const oldParticipants = new Map(
    before.participants.map((participant) => [participant.id, participant]),
  );
  const newParticipants = new Map(
    after.participants.map((participant) => [participant.id, participant]),
  );
  for (const id of [...oldParticipants.keys()].sort())
    if (!newParticipants.has(id))
      changes.push({ kind: "removed", entity: "participant", identity: id });
  for (const id of [...newParticipants.keys()].sort())
    if (!oldParticipants.has(id))
      changes.push({ kind: "added", entity: "participant", identity: id });
  for (const id of [...oldParticipants.keys()]
    .filter((key) => newParticipants.has(key))
    .sort()) {
    const oldParticipant = oldParticipants.get(id)!;
    const newParticipant = newParticipants.get(id)!;
    if (
      oldParticipant.label !== newParticipant.label ||
      oldParticipant.participantType !== newParticipant.participantType
    )
      changes.push({
        kind: "modified",
        entity: "participant",
        identity: id,
        details: {
          old: {
            label: oldParticipant.label,
            participantType: oldParticipant.participantType,
          },
          new: {
            label: newParticipant.label,
            participantType: newParticipant.participantType,
          },
        },
      });
  }
  const oldMessages = [...walkStatements(before.statements)].filter(
    (statement): statement is MessageNode => statement.type === "message",
  );
  const newMessages = [...walkStatements(after.statements)].filter(
    (statement): statement is MessageNode => statement.type === "message",
  );
  // A rendered message is identified by its 1-based ordinal on each side, so a
  // change can be resolved back to the exact arrow the renderer drew. Zero means
  // the message does not exist on that side.
  const numberIdentity = (baseNumber: number, proposedNumber: number) =>
    `message:${baseNumber}-${proposedNumber}`;
  const removedInteraction = (message: MessageNode, baseNumber: number) => ({
    kind: "removed" as const,
    entity: "interaction",
    identity: numberIdentity(baseNumber, 0),
    details: {
      baseNumber,
      proposedNumber: 0,
      old: interactionShape(message),
      new: null,
    },
  });
  const addedInteraction = (message: MessageNode, proposedNumber: number) => ({
    kind: "added" as const,
    entity: "interaction",
    identity: numberIdentity(0, proposedNumber),
    details: {
      baseNumber: 0,
      proposedNumber,
      old: null,
      new: interactionShape(message),
    },
  });
  const emitGap = (
    oldStart: number,
    oldEnd: number,
    newStart: number,
    newEnd: number,
  ): void => {
    const oldCount = oldEnd - oldStart;
    const newCount = newEnd - newStart;
    const count = Math.max(oldCount, newCount);
    for (let offset = 0; offset < count; offset += 1) {
      const oldMessage = offset < oldCount ? oldMessages[oldStart + offset] : null;
      const newMessage = offset < newCount ? newMessages[newStart + offset] : null;
      const baseNumber = oldMessage ? oldStart + offset + 1 : 0;
      const proposedNumber = newMessage ? newStart + offset + 1 : 0;
      if (oldMessage && newMessage && plausiblySame(oldMessage, newMessage)) {
        changes.push({
          kind: "modified",
          entity: "interaction",
          identity: numberIdentity(baseNumber, proposedNumber),
          details: {
            baseNumber,
            proposedNumber,
            old: interactionShape(oldMessage),
            new: interactionShape(newMessage),
          },
        });
      } else if (oldMessage && newMessage) {
        // Aligned but not confidently the same message: report both sides.
        changes.push(removedInteraction(oldMessage, baseNumber));
        changes.push(addedInteraction(newMessage, proposedNumber));
      } else if (oldMessage) {
        changes.push(removedInteraction(oldMessage, baseNumber));
      } else if (newMessage) {
        changes.push(addedInteraction(newMessage, proposedNumber));
      }
    }
  };
  let cursorOld = 0;
  let cursorNew = 0;
  for (const [oldIndex, newIndex] of unchangedMessagePairs(
    oldMessages,
    newMessages,
  )) {
    emitGap(cursorOld, oldIndex, cursorNew, newIndex);
    cursorOld = oldIndex + 1;
    cursorNew = newIndex + 1;
  }
  emitGap(cursorOld, oldMessages.length, cursorNew, newMessages.length);
  return changes;
}

type Strategy = (before: string, after: string) => RepresentationDiff;

const strategies: Record<ResourceRepresentation, Strategy> = {
  sequence: (before, after) => {
    const oldResult = analyze(before);
    const newResult = analyze(after);
    const diagnostics = [...oldResult.diagnostics, ...newResult.diagnostics];
    const changes =
      oldResult.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error",
      ) ||
      newResult.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error",
      ) ||
      oldResult.ast === null ||
      newResult.ast === null
        ? []
        : sequenceDiff(oldResult.ast, newResult.ast);
    return representationResult(
      "sequence",
      changes,
      diagnostics,
      oldResult.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error",
      ) ||
        newResult.diagnostics.some(
          (diagnostic) => diagnostic.severity === "error",
        ),
    );
  },
  "event-flow": (before, after) => {
    const oldResult = analyzeEventFlow(before);
    const newResult = analyzeEventFlow(after);
    const diagnostics = [...oldResult.diagnostics, ...newResult.diagnostics];
    const invalid = diagnostics.some(
      (diagnostic) => diagnostic.severity === "error",
    );
    return representationResult(
      "event-flow",
      invalid ? [] : eventFlowDiff(oldResult.flow, newResult.flow),
      diagnostics,
      invalid,
    );
  },
  markdown: (before, after) => {
    const source = sourceDiff(before, after);
    const changes = source.hunks.map((hunk) => ({
      kind: "modified" as const,
      entity: "markdown-block",
      identity: `lines:${hunk.newStart}`,
      details: { oldLines: hunk.oldLines, newLines: hunk.newLines },
    }));
    return representationResult("markdown", changes, [], false);
  },
};

function representationResult(
  representation: ResourceRepresentation,
  changes: SemanticChange[],
  diagnostics: unknown[],
  unavailable: boolean,
): RepresentationDiff {
  return {
    representation,
    available: !unavailable,
    changes: changes.slice(0, MAX_CHANGES),
    diagnostics,
    truncated: changes.length > MAX_CHANGES,
    totalChanges: changes.length,
    returnedChanges: Math.min(changes.length, MAX_CHANGES),
  };
}

export function diffResources(
  base: ResourceState,
  proposed: ResourceState,
): ResourceDiff {
  const metadata = metadataDiff(base.metadata, proposed.metadata);
  const representation = resourceRepresentationOfType(base.type);
  const strategy = strategies[representation];
  const content = strategy(base.content, proposed.content);
  if (base.type !== proposed.type) {
    content.changes = [
      {
        kind: "modified",
        entity: "representation",
        identity: "type",
        details: { old: base.type, new: proposed.type },
      },
      ...content.changes,
    ];
    content.totalChanges += 1;
    content.returnedChanges = Math.min(content.totalChanges, MAX_CHANGES);
  }
  const source = sourceDiff(base.content, proposed.content);
  const byKind: Record<ChangeKind, number> = {
    added: 0,
    removed: 0,
    modified: 0,
  };
  const byEntity: Record<string, number> = {};
  for (const change of content.changes) {
    byKind[change.kind] += 1;
    byEntity[change.entity] = (byEntity[change.entity] ?? 0) + 1;
  }
  for (const change of metadata.changes) byKind[change.kind] += 1;
  return {
    changed:
      metadata.changed ||
      content.changes.length > 0 ||
      source.changed ||
      base.type !== proposed.type,
    metadata,
    content,
    source,
    summary: {
      semanticChanges: metadata.changes.length + content.totalChanges,
      sourceHunks: source.totalHunks,
      byKind,
      byEntity,
    },
  };
}
