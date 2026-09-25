/**
 * Semantic hover information.
 *
 * Hovering a rendered element or a word in the source should answer "what is
 * this?" using what the project already knows, not the text under the pointer.
 * The facts come from the parsed AST (what the statement *is*) and from the
 * project index (where else it appears) — which is why this module takes both and
 * reads no files.
 *
 * The shape is deliberately plain rows rather than HTML: the editor renders them,
 * so nothing here can inject markup, and a future MCP tool can return the same
 * structure as JSON.
 */
import type { SequenceDiagram, Statement } from "../diagram/ast";
import { walkStatements } from "../diagram/ast";
import { nodeIdAtOffset, parseNodeId } from "../diagram/node-id";
import type { ProjectIndex } from "./project-index";
import { SYMBOL_KIND_LABELS } from "./project-index";

/** One row of a hover card: a label and its value. */
export interface HoverRow {
  label: string;
  value: string;
}

/** What the editor shows when the pointer rests on something meaningful. */
export interface HoverInfo {
  /** The heading, usually the name of the thing. */
  title: string;
  /** The facts beneath it, in display order. */
  rows: HoverRow[];
}

/** Everything hover needs to answer for one position. */
export interface HoverRequest {
  source: string;
  /** 0-based character offset the pointer or caret is on. */
  offset: number;
  ast: SequenceDiagram | null;
  index: ProjectIndex | null;
  /** The resource the source belongs to, for "declared here" answers. */
  resourceId: string | null;
}

/** How a message's arrow reads in words. */
function messageKind(statement: {
  from: string;
  to: string;
  lineStyle: string;
  arrowStyle: string;
}): string {
  if (statement.from === statement.to) return "self message";
  switch (statement.arrowStyle) {
    case "open":
      return "asynchronous message";
    case "cross":
      return "failed delivery";
    case "bidirectional":
      return "bidirectional call";
    case "none":
      return "one-way message";
    default:
      return statement.lineStyle === "dashed" ? "reply" : "synchronous call";
  }
}

/** The statement a node id names, searching fragments recursively. */
function statementAt(ast: SequenceDiagram, line: number): Statement | null {
  for (const statement of walkStatements(ast.statements)) {
    if (statement.range.start.line !== line) continue;
    return statement;
  }
  return null;
}

/** Where a symbol is declared and how much it is used, from the index. */
function symbolFacts(
  index: ProjectIndex | null,
  name: string,
): { declared?: string; uses: number } {
  if (!index) return { uses: 0 };
  const declaration = index.participants.find(
    (symbol) => symbol.name === name && symbol.sourceRange !== undefined,
  );
  const resource = declaration
    ? index.resources.find((entry) => entry.id === declaration.resourceId)
    : undefined;
  return {
    declared:
      declaration?.sourceRange && resource
        ? `${resource.path}:${declaration.sourceRange.start.line + 1}`
        : undefined,
    uses: index.usages.filter((usage) => usage.name === name).length,
  };
}

/**
 * The hover card for a position, or `null` when there is nothing to say.
 *
 * The position is resolved through the same node-id lookup the source↔visual
 * sync uses, so hovering a word and clicking the rendered element it corresponds
 * to always agree about which node is meant.
 */
export function hoverAt(request: HoverRequest): HoverInfo | null {
  const { source, offset, ast, index, resourceId } = request;
  if (!ast) return null;
  const id = nodeIdAtOffset(source, ast, offset);
  if (!id) return null;
  const parsed = parseNodeId(id);
  if (!parsed) return null;

  const { kind, line } = parsed;

  if (kind === "participant" || kind === "alias") {
    const participant = ast.participants.find(
      (entry) => entry.range.start.line === line,
    );
    const alias = ast.aliases.find((entry) => entry.range.start.line === line);
    const name = participant?.id ?? alias?.alias;
    if (!name) return null;
    const facts = symbolFacts(index, name);
    const rows: HoverRow[] = [
      {
        label: "Kind",
        value: participant
          ? SYMBOL_KIND_LABELS[participant.participantType]
          : "alias",
      },
    ];
    if (participant && participant.label !== participant.id) {
      rows.push({ label: "Label", value: participant.label });
    }
    if (alias) rows.push({ label: "Alias for", value: alias.target });
    rows.push({
      label: "Declared",
      value: facts.declared ?? `${resourceId ?? "this document"}:${line + 1}`,
    });
    rows.push({
      label: "Used by",
      value: `${facts.uses} interaction${facts.uses === 1 ? "" : "s"}`,
    });
    return { title: name, rows };
  }

  // Notes live beside the statement list rather than inside it, so they are
  // looked up separately; everything else is a statement.
  if (kind === "note") {
    const note = ast.notes.find((entry) => entry.range.start.line === line);
    if (!note) return null;
    return {
      title: "Note",
      rows: [
        { label: "Anchored to", value: note.placement },
        {
          label: "Text",
          value:
            note.text.length > 80 ? `${note.text.slice(0, 79)}…` : note.text,
        },
      ],
    };
  }

  const statement = statementAt(ast, line);
  if (!statement) return null;

  switch (statement.type) {
    case "message": {
      const rows: HoverRow[] = [
        { label: "Operation", value: statement.label || "(unlabelled)" },
        { label: "Type", value: messageKind(statement) },
      ];
      if (statement.from !== statement.to) {
        rows.unshift({ label: "Source", value: statement.from });
        rows.splice(1, 0, { label: "Target", value: statement.to });
      }
      if (statement.semantics) {
        rows.push({ label: "Message", value: statement.semantics.name });
        rows.push({ label: "Operation", value: statement.semantics.operation });
        rows.push({ label: "Kind", value: statement.semantics.kind });
      }
      return { title: `${statement.from} → ${statement.to}`, rows };
    }
    case "activation":
      return {
        title: statement.participant,
        rows: [
          {
            label: "Kind",
            value:
              statement.action === "activate"
                ? "activation start"
                : "activation end",
          },
        ],
      };
    default:
      return {
        title: statement.type,
        rows: [{ label: "Kind", value: "control-flow fragment" }],
      };
  }
}
