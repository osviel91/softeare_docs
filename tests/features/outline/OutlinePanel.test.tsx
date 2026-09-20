import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { OutlineNode } from "../../../src/domain/outline/outline";
import OutlinePanel from "../../../src/features/outline/OutlinePanel";

/** A leaf outline row, with every field a test does not care about defaulted. */
function row(
  id: string,
  label: string,
  overrides: Partial<OutlineNode> = {},
): OutlineNode {
  return { id, label, kind: "message", line: 1, children: [], ...overrides };
}

/**
 * A small stand-in for a real document outline:
 *
 *   Title
 *   Participants
 *     User
 *     API
 *   Flow
 *     Login request
 *     alt Valid
 *       Load user
 */
const NODES: OutlineNode[] = [
  row("0", "Title", { kind: "title" }),
  row("1", "Participants", {
    kind: "participant",
    line: 2,
    children: [
      row("1.0", "User", { kind: "participant", line: 2 }),
      row("1.1", "API", { kind: "participant", line: 3 }),
    ],
  }),
  row("2", "Flow", {
    line: 5,
    children: [
      row("2.0", "Login request", { line: 5 }),
      row("2.1", "alt Valid", {
        kind: "alt",
        line: 6,
        children: [row("2.1.0", "Load user", { line: 7 })],
      }),
    ],
  }),
];

/** The one treeitem whose label is `label`. */
function rowFor(label: string): HTMLElement {
  const element = screen
    .getByText(label)
    .closest<HTMLElement>("[data-testid='outline-item']");
  if (!element) throw new Error(`no outline row labelled "${label}"`);
  return element;
}

/** The labels of every currently visible row, in document order. */
function visibleLabels(): string[] {
  return screen
    .getAllByTestId("outline-item-label")
    .map((element) => element.textContent ?? "");
}

describe("OutlinePanel", () => {
  it("renders a tree with one treeitem per visible row and its depth", () => {
    render(<OutlinePanel nodes={NODES} onNavigate={vi.fn()} />);

    expect(screen.getByTestId("outline")).toHaveAttribute("role", "tree");
    // Collapsed by default: only the three top-level rows are visible.
    expect(visibleLabels()).toEqual(["Title", "Participants", "Flow"]);

    const items = screen.getAllByTestId("outline-item");
    expect(items[0]).toHaveAttribute("aria-level", "1");
    expect(items[1]).toHaveAttribute("aria-level", "1");
    expect(items[1]).toHaveAttribute("aria-expanded", "false");
    expect(items[0]).not.toHaveAttribute("aria-expanded");
  });

  it("opens the active node's ancestors and highlights its node", () => {
    render(<OutlinePanel nodes={NODES} activeLine={7} onNavigate={vi.fn()} />);

    expect(visibleLabels()).toEqual([
      "Title",
      "Participants",
      "Flow",
      "Login request",
      "alt Valid",
      "Load user",
    ]);
    expect(rowFor("Flow")).toHaveAttribute("aria-expanded", "true");
    expect(rowFor("alt Valid")).toHaveAttribute("aria-expanded", "true");
    expect(rowFor("Load user")).toHaveAttribute("aria-selected", "true");
    expect(rowFor("Flow")).toHaveAttribute("aria-selected", "false");
    // A sibling branch stays folded because the caret is not inside it.
    expect(rowFor("Participants")).toHaveAttribute("aria-expanded", "false");
  });

  it("highlights nothing when the caret is on a line with no node", () => {
    render(<OutlinePanel nodes={NODES} activeLine={99} onNavigate={vi.fn()} />);
    for (const item of screen.getAllByTestId("outline-item")) {
      expect(item).toHaveAttribute("aria-selected", "false");
    }
  });

  it("expands a collapsed node when its twisty is clicked", () => {
    render(<OutlinePanel nodes={NODES} onNavigate={vi.fn()} />);

    const toggle = within(rowFor("Participants")).getByTestId(
      "outline-item-toggle",
    );
    fireEvent.click(toggle);

    expect(visibleLabels()).toEqual([
      "Title",
      "Participants",
      "User",
      "API",
      "Flow",
    ]);
    expect(rowFor("Participants")).toHaveAttribute("aria-expanded", "true");
  });

  it("navigates when a row is clicked and does not navigate on the twisty", () => {
    const onNavigate = vi.fn();
    render(<OutlinePanel nodes={NODES} onNavigate={onNavigate} />);

    fireEvent.click(rowFor("Flow"));
    expect(onNavigate).toHaveBeenCalledWith(NODES[2]);

    onNavigate.mockClear();
    fireEvent.click(
      within(rowFor("Participants")).getByTestId("outline-item-toggle"),
    );
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("moves the highlight with the arrow keys and navigates with Enter", () => {
    const onNavigate = vi.fn();
    render(<OutlinePanel nodes={NODES} onNavigate={onNavigate} />);
    const tree = screen.getByTestId("outline");

    // The first row carries the highlight initially.
    expect(rowFor("Title")).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(rowFor("Participants")).toHaveAttribute("tabindex", "0");
    expect(rowFor("Title")).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith(NODES[1]);

    fireEvent.keyDown(tree, { key: "ArrowUp" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onNavigate).toHaveBeenLastCalledWith(NODES[0]);
  });

  it("expands with Right, steps into the child, and collapses with Left", () => {
    render(<OutlinePanel nodes={NODES} onNavigate={vi.fn()} />);
    const tree = screen.getByTestId("outline");

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(rowFor("Participants")).toHaveAttribute("aria-expanded", "true");
    expect(visibleLabels()).toContain("User");

    // Right again steps onto the first child rather than re-expanding.
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(rowFor("User")).toHaveAttribute("tabindex", "0");

    // Left on a leaf climbs to its parent, Left on the parent collapses it.
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(rowFor("Participants")).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(rowFor("Participants")).toHaveAttribute("aria-expanded", "false");
    expect(visibleLabels()).not.toContain("User");
  });

  it("shows the empty hint when there is nothing to outline", () => {
    const { unmount } = render(
      <OutlinePanel nodes={[]} onNavigate={vi.fn()} emptyHint="Open a file." />,
    );
    expect(screen.getByTestId("outline-empty")).toHaveTextContent(
      "Open a file.",
    );
    expect(screen.queryAllByTestId("outline-item")).toHaveLength(0);
    unmount();

    render(<OutlinePanel nodes={[]} onNavigate={vi.fn()} />);
    expect(screen.getByTestId("outline-empty")).toHaveTextContent(
      "Nothing to outline.",
    );
  });
});
