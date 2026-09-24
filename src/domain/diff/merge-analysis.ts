import { analyze } from "../../language/analyze";
import { analyzeEventFlow } from "../../language/eventflow/parser";
import { eventsOf, type EventFlow } from "../eventflow/ast";
import { resourceRepresentationOfType } from "../workspace/resource-id";
import {
  normalizeResourceMetadata,
  type ResourceMetadata,
} from "../workspace/resource-metadata";
import type { ResourceState } from "./resource-state";
import {
  diffResources,
  eventFlowDiff,
  type SemanticChange,
} from "./resource-diff";

export type MergeAnalysisStatus =
  "ok" | "invalid-base" | "invalid-current" | "invalid-proposed";

export type MergeConflictKind =
  | "concurrent-modification"
  | "concurrent-add"
  | "delete-vs-modify"
  | "overlapping-source-change"
  | "ambiguous-sequence-change";

export interface MergeConflict {
  entity: string;
  identity: string;
  field?: string;
  kind: MergeConflictKind;
  base?: unknown;
  current?: unknown;
  proposed?: unknown;
}

export interface CompatibleChange {
  entity: string;
  identity: string;
  field?: string;
  current?: unknown;
  proposed?: unknown;
}

export interface MergeAnalysis {
  baseRevision: number;
  currentRevision: number;
  proposalVersion: number;
  stale: boolean;
  conflicted: boolean;
  status: MergeAnalysisStatus;
  autoMergeable: boolean;
  compatibleChanges: CompatibleChange[];
  conflicts: MergeConflict[];
  diagnostics: unknown[];
  summary: string;
  candidateState?: ResourceState;
}

interface Edit {
  start: number;
  end: number;
  lines: string[];
}

function linesOf(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split("\n");
}

function editsOf(base: string, side: string): Edit[] {
  const oldLines = linesOf(base);
  const newLines = linesOf(side);
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    Array(newLines.length + 1).fill(0),
  );
  for (let i = oldLines.length - 1; i >= 0; i -= 1)
    for (let j = newLines.length - 1; j >= 0; j -= 1)
      table[i][j] =
        oldLines[i] === newLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const edit: Edit = { start: i, end: i, lines: [] };
    while (i < oldLines.length || j < newLines.length) {
      if (oldLines[i] === newLines[j]) break;
      if (
        j >= newLines.length ||
        (i < oldLines.length && table[i + 1][j] >= table[i][j + 1])
      ) {
        edit.end = ++i;
      } else {
        edit.lines.push(newLines[j++]);
      }
    }
    edits.push(edit);
  }
  return edits;
}

function mergeText(
  base: string,
  current: string,
  proposed: string,
): { content?: string; conflict?: MergeConflict } {
  if (current === base) return { content: proposed };
  if (proposed === base || current === proposed) return { content: current };
  const currentEdits = editsOf(base, current);
  const proposedEdits = editsOf(base, proposed);
  for (const left of currentEdits) {
    for (const right of proposedEdits) {
      const overlap = left.start < right.end && right.start < left.end;
      if (
        overlap &&
        JSON.stringify(left.lines) !== JSON.stringify(right.lines)
      ) {
        return {
          conflict: {
            entity: "source",
            identity: `lines:${Math.min(left.start, right.start) + 1}`,
            kind: "overlapping-source-change",
            base: linesOf(base).slice(
              Math.min(left.start, right.start),
              Math.max(left.end, right.end),
            ),
            current: left.lines,
            proposed: right.lines,
          },
        };
      }
    }
  }
  const edits = [...currentEdits, ...proposedEdits].sort(
    (a, b) => b.start - a.start || b.end - a.end,
  );
  const result = linesOf(base);
  for (const edit of edits)
    result.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return { content: result.join("\n") };
}

function mergeMetadata(
  base: ResourceMetadata | undefined,
  current: ResourceMetadata | undefined,
  proposed: ResourceMetadata | undefined,
): {
  metadata?: ResourceMetadata;
  compatible: CompatibleChange[];
  conflicts: MergeConflict[];
} {
  const b = normalizeResourceMetadata(base);
  const c = normalizeResourceMetadata(current);
  const p = normalizeResourceMetadata(proposed);
  const conflicts: MergeConflict[] = [];
  const compatible: CompatibleChange[] = [];
  const description = mergeField(
    "metadata",
    "description",
    b.description,
    c.description,
    p.description,
    conflicts,
    compatible,
  );
  const tags = new Map<string, string>();
  const allTags = new Set([
    ...(b.tags ?? []).map((tag) => tag.toLowerCase()),
    ...(c.tags ?? []).map((tag) => tag.toLowerCase()),
    ...(p.tags ?? []).map((tag) => tag.toLowerCase()),
  ]);
  for (const key of [...allTags].sort()) {
    const bv = (b.tags ?? []).find((tag) => tag.toLowerCase() === key);
    const cv = (c.tags ?? []).find((tag) => tag.toLowerCase() === key);
    const pv = (p.tags ?? []).find((tag) => tag.toLowerCase() === key);
    const value = mergeField(
      "metadata",
      `tag:${key}`,
      bv,
      cv,
      pv,
      conflicts,
      compatible,
    );
    if (value !== undefined) tags.set(key, String(value));
  }
  const metadata = normalizeResourceMetadata({
    ...(description === undefined ? {} : { description: String(description) }),
    ...(tags.size === 0 ? {} : { tags: [...tags.values()] }),
  });
  return {
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    compatible,
    conflicts,
  };
}

function mergeField(
  entity: string,
  identity: string,
  base: unknown,
  current: unknown,
  proposed: unknown,
  conflicts: MergeConflict[],
  compatible: CompatibleChange[],
): unknown {
  if (
    identity.startsWith("tag:") &&
    typeof current === "string" &&
    typeof proposed === "string" &&
    current.toLowerCase() === proposed.toLowerCase()
  ) {
    compatible.push({ entity, identity, current, proposed });
    return current;
  }
  if (Object.is(current, base)) {
    if (!Object.is(proposed, base))
      compatible.push({ entity, identity, proposed });
    return proposed;
  }
  if (Object.is(proposed, base) || Object.is(current, proposed)) {
    if (!Object.is(current, base))
      compatible.push({ entity, identity, current });
    return current;
  }
  conflicts.push({
    entity,
    identity,
    field: identity,
    kind: "concurrent-modification",
    base,
    current,
    proposed,
  });
  return current;
}

function semanticKey(change: SemanticChange): string {
  return `${change.entity}:${change.identity}`;
}

function semanticValue(change: SemanticChange): unknown {
  return change.details ?? change.kind;
}

function eventFlowConflicts(
  base: EventFlow,
  current: EventFlow,
  proposed: EventFlow,
): { compatible: CompatibleChange[]; conflicts: MergeConflict[] } {
  const left = eventFlowDiff(base, current);
  const right = eventFlowDiff(base, proposed);
  const leftMap = new Map(left.map((change) => [semanticKey(change), change]));
  const rightMap = new Map(
    right.map((change) => [semanticKey(change), change]),
  );
  const compatible: CompatibleChange[] = [];
  const conflicts: MergeConflict[] = [];
  for (const eventName of [
    ...new Set(eventsOf(base).map((event) => event.name)),
  ].sort()) {
    const removedLeft = leftMap.get(`event:${eventName}`)?.kind === "removed";
    const removedRight = rightMap.get(`event:${eventName}`)?.kind === "removed";
    const leftModified = left.some((change) =>
      change.identity.startsWith(`${eventName}:`),
    );
    const rightModified = right.some((change) =>
      change.identity.startsWith(`${eventName}:`),
    );
    if ((removedLeft && rightModified) || (removedRight && leftModified)) {
      conflicts.push({
        entity: "event",
        identity: eventName,
        kind: "delete-vs-modify",
      });
    }
  }
  for (const key of [
    ...new Set([...leftMap.keys(), ...rightMap.keys()]),
  ].sort()) {
    const a = leftMap.get(key);
    const b = rightMap.get(key);
    if (!a || !b) {
      compatible.push({
        entity: (a ?? b)!.entity,
        identity: (a ?? b)!.identity,
      });
      continue;
    }
    if (
      a.kind === b.kind &&
      JSON.stringify(semanticValue(a)) === JSON.stringify(semanticValue(b))
    ) {
      compatible.push({ entity: a.entity, identity: a.identity });
      continue;
    }
    conflicts.push({
      entity: a.entity,
      identity: a.identity,
      field:
        a.entity === "event-metadata"
          ? String(a.details?.key ?? "metadata")
          : undefined,
      kind:
        a.kind !== b.kind && (a.kind === "removed" || b.kind === "removed")
          ? "delete-vs-modify"
          : a.kind === "added" && b.kind === "added"
            ? "concurrent-add"
            : "concurrent-modification",
      base: a.details,
      current: semanticValue(a),
      proposed: semanticValue(b),
    });
  }
  return { compatible, conflicts };
}

function invalidDiagnostics(
  type: ResourceState["type"],
  content: string,
): unknown[] {
  if (type === "markdown-document") return [];
  const result =
    type === "event-flow" ? analyzeEventFlow(content) : analyze(content);
  return result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
}

export function analyzeResourceMerge(input: {
  base: ResourceState;
  current: ResourceState;
  proposed: ResourceState;
  baseRevision: number;
  currentRevision: number;
  proposalVersion: number;
}): MergeAnalysis {
  const { base, current, proposed } = input;
  const common = {
    baseRevision: input.baseRevision,
    currentRevision: input.currentRevision,
    proposalVersion: input.proposalVersion,
    stale: input.baseRevision !== input.currentRevision,
    conflicted: false,
    summary: "",
  };
  const baseDiagnostics = invalidDiagnostics(base.type, base.content);
  if (baseDiagnostics.length > 0)
    return {
      ...common,
      status: "invalid-base",
      autoMergeable: false,
      compatibleChanges: [],
      conflicts: [],
      diagnostics: baseDiagnostics,
      summary: "Base resource is invalid.",
    };
  const currentDiagnostics = invalidDiagnostics(current.type, current.content);
  if (currentDiagnostics.length > 0)
    return {
      ...common,
      status: "invalid-current",
      autoMergeable: false,
      compatibleChanges: [],
      conflicts: [],
      diagnostics: currentDiagnostics,
      summary: "Current resource is invalid.",
    };
  const proposedDiagnostics = invalidDiagnostics(
    proposed.type,
    proposed.content,
  );
  if (proposedDiagnostics.length > 0)
    return {
      ...common,
      status: "invalid-proposed",
      autoMergeable: false,
      compatibleChanges: [],
      conflicts: [],
      diagnostics: proposedDiagnostics,
      summary: "Proposed resource is invalid.",
    };
  if (base.type !== current.type || base.type !== proposed.type) {
    return {
      ...common,
      status: "ok",
      autoMergeable: false,
      conflicted: true,
      compatibleChanges: [],
      conflicts: [
        {
          entity: "representation",
          identity: "type",
          kind: "concurrent-modification",
          base: base.type,
          current: current.type,
          proposed: proposed.type,
        },
      ],
      diagnostics: [],
      summary: "Resource representations differ.",
    };
  }
  const metadata = mergeMetadata(
    base.metadata,
    current.metadata,
    proposed.metadata,
  );
  let compatible = metadata.compatible;
  let conflicts = metadata.conflicts;
  if (base.content !== current.content || base.content !== proposed.content) {
    const representation = resourceRepresentationOfType(base.type);
    if (representation === "event-flow") {
      const b = analyzeEventFlow(base.content).flow;
      const c = analyzeEventFlow(current.content).flow;
      const p = analyzeEventFlow(proposed.content).flow;
      const semantic = eventFlowConflicts(b, c, p);
      compatible = [...compatible, ...semantic.compatible];
      conflicts = [...conflicts, ...semantic.conflicts];
    } else if (representation === "sequence") {
      const left = diffResources(base, current).content.changes;
      const right = diffResources(base, proposed).content.changes;
      if (
        left.some((change) => change.entity === "interaction") &&
        right.some((change) => change.entity === "interaction")
      ) {
        conflicts.push({
          entity: "interaction",
          identity: "ambiguous",
          kind: "ambiguous-sequence-change",
        });
      }
      compatible = [
        ...compatible,
        ...left
          .filter(
            (change) =>
              !right.some(
                (other) => semanticKey(other) === semanticKey(change),
              ),
          )
          .map((change) => ({
            entity: change.entity,
            identity: change.identity,
          })),
      ];
    }
  }
  const text = mergeText(base.content, current.content, proposed.content);
  if (text.conflict && conflicts.length === 0) conflicts.push(text.conflict);
  const autoMergeable = conflicts.length === 0 && text.content !== undefined;
  return {
    ...common,
    status: "ok",
    autoMergeable,
    conflicted: conflicts.length > 0,
    compatibleChanges: compatible.sort((a, b) =>
      `${a.entity}:${a.identity}`.localeCompare(`${b.entity}:${b.identity}`),
    ),
    conflicts: conflicts.sort((a, b) =>
      `${a.entity}:${a.identity}:${a.kind}`.localeCompare(
        `${b.entity}:${b.identity}:${b.kind}`,
      ),
    ),
    diagnostics: [],
    summary:
      conflicts.length > 0
        ? `${conflicts.length} conflict(s) require resolution.`
        : "No semantic conflicts detected.",
    ...(autoMergeable
      ? {
          candidateState: {
            content: text.content!,
            type: current.type,
            ...(metadata.metadata === undefined
              ? {}
              : { metadata: metadata.metadata }),
          },
        }
      : {}),
  };
}
