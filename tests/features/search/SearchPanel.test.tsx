import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SearchMatch } from "../../../src/domain/search/project-search";
import SearchPanel from "../../../src/features/search/SearchPanel";

const match = (overrides: Partial<SearchMatch> = {}): SearchMatch => ({
  kind: "diagram",
  id: "diag-1",
  projectId: "docs",
  projectName: "Docs",
  name: "checkout.seq",
  title: "Checkout",
  line: 4,
  column: 1,
  offset: 30,
  length: 6,
  text: "Save",
  excerpt: "PaymentService ->> DB: Save",
  matchedFields: ["content"],
  ...overrides,
});

describe("SearchPanel", () => {
  it("prompts for a query before anything is typed", () => {
    render(
      <SearchPanel
        query=""
        onQueryChange={vi.fn()}
        matches={[]}
        onOpenMatch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("search-hint")).toHaveTextContent(
      "Type to search",
    );
  });

  it("reports every keystroke as a query change", () => {
    const onQueryChange = vi.fn();
    render(
      <SearchPanel
        query=""
        onQueryChange={onQueryChange}
        matches={[]}
        onOpenMatch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "payment" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("payment");
  });

  it("shows the document, project and line of each match", () => {
    render(
      <SearchPanel
        query="payment"
        onQueryChange={vi.fn()}
        matches={[match()]}
        onOpenMatch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const result = screen.getByTestId("search-result");
    expect(result).toHaveTextContent("Checkout");
    expect(result).toHaveTextContent("Docs · checkout.seq:4");
    expect(result).toHaveTextContent("PaymentService ->> DB: Save");
  });

  it("names the kind of each result", () => {
    render(
      <SearchPanel
        query="x"
        onQueryChange={vi.fn()}
        matches={[
          match(),
          match({ kind: "note", id: "note-1", title: "Architecture" }),
        ]}
        onOpenMatch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("search-result")[0]).toHaveTextContent("▦");
    expect(screen.getAllByTestId("search-result")[1]).toHaveTextContent("¶");
  });

  it("counts the matches it is showing", () => {
    render(
      <SearchPanel
        query="x"
        onQueryChange={vi.fn()}
        matches={[match(), match({ id: "diag-2" })]}
        onOpenMatch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("search-count")).toHaveTextContent("2 matches");
  });

  it("says so when nothing matches", () => {
    render(
      <SearchPanel
        query="nowhere"
        onQueryChange={vi.fn()}
        matches={[]}
        onOpenMatch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("search-empty")).toHaveTextContent(
      "No matches for “nowhere”",
    );
  });

  it("opens a match when its row is clicked", () => {
    const onOpenMatch = vi.fn();
    const only = match();
    render(
      <SearchPanel
        query="payment"
        onQueryChange={vi.fn()}
        matches={[only]}
        onOpenMatch={onOpenMatch}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("search-result-button"));
    expect(onOpenMatch).toHaveBeenCalledWith(only);
  });

  it("opens the highlighted match with Enter and moves with the arrow keys", () => {
    const onOpenMatch = vi.fn();
    const first = match();
    const second = match({ id: "diag-2", title: "Other" });
    render(
      <SearchPanel
        query="payment"
        onQueryChange={vi.fn()}
        matches={[first, second]}
        onOpenMatch={onOpenMatch}
        onClose={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("search-panel");
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    fireEvent.keyDown(panel, { key: "Enter" });
    expect(onOpenMatch).toHaveBeenCalledWith(second);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <SearchPanel
        query="x"
        onQueryChange={vi.fn()}
        matches={[match()]}
        onOpenMatch={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("search-panel"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked, not when the panel is", () => {
    const onClose = vi.fn();
    render(
      <SearchPanel
        query="x"
        onQueryChange={vi.fn()}
        matches={[match()]}
        onOpenMatch={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.mouseDown(screen.getByTestId("search-input"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("search-panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
