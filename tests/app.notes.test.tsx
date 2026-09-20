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
 * Notes are the documentation half of a project. These tests drive the real app
 * against the in-memory fallback repository (jsdom has no IndexedDB), covering
 * the whole loop: create a note, edit its markdown, link a diagram, and manage it
 * from the explorer's context menu.
 */
describe("App — markdown notes", () => {
  /** Create a project through the explorer and wait for it to appear. */
  async function createProject(name: string): Promise<void> {
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: name },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent(name);
    });
  }

  /** Create a diagram in the selected project through the command palette. */
  async function createDiagram(): Promise<void> {
    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: "New Diagram" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
  }

  /**
   * Add a markdown note through the project's + menu. The add button now offers
   * a choice of file kind, so note creation is two clicks rather than one.
   */
  function addNote(): void {
    fireEvent.click(screen.getByTestId("project-add-button"));
    fireEvent.click(screen.getByTestId("context-menu-new-note"));
  }

  /** Add a diagram through the same + menu. */
  function addDiagram(): void {
    fireEvent.click(screen.getByTestId("project-add-button"));
    fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
  }

  it("creates a note and renders its markdown", async () => {
    render(<App />);
    await createProject("Docs");

    addNote();

    await waitFor(() => {
      expect(screen.getByTestId("markdown-editor")).toBeInTheDocument();
    });
    // The seeded heading names the note everywhere.
    expect(screen.getByTestId("note-title")).toHaveTextContent("Untitled");
    await waitFor(() => {
      expect(screen.getByTestId("explorer-note")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: "# Architecture\n\nThe API talks to the database." },
    });
    await waitFor(() => {
      const body = screen.getByTestId("markdown-body");
      expect(body.querySelector("h1")?.textContent).toBe("Architecture");
      expect(body.textContent).toContain("The API talks to the database.");
    });
  });

  it("navigates from a note's wiki-link to the diagram it names", async () => {
    render(<App />);
    await createProject("Docs");
    await createDiagram();

    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });

    // The new diagram's file name is "Untitled", so `[[Untitled]]` resolves.
    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: "# Overview\n\nSee [[Untitled]] for the flow." },
    });
    let link: Element | null = null;
    await waitFor(() => {
      link = screen
        .getByTestId("markdown-body")
        .querySelector("[data-diagram-link]");
      expect(link).not.toBeNull();
    });
    expect(link!).not.toHaveClass("markdown__link--broken");

    await act(async () => {
      fireEvent.click(link!);
    });
    // Following the link leaves note mode and shows the diagram preview.
    await waitFor(() => {
      expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
  });

  it("navigates from a project-relative link to the diagram it names", async () => {
    render(<App />);
    await createProject("Docs");
    await createDiagram();

    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });

    // An ordinary relative link resolves against the project's file names, so it
    // opens in-app exactly like a `[[wiki-link]]` does.
    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: "# Overview\n\nSee [the flow](Untitled)." },
    });
    let link: Element | null = null;
    await waitFor(() => {
      link = screen
        .getByTestId("markdown-body")
        .querySelector("[data-resource-link]");
      expect(link).not.toBeNull();
    });
    expect(link!).toHaveClass("markdown__link--resource");

    await act(async () => {
      fireEvent.click(link!);
    });
    await waitFor(() => {
      expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
  });

  it("renders a table in the document preview", async () => {
    render(<App />);
    await createProject("Docs");
    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: {
        value: [
          "# Catalog",
          "",
          "| Event | Producer |",
          "| --- | --- |",
          "| OrderCreated | OrderService |",
        ].join("\n"),
      },
    });

    const body = screen.getByTestId("markdown-body");
    expect(body.querySelector("table")).not.toBeNull();
    expect(body.querySelector("th")?.textContent).toBe("Event");
    expect(body.querySelector("td")?.textContent).toBe("OrderCreated");
  });

  it("marks a link to a missing diagram as broken", async () => {
    render(<App />);
    await createProject("Docs");
    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: "See [[Nowhere]]." },
    });
    await waitFor(() => {
      expect(screen.getByText("Nowhere")).toHaveClass("markdown__link--broken");
    });
  });

  it("changes a note's title from the context menu", async () => {
    render(<App />);
    await createProject("Docs");
    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("explorer-note")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId("explorer-note"));
    fireEvent.click(screen.getByTestId("context-menu-title"));

    const input = screen.getByTestId("prompt-dialog-input");
    fireEvent.change(input, { target: { value: "Design Notes" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("note-title")).toHaveTextContent(
        "Design Notes",
      );
    });
    expect(screen.getByTestId("markdown-textarea")).toHaveValue(
      "# Design Notes\n",
    );
  });

  it("renames a note's file from the context menu", async () => {
    render(<App />);
    await createProject("Docs");
    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("note-filename")).toHaveTextContent(
        "Untitled.md",
      );
    });

    fireEvent.contextMenu(screen.getByTestId("explorer-note"));
    fireEvent.click(screen.getByTestId("context-menu-rename"));
    fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
      target: { value: "architecture.md" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("note-filename")).toHaveTextContent(
        "architecture.md",
      );
    });
  });

  it("deletes a note after confirmation", async () => {
    render(<App />);
    await createProject("Docs");
    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("explorer-note")).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId("explorer-note"));
    fireEvent.click(screen.getByTestId("context-menu-delete"));
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(
      "Delete note",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("explorer-note")).toBeNull();
    });
  });

  it("searches notes alongside diagrams", async () => {
    render(<App />);
    await createProject("Docs");
    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("explorer-note")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("diagram-search-input"), {
      target: { value: "untitled" },
    });
    expect(screen.getByTestId("select-note-button")).toHaveTextContent(
      "Untitled",
    );

    fireEvent.change(screen.getByTestId("diagram-search-input"), {
      target: { value: "nothing-here" },
    });
    expect(screen.getByTestId("explorer-empty")).toHaveTextContent(
      "No diagrams or notes match",
    );
  });

  it("offers diagram and note creation from a project's add menu", async () => {
    render(<App />);
    await createProject("Docs");

    addDiagram();
    await waitFor(() => {
      expect(screen.getByTestId("explorer-diagram")).toBeInTheDocument();
    });
    // The new diagram opens in the DSL editor.
    expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();

    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("explorer-note")).toBeInTheDocument();
    });
    expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
  });

  it("duplicates a note from the context menu", async () => {
    render(<App />);
    await createProject("Docs");
    addNote();
    await waitFor(() => {
      expect(screen.getByTestId("explorer-note")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: "# Runbook\n\nSteps." },
    });

    fireEvent.contextMenu(screen.getByTestId("explorer-note"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-duplicate"));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("explorer-note")).toHaveLength(2);
    });
    // The copy carries the content and becomes the active note.
    expect(screen.getByTestId("note-filename")).toHaveTextContent(
      "Untitled copy.md",
    );
    expect(screen.getByTestId("markdown-textarea")).toHaveValue(
      "# Runbook\n\nSteps.",
    );
  });

  it("duplicates a diagram from the context menu", async () => {
    render(<App />);
    await createProject("Docs");
    addDiagram();
    await waitFor(() => {
      expect(screen.getByTestId("explorer-diagram")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Flow\nA -> B: hi" },
    });

    fireEvent.contextMenu(screen.getByTestId("explorer-diagram"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-duplicate"));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("explorer-diagram")).toHaveLength(2);
    });
    // The copy keeps the source and becomes the active diagram.
    expect(screen.getByTestId("dsl-textarea")).toHaveValue(
      "title Flow\nA -> B: hi",
    );
  });
});
