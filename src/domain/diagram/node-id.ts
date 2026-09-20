/**
 * Deterministic ids for addressable AST nodes.
 *
 * The UI needs to map a rendered SVG element back to the source span it came
 * from, and a caret position forward to the element it should select. Rather
 * than store an id on every AST node — which would touch the parser and make
 * ids depend on traversal order — an id is *computed* from the node's kind and
 * its source range. The same text always produces the same ranges, so two
 * parses of one document yield byte-identical ids.
 *
 * There is a single internal iterator over the addressable node set
 * ({@link addressableNodes}). The id function, the deepest-node lookup, and the
 * inverse lookup all read from it, so they cannot drift apart: teaching the id
 * system about a new node kind is one `yield`, not three parallel edits.
 */
import type {
  SequenceDiagram,
  SourcePosition,
  SourceRange,
  Statement,
} from "./ast";
import {
  offsetToPosition,
  rangeContainsPosition,
} from "../../language/source-position";

/** A deterministic, source-derived identifier for an addressable AST node. */
export type AstNodeId = string;

/** The kind of addressable node, used as the id's prefix. */
export type AstNodeKind =
  | "title"
  | "participant"
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
  | "branch";

/**
 * A deterministic id for a node: `<kind>@<line>:<column>` (both 0-based).
 *
 * The range's start is enough to identify a node because two nodes of the same
 * kind never begin at the same position. A message and the inline activation it
 * carries share a start, but they have different kinds and therefore different
 * prefixes.
 */
export function nodeIdOf(kind: AstNodeKind, range: SourceRange): AstNodeId {
  return `${kind}@${range.start.line}:${range.start.column}`;
}

/** One addressable node: what it is, where it lives, and how deeply nested. */
interface AddressableNode {
  kind: AstNodeKind;
  range: SourceRange;
  /**
   * Structural nesting depth. Deeper nodes win when ranges overlap, which is
   * what makes a message beat the fragment that encloses it and a branch beat
   * its own fragment.
   */
  depth: number;
}

/**
 * Every addressable node in a diagram, with its kind, range, and depth.
 *
 * Statements are walked recursively so nested fragments and branches are
 * included. Notes are stored beside the statement list rather than inside it,
 * so a note's depth is derived from the deepest fragment or branch whose range
 * lexically contains it; without that, a note written inside a fragment would
 * lose to the enclosing frame.
 */
function* addressableNodes(
  diagram: SequenceDiagram,
): Generator<AddressableNode> {
  if (diagram.title) {
    yield { kind: "title", range: diagram.title.range, depth: 0 };
  }
  for (const participant of diagram.participants) {
    yield { kind: "participant", range: participant.range, depth: 0 };
  }
  for (const alias of diagram.aliases) {
    yield { kind: "alias", range: alias.range, depth: 0 };
  }

  // Containers are recorded while walking so notes can be nested below the
  // deepest fragment or branch that lexically holds them.
  const containers: AddressableNode[] = [];
  yield* statementNodes(diagram.statements, 0, containers);

  for (const note of diagram.notes) {
    const enclosing = containers.reduce(
      (depth, container) =>
        rangeContainsPosition(container.range, note.range.start)
          ? Math.max(depth, container.depth)
          : depth,
      0,
    );
    yield { kind: "note", range: note.range, depth: enclosing + 1 };
  }
}

/**
 * Yield the addressable nodes of one statement list, recording the fragments
 * and branches it contains onto `containers` as it goes.
 */
function* statementNodes(
  statements: Statement[],
  depth: number,
  containers: AddressableNode[],
): Generator<AddressableNode> {
  for (const statement of statements) {
    switch (statement.type) {
      case "message":
        yield { kind: "message", range: statement.range, depth };
        break;
      case "activation":
        yield { kind: "activation", range: statement.range, depth };
        break;
      case "loop":
      case "opt":
      case "break": {
        const node: AddressableNode = {
          kind: statement.type,
          range: statement.range,
          depth,
        };
        containers.push(node);
        yield node;
        // A single-block fragment has no branch level, so its statements sit
        // one level deeper than the frame itself.
        yield* statementNodes(statement.statements, depth + 1, containers);
        break;
      }
      case "alt":
      case "par":
      case "critical": {
        const node: AddressableNode = {
          kind: statement.type,
          range: statement.range,
          depth,
        };
        containers.push(node);
        yield node;
        for (const branch of statement.branches) {
          const branchNode: AddressableNode = {
            kind: "branch",
            range: branch.range,
            depth: depth + 1,
          };
          containers.push(branchNode);
          yield branchNode;
          yield* statementNodes(branch.statements, depth + 2, containers);
        }
        break;
      }
    }
  }
}

/**
 * The deepest addressable node whose range contains `position`.
 *
 * Returns `null` when the position is not inside anything addressable — blank
 * space, a comment, or beyond the last statement.
 */
export function nodeIdAtPosition(
  ast: SequenceDiagram,
  position: SourcePosition,
): AstNodeId | null {
  let best: AddressableNode | null = null;
  for (const node of addressableNodes(ast)) {
    if (!rangeContainsPosition(node.range, position)) continue;
    if (best === null || node.depth >= best.depth) best = node;
  }
  return best === null ? null : nodeIdOf(best.kind, best.range);
}

/**
 * The deepest addressable node at a character offset.
 *
 * Convenience for a `<textarea>`, whose selection is an offset rather than a
 * line/column pair.
 */
export function nodeIdAtOffset(
  source: string,
  ast: SequenceDiagram,
  offset: number,
): AstNodeId | null {
  return nodeIdAtPosition(ast, offsetToPosition(source, offset));
}

/**
 * The source range of the node an id names, or `null` when no node matches.
 *
 * The id string is deliberately not parsed back apart: the same iterator that
 * produced the id compares against it, so the forward and inverse lookups can
 * never disagree about the id scheme.
 */
export function nodeRangeById(
  ast: SequenceDiagram,
  id: AstNodeId,
): SourceRange | null {
  for (const node of addressableNodes(ast)) {
    if (nodeIdOf(node.kind, node.range) === id) return node.range;
  }
  return null;
}

/**
 * Take an id apart again: its kind and the 0-based position it was built from.
 *
 * This module owns both directions of its own id format, so a caller that needs
 * the kind (hover, for instance) does not have to re-derive the shape and risk
 * drifting from {@link nodeIdOf}.
 */
export function parseNodeId(
  id: AstNodeId,
): { kind: AstNodeKind; line: number; column: number } | null {
  const match = /^([a-z]+)@(\d+):(\d+)$/.exec(id);
  if (!match) return null;
  const kind = match[1] as AstNodeKind;
  return {
    kind,
    line: Number(match[2]),
    column: Number(match[3]),
  };
}
