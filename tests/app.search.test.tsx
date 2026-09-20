import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";

/**
 * Project-wide search spans every document in the workspace — diagrams and
 * markdown alike — and a result navigates straight to the matching line. These
 * tests drive the real app against the in-memory fallback repository (jsdom has
 * no IndexedDB) so the whole path is covered: shortcut, query, result list,
 * document load, and caret placement.
 */
describe("App — project search", () => {
  const CHECKOUT_SOURCE = [
    "title Checkout",
    "participant CartService",
    "participant PaymentService",
    "CartService ->> PaymentService: UNIQUEMARKER",
  ].join("\n");

  async function createProject(name: string): Promise<void> {
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: name },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent(name);
    });
  }

  async function addDiagram(source: string): Promise<void> {
    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: source },
    });
  }

  async function addNote(markdown: string): Promise<void> {
    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-note"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: markdown },
    });
  }

  /** Open the search overlay with the keyboard shortcut. */
  function openSearchWithShortcut(): void {
    fireEvent.keyDown(document, { key: "f", metaKey: true, shiftKey: true });
  }

  it("opens with Ctrl/Cmd+Shift+F and prompts for a query", async () => {
    render(<App />);
    openSearchWithShortcut();
    expect(screen.getByTestId("search-panel")).toBeInTheDocument();
    expect(screen.getByTestId("search-hint")).toBeInTheDocument();
  });

  it("opens from the command palette", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: "Search Project" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });
    expect(screen.getByTestId("search-panel")).toBeInTheDocument();
  });

  it("finds text in a diagram and opens it at the matching line", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram(CHECKOUT_SOURCE);
    await addNote("# Notes\n\nNothing to see.");

    openSearchWithShortcut();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "UNIQUEMARKER" },
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("search-result")).toHaveLength(1);
    });
    expect(screen.getByTestId("search-result")).toHaveTextContent("Checkout");

    await act(async () => {
      fireEvent.click(screen.getByTestId("search-result-button"));
    });

    // The overlay closes, the diagram's tab is active, and the caret sits on the
    // match rather than merely at the top of the document.
    await waitFor(() => {
      expect(screen.queryByTestId("search-panel")).toBeNull();
    });
    const textarea = screen.getByTestId("dsl-textarea");
    expect(textarea).toHaveValue(CHECKOUT_SOURCE);
    const start = CHECKOUT_SOURCE.indexOf("UNIQUEMARKER");
    expect(textarea).toHaveProperty("selectionStart", start);
    expect(textarea).toHaveProperty(
      "selectionEnd",
      start + "UNIQUEMARKER".length,
    );
  });

  it("finds text across documents and navigates between kinds", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram(CHECKOUT_SOURCE);
    await addNote("# Architecture\n\nPaymentService owns payments.");

    openSearchWithShortcut();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "PaymentService" },
    });
    // The declaration, the message label, and the markdown paragraph.
    await waitFor(() => {
      expect(screen.getAllByTestId("search-result")).toHaveLength(3);
    });

    // The last result is the markdown document, so opening it swaps editors.
    const results = screen.getAllByTestId("search-result-button");
    await act(async () => {
      fireEvent.click(results[2]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("dsl-textarea")).toBeNull();
  });

  it("scopes a query to diagrams with kind: and to a participant with participant:", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram(CHECKOUT_SOURCE);
    await addNote("# Architecture\n\nPaymentService owns payments.");

    openSearchWithShortcut();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "PaymentService kind:note" },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("search-result")).toHaveLength(1);
    });
    expect(screen.getByTestId("search-result")).toHaveTextContent("¶");

    // A filter-only query lists the documents declaring that participant.
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "participant:CartService" },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("search-result")).toHaveLength(1);
    });
    expect(screen.getByTestId("search-result")).toHaveTextContent("Checkout");
  });

  it("closes without navigating when Escape is pressed", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram(CHECKOUT_SOURCE);

    openSearchWithShortcut();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "CartService" },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("search-result").length).toBeGreaterThan(0);
    });

    fireEvent.keyDown(screen.getByTestId("search-panel"), { key: "Escape" });
    expect(screen.queryByTestId("search-panel")).toBeNull();
    expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
  });

  it("reports when nothing matches", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram(CHECKOUT_SOURCE);

    openSearchWithShortcut();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "nowhere-at-all" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("search-empty")).toBeInTheDocument();
    });
  });
});
