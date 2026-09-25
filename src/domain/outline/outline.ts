/**
 * Document outlines: the structure of a diagram or a markdown document as a
 * navigable tree.
 *
 * An outline is derived data, exactly like the project index: it is computed
 * from the parsed AST or from markdown text on demand and owns no state. Putting
 * the builders in `domain/` rather than inside the Outline panel is what lets
 * the same tree feed the panel, a future "go to symbol" picker, or an export
 * without any of them growing a second implementation. Nothing here touches the
 * DOM, so the shape of a document can be asserted as plain data.
 *
 * Both builders answer the same question for the two document kinds the IDE
 * edits — where am I, and what surrounds me — which is why they share
 * {@link OutlineNode} even though a sequence diagram and a markdown file have
 * little else in common.
 */
import {
  type ActivationNode,
  type MessageNode,
  type NoteNode,
  type SequenceDiagram,
  type SourcePosition,
  type SourceRange,
  type Statement,
} from "../diagram/ast";
import {
  brokersOf,
  channelsOf,
  eventsOf,
  publicationsOf,
  servicesOf,
  subscriptionsOf,
  type EventFlow,
} from "../eventflow/ast";
import { rangeContainsPosition } from "../../language/source-position";

/** What an outline row represents, so a panel can pick a glyph and a tone. */
export type OutlineKind =
  | "title"
  | "participant"
  | "actor"
  | "alias"
  | "message"
  | "activation"
  | "note"
  | "loop"
  | "alt"
  | "opt"
  | "par"
  | "critical"
  | "break"
  | "branch"
  | "heading";

/** One row of a document outline, with the rows nested beneath it. */
export interface OutlineNode {
  /** Stable within one document, e.g. "0.2.1". Never a rendered label. */
  id: string;
  label: string;
  kind: OutlineKind;
  /** 1-based line number to navigate to. */
  line: number;
  /** 0-based source range, so a caller can select exactly the statement. */
  range?: SourceRange;
  children: OutlineNode[];
}

/** How many characters of a note's text a label keeps before it is elided. */
export const NOTE_LABEL_LIMIT = 60;

/** Order two source positions: negative when `a` precedes `b`. */
function comparePositions(a: SourcePosition, b: SourcePosition): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

/** Collapse whitespace and elide `text` once it passes `limit` characters. */
function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/**
 * `<keyword> <text>`, or just the keyword when the text is empty.
 *
 * Fragment labels are the fragment's tab text in the rendered diagram, and that
 * tab is often empty (`alt` with an unlabelled first branch), so the keyword has
 * to stand on its own without a dangling space.
 */
function keywordLabel(keyword: string, text: string): string {
  const trimmed = text.trim();
  return trimmed === "" ? keyword : `${keyword} ${trimmed}`;
}

/** A childless row. `range.start` also fixes its 1-based line. */
function leafNode(
  id: string,
  label: string,
  kind: OutlineKind,
  range: SourceRange,
): OutlineNode {
  return { id, label, kind, line: range.start.line + 1, range, children: [] };
}

/** The label of a message: its text, or `A → B` when it declares none. */
function messageLabel(message: MessageNode): string {
  const text = message.label.trim();
  const base = text === "" ? `${message.from} \u2192 ${message.to}` : text;
  return message.semantics
    ? `${base} [${message.semantics.kind} ${message.semantics.operation}: ${message.semantics.name}]`
    : base;
}

/** The label of an activation: `act: API` / `deact: API`, matching the DSL. */
function activationLabel(activation: ActivationNode): string {
  const verb = activation.action === "activate" ? "act" : "deact";
  return `${verb}: ${activation.participant}`;
}

/**
 * The label of a note: its anchor (`note over API`) plus a one-line excerpt of
 * its text, so a long or multiline note cannot blow up the panel's row.
 */
function noteLabel(note: NoteNode): string {
  let target = "";
  if (note.placement === "on") {
    target = note.messageNumber === undefined ? "" : ` ${note.messageNumber}`;
  } else if (note.participants.length > 0) {
    target = ` ${note.participants.join(", ")}`;
  }
  const head = `note ${note.placement}${target}`;
  const text = truncate(note.text, NOTE_LABEL_LIMIT);
  return text === "" ? head : `${head}: ${text}`;
}

/**
 * A child of one outline level before it has been numbered.
 *
 * Rows are ordered by source position first and numbered second, because an id
 * is a positional path: a note that sits between two statements must take the
 * index between theirs, and the numbering cannot be assigned until the level is
 * in its final order.
 */
type Slot =
  | {
      kind: "statement";
      statement: Statement;
      /** Notes that fall inside this statement's range and belong to it. */
      notes: NoteNode[];
      start: SourcePosition;
    }
  | { kind: "note"; note: NoteNode; start: SourcePosition }
  | {
      kind: "branch";
      /** The keyword that opens the branch: `else`, `and`, or `option`. */
      keyword: string;
      /** The branch's own guard or label text. */
      label: string;
      statements: Statement[];
      notes: NoteNode[];
      range: SourceRange;
      start: SourcePosition;
    };

/** A fragment branch reduced to the shape every kind shares. */
interface FragmentBranch {
  label: string;
  statements: Statement[];
  range: SourceRange;
}

/** The notes whose start position falls inside `range`. */
function notesWithin(notes: NoteNode[], range: SourceRange): NoteNode[] {
  return notes.filter((note) => rangeContainsPosition(range, note.range.start));
}

/** Order slots by source position, leaving the input untouched. */
function sortSlots(slots: Slot[]): Slot[] {
  return [...slots].sort((a, b) => comparePositions(a.start, b.start));
}

/**
 * Order one level's statements and notes, attaching every note to the statement
 * that contains it so nested fragments can claim it in turn.
 *
 * The AST keeps notes in a flat list beside the statement tree (the parser
 * collects them wherever they appear), so the nesting a reader sees in the
 * source has to be reconstructed here from the source ranges.
 */
function levelSlots(statements: Statement[], notes: NoteNode[]): Slot[] {
  const owned = new Map<Statement, NoteNode[]>();
  const own: NoteNode[] = [];

  for (const note of notes) {
    const owner = statements.find((statement) =>
      rangeContainsPosition(statement.range, note.range.start),
    );
    if (owner) {
      const list = owned.get(owner);
      if (list) list.push(note);
      else owned.set(owner, [note]);
    } else {
      own.push(note);
    }
  }

  const slots: Slot[] = statements.map((statement) => ({
    kind: "statement",
    statement,
    notes: owned.get(statement) ?? [],
    start: statement.range.start,
  }));
  for (const note of own) {
    slots.push({ kind: "note", note, start: note.range.start });
  }
  return sortSlots(slots);
}

/** Number and build every slot of one level. */
function buildChildren(slots: Slot[], parentId: string): OutlineNode[] {
  return slots.map((slot, index) => buildSlot(slot, `${parentId}.${index}`));
}

/** Build the row for one slot, given its final positional id. */
function buildSlot(slot: Slot, id: string): OutlineNode {
  switch (slot.kind) {
    case "note":
      return leafNode(id, noteLabel(slot.note), "note", slot.note.range);
    case "branch": {
      const children = buildChildren(
        levelSlots(slot.statements, slot.notes),
        id,
      );
      return {
        id,
        label: keywordLabel(slot.keyword, slot.label),
        kind: "branch",
        line: slot.range.start.line + 1,
        range: slot.range,
        children,
      };
    }
    case "statement":
      return buildStatement(slot.statement, slot.notes, id);
  }
}

/**
 * Build the row for one statement, recursing into the statements it owns.
 *
 * An `alt`/`par`/`critical` fragment is rendered as its *first* branch — that is
 * the region the reader draws the frame around — and each later branch becomes a
 * `branch` sibling holding that branch's statements. The fragment always
 * appears, even when it is empty, because an empty fragment in the source is
 * still a piece of the document's shape.
 */
function buildStatement(
  statement: Statement,
  notes: NoteNode[],
  id: string,
): OutlineNode {
  switch (statement.type) {
    case "message":
      return leafNode(id, messageLabel(statement), "message", statement.range);
    case "activation":
      return leafNode(
        id,
        activationLabel(statement),
        "activation",
        statement.range,
      );
    case "loop":
    case "opt":
    case "break":
      return {
        id,
        label: keywordLabel(statement.type, statement.label),
        kind: statement.type,
        line: statement.range.start.line + 1,
        range: statement.range,
        children: buildChildren(levelSlots(statement.statements, notes), id),
      };
    case "alt":
      return branchFragment(
        "alt",
        "else",
        statement.branches.map((branch) => ({
          label: branch.condition,
          statements: branch.statements,
          range: branch.range,
        })),
        statement.range,
        id,
        notes,
      );
    case "par":
      return branchFragment(
        "par",
        "and",
        statement.branches.map((branch) => ({
          label: branch.label,
          statements: branch.statements,
          range: branch.range,
        })),
        statement.range,
        id,
        notes,
      );
    case "critical":
      return branchFragment(
        "critical",
        "option",
        statement.branches.map((branch) => ({
          label: branch.label,
          statements: branch.statements,
          range: branch.range,
        })),
        statement.range,
        id,
        notes,
      );
  }
}

/**
 * Build one alternative fragment: the first branch *is* the fragment row, and
 * the remaining branches are its siblings.
 *
 * A note that lies inside the fragment but outside every branch (for example
 * after a branch's last statement, before `end`) is kept at the fragment level
 * rather than dropped, so no note can disappear from the outline.
 */
function branchFragment(
  kind: "alt" | "par" | "critical",
  keyword: string,
  branches: FragmentBranch[],
  fallbackRange: SourceRange,
  id: string,
  notes: NoteNode[],
): OutlineNode {
  const [first, ...rest] = branches;
  if (!first) {
    return leafNode(id, keywordLabel(kind, ""), kind, fallbackRange);
  }

  const firstSlots = levelSlots(
    first.statements,
    notesWithin(notes, first.range),
  );
  const branchSlots: Slot[] = rest.map((branch) => ({
    kind: "branch",
    keyword,
    label: branch.label,
    statements: branch.statements,
    notes: notesWithin(notes, branch.range),
    range: branch.range,
    start: branch.range.start,
  }));
  const leftover: Slot[] = notes
    .filter(
      (note) =>
        !branches.some((branch) =>
          rangeContainsPosition(branch.range, note.range.start),
        ),
    )
    .map((note) => ({ kind: "note", note, start: note.range.start }));

  return {
    id,
    label: keywordLabel(kind, first.label),
    kind,
    line: fallbackRange.start.line + 1,
    range: fallbackRange,
    children: buildChildren(
      sortSlots([...firstSlots, ...branchSlots, ...leftover]),
      id,
    ),
  };
}

/**
 * The outline of a sequence diagram: its title, its declarations, then its flow.
 *
 * The three sections are the same three a reader scans for, and a section only
 * appears when the diagram actually has it — an untitled diagram has no Title
 * row, and a diagram with no statements has no Flow row.
 */
export function sequenceOutline(ast: SequenceDiagram | null): OutlineNode[] {
  if (!ast) return [];

  const sections: OutlineNode[] = [];

  if (ast.title) {
    // The Title row is a section header like "Participants" and "Flow"; the
    // title's text itself is already the first thing the editor shows.
    sections.push(leafNode("0", "Title", "title", ast.title.range));
  }

  const members: Array<{
    label: string;
    kind: OutlineKind;
    range: SourceRange;
  }> = [
    ...ast.participants.map((participant) => ({
      label: participant.label,
      kind: participant.participantType,
      range: participant.range,
    })),
    ...ast.aliases.map((alias) => ({
      label: `alias ${alias.alias} = ${alias.target}`,
      kind: "alias" as const,
      range: alias.range,
    })),
  ];
  if (members.length > 0) {
    const sectionId = String(sections.length);
    sections.push({
      id: sectionId,
      label: "Participants",
      kind: "participant",
      line: members[0].range.start.line + 1,
      children: members.map((member, index) =>
        leafNode(
          `${sectionId}.${index}`,
          member.label,
          member.kind,
          member.range,
        ),
      ),
    });
  }

  const flowSlots = levelSlots(ast.statements, ast.notes);
  if (flowSlots.length > 0) {
    const sectionId = String(sections.length);
    const children = buildChildren(flowSlots, sectionId);
    sections.push({
      id: sectionId,
      label: "Flow",
      kind: "message",
      line: children[0].line,
      children,
    });
  }

  return sections;
}

/** An ATX heading: up to three leading spaces, one to six `#`, then text. */
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;

/** A code fence opener: at least three backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Remove a closing `###` sequence from an ATX heading's text. */
function headingText(raw: string): string {
  return raw.replace(/\s+#+\s*$/, "").trim();
}

/**
 * The outline of a markdown document: its headings, nested by level.
 *
 * Fenced code blocks are tracked so a `# comment` inside a code sample is not
 * mistaken for structure — the one place where markdown's own escaping rules
 * would otherwise leak into the outline. A heading that jumps a level (an `h4`
 * directly after an `h2`) nests under the nearest shallower heading, and a
 * document whose first heading is not an `h1` starts at the top level, so
 * partial documents still outline sensibly.
 *
 * Only ATX (`#`) headings are recognized, matching `noteHeadings`, which is
 * what the rest of the app treats as a heading.
 */
export function markdownOutline(markdown: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const parents: Array<{ level: number; node: OutlineNode }> = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  // The currently open fence, if any: its character and its run length.
  let fence: { char: string; length: number } | null = null;

  for (const [index, line] of lines.entries()) {
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      // Inside a fence only a matching closing fence is meaningful.
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      // A backtick fence may not carry a backtick in its info string; when it
      // does, this is ordinary inline code, not a fence.
      if (!(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
        fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
        continue;
      }
    }

    const heading = HEADING.exec(line);
    if (!heading) continue;
    const level = heading[1].length;
    const text = headingText(heading[2]);
    // A heading with no text would render as a blank, unclickable row.
    if (text === "") continue;

    while (parents.length > 0 && parents[parents.length - 1].level >= level) {
      parents.pop();
    }
    const parent = parents[parents.length - 1]?.node;
    const siblings = parent ? parent.children : roots;
    const node: OutlineNode = {
      id: parent ? `${parent.id}.${siblings.length}` : String(siblings.length),
      label: text,
      kind: "heading",
      line: index + 1,
      children: [],
    };
    siblings.push(node);
    parents.push({ level, node });
  }

  return roots;
}

/**
 * The outline of an event flow: what it declares, then what happens.
 *
 * An event-driven document has no sequence to walk, so the tree is grouped by
 * what a reader looks for: the events (the vocabulary), the participants (who
 * produces and consumes), the channels they travel through, and finally the
 * causal edges grouped per producer. Grouping the edges by producer is what
 * makes a chain visible in the tree — the same service appears as a consumer in
 * one group and a producer in another.
 */
export function eventFlowOutline(flow: EventFlow | null): OutlineNode[] {
  if (!flow) return [];

  const section = (id: string, label: string, line: number): OutlineNode => ({
    id,
    label,
    kind: "message",
    line,
    children: [],
  });
  const child = (
    parent: OutlineNode,
    label: string,
    kind: OutlineKind,
    line: number,
    range?: OutlineNode["range"],
  ): OutlineNode => {
    const node: OutlineNode = {
      id: `${parent.id}.${parent.children.length}`,
      label,
      kind,
      line,
      range,
      children: [],
    };
    parent.children.push(node);
    return node;
  };

  const roots: OutlineNode[] = [];
  if (flow.title) {
    roots.push({
      id: "0",
      label: flow.title.value,
      kind: "title",
      line: flow.title.range.start.line + 1,
      range: flow.title.range,
      children: [],
    });
  }

  const events = eventsOf(flow);
  if (events.length > 0) {
    const eventsSection = section(
      String(roots.length),
      `Events (${events.length})`,
      events[0].range.start.line + 1,
    );
    for (const event of events) {
      const node = child(
        eventsSection,
        event.name,
        "message",
        event.range.start.line + 1,
        event.range,
      );
      // Metadata is part of what an event *is*, so it hangs off the event rather
      // than being flattened into the section.
      for (const entry of event.metadata) {
        child(
          node,
          `${entry.key}: ${entry.value}`,
          "note",
          entry.range.start.line + 1,
          entry.range,
        );
      }
    }
    roots.push(eventsSection);
  }

  const services = servicesOf(flow);
  if (services.length > 0) {
    const servicesSection = section(
      String(roots.length),
      "Services",
      services[0].range.start.line + 1,
    );
    for (const service of services) {
      child(
        servicesSection,
        service.role === "service"
          ? service.name
          : `${service.name} (${service.role})`,
        "participant",
        service.range.start.line + 1,
        service.range,
      );
    }
    roots.push(servicesSection);
  }

  const channels = channelsOf(flow);
  if (channels.length > 0) {
    const channelsSection = section(
      String(roots.length),
      "Channels",
      channels[0].range.start.line + 1,
    );
    for (const channel of channels) {
      child(
        channelsSection,
        channel.broker
          ? `${channel.name} (${channel.channelKind} on ${channel.broker})`
          : `${channel.name} (${channel.channelKind})`,
        "note",
        channel.range.start.line + 1,
        channel.range,
      );
    }
    roots.push(channelsSection);
  }

  const brokers = brokersOf(flow);
  if (brokers.length > 0) {
    const brokersSection = section(
      String(roots.length),
      "Brokers",
      brokers[0].range.start.line + 1,
    );
    for (const broker of brokers) {
      child(
        brokersSection,
        broker.name,
        "note",
        broker.range.start.line + 1,
        broker.range,
      );
    }
    roots.push(brokersSection);
  }

  const publications = publicationsOf(flow);
  const subscriptions = subscriptionsOf(flow);
  if (publications.length > 0 || subscriptions.length > 0) {
    const flowSection = section(
      String(roots.length),
      "Flow",
      (publications[0] ?? subscriptions[0]).range.start.line + 1,
    );
    // Producers first: the causal reading of the document starts at what
    // publishes, and each producer's publishes and consumes sit together.
    const byProducer = new Map<string, OutlineNode>();
    for (const publication of publications) {
      let node = byProducer.get(publication.producer);
      if (!node) {
        node = child(
          flowSection,
          publication.producer,
          "participant",
          publication.range.start.line + 1,
        );
        byProducer.set(publication.producer, node);
      }
      child(
        node,
        `publishes ${publication.event}${
          publication.channel ? ` to ${publication.channel}` : ""
        }`,
        "message",
        publication.range.start.line + 1,
        publication.range,
      );
    }
    for (const subscription of subscriptions) {
      const node = byProducer.get(subscription.consumer);
      if (!node) {
        // A consumer that never publishes is still a participant in the flow.
        const created = child(
          flowSection,
          subscription.consumer,
          "participant",
          subscription.range.start.line + 1,
        );
        byProducer.set(subscription.consumer, created);
        child(
          created,
          `consumes ${subscription.event}${
            subscription.channel ? ` from ${subscription.channel}` : ""
          }`,
          "message",
          subscription.range.start.line + 1,
          subscription.range,
        );
        continue;
      }
      child(
        node,
        `consumes ${subscription.event}${
          subscription.channel ? ` from ${subscription.channel}` : ""
        }`,
        "message",
        subscription.range.start.line + 1,
        subscription.range,
      );
    }
    roots.push(flowSection);
  }

  return roots;
}
