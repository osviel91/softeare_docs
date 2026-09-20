/**
 * Outline panel: the structure of the open document as a collapsible tree.
 *
 * The panel is presentational by design. It receives an already-built
 * {@link OutlineNode} tree and reports the row the user chose through
 * `onNavigate`; it never parses, loads a resource, or moves a caret itself. That
 * keeps it reusable for any resource kind (a diagram and a markdown document
 * produce the same tree shape) and unit-testable against a fixed tree.
 *
 * The active line is the panel's anchor to the editor: the row for the caret's
 * line is highlighted and its ancestors are opened, so switching to the outline
 * lands the reader where they already were rather than at the top of a folded
 * document. Keyboard handling lives inside the component (arrow keys, Enter)
 * because a tree that only responds to a pointer is not a tree a keyboard user
 * can traverse.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { OutlineNode } from "../../domain/outline/outline";

export interface OutlinePanelProps {
  /** The tree to render, as produced by `sequenceOutline` / `markdownOutline`. */
  nodes: OutlineNode[];
  /** Line the caret is on (1-based); its node is highlighted, and its ancestors expanded. */
  activeLine?: number;
  /** Called when a node is chosen — the shell loads the resource and moves the caret. */
  onNavigate: (node: OutlineNode) => void;
  /** Shown when there is nothing to outline. */
  emptyHint?: string;
}

/** One currently visible row, with everything its rendering needs resolved. */
interface OutlineRow {
  node: OutlineNode;
  /** Nesting depth, 0 for a top-level row. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * The path from the root to the deepest node on `line`, or `[]` when no node
 * sits on it.
 *
 * A fragment and its first statement can share a start line, so the *deepest*
 * match wins; later matches overwrite earlier ones in this pre-order walk, which
 * gives the same result for a row that merely repeats its parent's line.
 */
function findActivePath(nodes: OutlineNode[], line: number): OutlineNode[] {
  let path: OutlineNode[] = [];
  const visit = (list: OutlineNode[], ancestors: OutlineNode[]): void => {
    for (const node of list) {
      const next = [...ancestors, node];
      if (node.line === line) path = next;
      visit(node.children, next);
    }
  };
  visit(nodes, []);
  return path;
}

/** Flatten the tree to the rows a reader can currently see. */
function flatten(
  nodes: OutlineNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    const isExpanded = hasChildren && expanded.has(node.id);
    rows.push({ node, depth, hasChildren, expanded: isExpanded });
    if (isExpanded) rows.push(...flatten(node.children, expanded, depth + 1));
  }
  return rows;
}

/** The outline tree: rows for the document's statements and headings. */
export default function OutlinePanel({
  nodes,
  activeLine,
  onNavigate,
  emptyHint = "Nothing to outline.",
}: OutlinePanelProps) {
  const activePath = useMemo(
    // Lines are 1-based, so -1 can never match and simply means "no active line".
    () => findActivePath(nodes, activeLine ?? -1),
    [nodes, activeLine],
  );
  const activeId =
    activePath.length > 0 ? activePath[activePath.length - 1].id : null;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(activePath.slice(0, -1).map((node) => node.id)),
  );
  const [highlightId, setHighlightId] = useState<string | null>(activeId);

  // Open the ancestors of the active node whenever the caret moves, without
  // folding anything the user opened by hand.
  useEffect(() => {
    const ancestors = activePath.slice(0, -1).map((node) => node.id);
    if (ancestors.length === 0) return;
    setExpanded((previous) => {
      if (ancestors.every((id) => previous.has(id))) return previous;
      const next = new Set(previous);
      for (const id of ancestors) next.add(id);
      return next;
    });
  }, [activePath]);

  // Follow the caret with the highlight, but leave a keyboard highlight alone
  // while the caret itself has not moved.
  useEffect(() => {
    if (activeId !== null) setHighlightId(activeId);
  }, [activeId]);

  if (nodes.length === 0) {
    return (
      <div className="outline" data-testid="outline">
        <p className="outline__empty" data-testid="outline-empty">
          {emptyHint}
        </p>
      </div>
    );
  }

  const rows = flatten(nodes, expanded);
  // A highlight left over from a previous document would match no row, so fall
  // back to the first row to keep exactly one row in the tab order.
  const highlightedId =
    highlightId !== null && rows.some((row) => row.node.id === highlightId)
      ? highlightId
      : (rows[0]?.node.id ?? null);

  const setExpansion = (id: string, value: boolean): void => {
    setExpanded((previous) => {
      if (previous.has(id) === value) return previous;
      const next = new Set(previous);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.node.id === highlightedId);
    const current = index === -1 ? rows[0] : rows[index];

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightId(rows[Math.min(index + 1, rows.length - 1)].node.id);
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightId(rows[Math.max(index - 1, 0)].node.id);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (current.hasChildren && !current.expanded) {
          setExpansion(current.node.id, true);
        } else if (current.hasChildren) {
          // An expanded parent's first child is always the next visible row.
          const child = rows[index + 1];
          if (child) setHighlightId(child.node.id);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (current.hasChildren && current.expanded) {
          setExpansion(current.node.id, false);
        } else {
          // Walk back to the nearest row that is shallower than this one.
          for (let i = index - 1; i >= 0; i -= 1) {
            if (rows[i].depth < current.depth) {
              setHighlightId(rows[i].node.id);
              break;
            }
          }
        }
        break;
      case "Enter":
        event.preventDefault();
        onNavigate(current.node);
        break;
      default:
        break;
    }
  };

  return (
    <div
      className="outline"
      role="tree"
      aria-label="Outline"
      data-testid="outline"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {rows.map((row) => {
        const isActive = row.node.id === activeId;
        const isHighlighted = row.node.id === highlightedId;
        const classes = [
          "outline__item",
          isActive ? "outline__item--active" : "",
          isHighlighted ? "outline__item--highlighted" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={row.node.id}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            aria-selected={isActive}
            aria-current={isActive ? "location" : undefined}
            tabIndex={isHighlighted ? 0 : -1}
            className={classes}
            data-testid="outline-item"
            data-node-id={row.node.id}
            data-kind={row.node.kind}
            style={{ paddingLeft: 8 + row.depth * 14 }}
            onClick={() => {
              setHighlightId(row.node.id);
              onNavigate(row.node);
            }}
          >
            {row.hasChildren ? (
              <button
                type="button"
                className="outline__twisty"
                data-testid="outline-item-toggle"
                aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.node.label}`}
                onClick={(event) => {
                  // The twisty folds the row; it must not also navigate.
                  event.stopPropagation();
                  setExpansion(row.node.id, !row.expanded);
                }}
              >
                {row.expanded ? "\u25be" : "\u25b8"}
              </button>
            ) : (
              <span className="outline__twisty outline__twisty--empty" />
            )}
            <span
              className="outline__label"
              data-testid="outline-item-label"
              data-kind={row.node.kind}
            >
              {row.node.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
