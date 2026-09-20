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
 * Phase B: the project-intelligence surfaces, driven through the real shell.
 *
 * These run against the in-memory repository (jsdom has no IndexedDB), so the
 * whole path is covered end to end: the index is built from real files, the
 * panels read it, and editor↔diagram selection travels through the AST's node
 * ids rather than through any text matching.
 */
const CHECKOUT = [
  "title Checkout",
  "participant CartService",
  "participant PaymentService",
  "",
  "CartService ->> PaymentService: Authorize",
].join("\n");

describe("App — project intelligence", () => {
  async function createProject(name = "Payments"): Promise<void> {
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
    // Let the index pick the new content up.
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(source);
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

  function showView(testId: string): void {
    fireEvent.click(screen.getByTestId(testId));
  }

  it("outlines a diagram's participants and flow, and navigates on click", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    showView("view-outline");
    await waitFor(() => {
      expect(screen.getByTestId("outline")).toBeInTheDocument();
    });
    const topLevel = screen
      .getAllByTestId("outline-item-label")
      .map((element) => element.textContent);
    expect(topLevel).toContain("Participants");
    expect(topLevel).toContain("Flow");

    // Section rows start collapsed, so the participants appear once expanded.
    // Only rows with children carry a toggle, and "Title" has none — so the
    // first toggle belongs to "Participants".
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("outline-item-toggle")[0]);
    });
    const labels = screen
      .getAllByTestId("outline-item-label")
      .map((element) => element.textContent);
    expect(labels).toContain("CartService");
    expect(labels).toContain("PaymentService");

    // Choosing a row moves the editor's selection to that statement.
    showView("view-code");
    await act(async () => {
      fireEvent.click(screen.getByTestId("view-outline"));
    });
    const item = screen
      .getAllByTestId("outline-item")
      .find((element) => element.textContent?.includes("Authorize"));
    expect(item).toBeDefined();
    await act(async () => {
      fireEvent.click(item!);
    });
    showView("view-code");
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(
        textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
      ).toContain("Authorize");
    });
  });

  it("lists project problems and opens the offending document", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);
    await addNote("# Architecture\n\nSee [gone](nowhere.seq).");

    // The broken relative link is a project-level warning.
    await waitFor(() => {
      expect(screen.getByTestId("view-problems")).toHaveTextContent("(1)");
    });
    showView("view-problems");
    const problem = screen.getByTestId("problem-item");
    expect(problem).toHaveTextContent("nowhere.seq");
    expect(problem).toHaveAttribute("data-severity", "warning");

    await act(async () => {
      fireEvent.click(problem);
    });
    showView("view-code");
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toHaveValue(
        "# Architecture\n\nSee [gone](nowhere.seq).",
      );
    });
  });

  it("opens a resource through quick open", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);
    await addNote("# Architecture\n\nProse.");

    fireEvent.keyDown(document, { key: "p", metaKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("quick-open")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("quick-open-input"), {
      target: { value: "checkout" },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("quick-open-item").length).toBeGreaterThan(
        0,
      );
    });

    await act(async () => {
      fireEvent.click(screen.getAllByTestId("quick-open-item")[0]);
    });
    expect(screen.queryByTestId("quick-open")).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(CHECKOUT);
    });
  });

  it("offers project participants as completions while typing", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    // Start a second message; the endpoints are participants of this project.
    const textarea = screen.getByTestId("dsl-textarea");
    const source = `${CHECKOUT}\nCartService -> `;
    fireEvent.change(textarea, { target: { value: source } });
    await act(async () => {
      fireEvent.keyUp(textarea, { key: " " });
    });

    await waitFor(() => {
      expect(screen.getByTestId("completions")).toBeInTheDocument();
    });
    const labels = screen
      .getAllByTestId("completion-item")
      .map((element) => element.textContent);
    expect(labels.some((label) => label?.includes("PaymentService"))).toBe(
      true,
    );
  });

  it("inserts a completion into the document", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: `${CHECKOUT}\nCartService -> Pay` },
    });
    await act(async () => {
      fireEvent.keyUp(textarea, { key: "y" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("completions")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.mouseDown(screen.getAllByTestId("completion-item")[0]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(
        `${CHECKOUT}\nCartService -> PaymentService`,
      );
    });
  });

  it("highlights the rendered statement the caret is on", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    const messageLine = CHECKOUT.split("\n")[4];
    const offset = CHECKOUT.indexOf(messageLine) + 2;
    await act(async () => {
      textarea.setSelectionRange(offset, offset);
      fireEvent.click(textarea);
    });

    await waitFor(() => {
      const svg = screen.getByTestId("preview-svg");
      expect(svg.querySelector(".svg-node--active")).not.toBeNull();
    });
    // The highlight is on a message, not on a participant.
    const active = screen
      .getByTestId("preview-svg")
      .querySelector(".svg-node--active");
    expect(active?.getAttribute("data-node-id")).toMatch(/^message@/);
  });

  it("selects a statement's source when its rendered element is clicked", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    const svg = screen.getByTestId("preview-svg");
    const message = svg.querySelector('[data-node-id^="message@"]');
    expect(message).not.toBeNull();

    await act(async () => {
      fireEvent.click(message!);
    });
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(
        textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
      ).toContain("Authorize");
    });
  });

  it("renders an embedded diagram inside a markdown document", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    // The diagram's stable id is derived from its file name.
    await addNote("# Overview\n\n{{diagram:diagram-untitled}}");

    await waitFor(() => {
      const figure = screen
        .getByTestId("markdown-body")
        .querySelector("[data-embed-resource]");
      expect(figure).not.toBeNull();
      expect(figure?.querySelector("svg")).not.toBeNull();
    });
  });

  it("warns about an embed that names nothing", async () => {
    render(<App />);
    await createProject();
    await addNote("# Overview\n\n{{diagram:diagram-missing}}");

    await waitFor(() => {
      expect(
        screen
          .getByTestId("markdown-body")
          .querySelector(".markdown__embed--missing"),
      ).not.toBeNull();
    });
  });

  it("keeps a stable reference working when the file is renamed", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);
    await addNote("# Overview\n\nSee [Checkout](diagram://diagram-untitled).");

    // The stable link resolves before the rename.
    await waitFor(() => {
      const link = screen
        .getByTestId("markdown-body")
        .querySelector("[data-resource-link]");
      expect(link).not.toBeNull();
      expect(link).not.toHaveClass("markdown__link--broken");
    });

    // Rename the diagram's *file*; its resource id must not change.
    fireEvent.contextMenu(screen.getByTestId("explorer-diagram"));
    fireEvent.click(screen.getByTestId("context-menu-rename"));
    fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
      target: { value: "payments.seq" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    // The explorer keeps showing the diagram's *title*, so the rename is
    // observed through its effect rather than through the row's text.
    await waitFor(() => {
      expect(screen.queryByTestId("prompt-dialog")).toBeNull();
    });

    // The document still resolves the stable link, and the project reports no
    // broken reference — which is the whole point of separating id from path.
    showView("view-problems");
    await waitFor(() => {
      expect(screen.getByTestId("problems")).toBeInTheDocument();
    });
    const diagnostics = screen
      .queryAllByTestId("problem-item")
      .map((element) => element.textContent ?? "");
    expect(
      diagnostics.some((text) => text.includes("diagram://diagram-untitled")),
    ).toBe(false);
  });

  it("summarises the project in the overview", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    showView("view-overview");
    await waitFor(() => {
      expect(screen.getByTestId("overview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("overview-resources")).toHaveTextContent(
      "1 diagram",
    );
    expect(screen.getByTestId("overview-symbols")).toHaveTextContent(
      "2 participants",
    );
  });

  it("renames a participant across the project's diagrams", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    // Put the caret on the participant's declaration, then run the command.
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    const declaration = CHECKOUT.split("\n")[1];
    const offset =
      CHECKOUT.indexOf(declaration) + declaration.indexOf("Cart") + 2;
    await act(async () => {
      textarea.setSelectionRange(offset, offset);
      fireEvent.click(textarea);
    });

    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: "Rename Symbol" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });
    const input = screen.getByTestId("prompt-dialog-input");
    expect(input).toHaveValue("CartService");
    fireEvent.change(input, { target: { value: "BasketService" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    await waitFor(() => {
      const value = (screen.getByTestId("dsl-textarea") as HTMLTextAreaElement)
        .value;
      expect(value).toContain("participant BasketService");
      expect(value).toContain("BasketService ->> PaymentService: Authorize");
      expect(value).not.toContain("CartService");
    });
  });

  it("lists a symbol's references through find references", async () => {
    render(<App />);
    await createProject();
    await addDiagram(CHECKOUT);

    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    const declaration = CHECKOUT.split("\n")[1];
    const offset =
      CHECKOUT.indexOf(declaration) + declaration.indexOf("Cart") + 2;
    await act(async () => {
      textarea.setSelectionRange(offset, offset);
      fireEvent.click(textarea);
    });

    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: "Find References" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("search-panel")).toBeInTheDocument();
    });
    // A declaration plus the message endpoint that uses it.
    expect(screen.getAllByTestId("search-result").length).toBe(2);
    expect(screen.getByTestId("search-input")).toHaveValue(
      "References to CartService",
    );
  });
});
