import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./app-harness";

/**
 * A project holds diagrams and markdown documents, and both kinds open into the
 * same tab strip. These tests drive the real app against the in-memory fallback
 * repository (jsdom has no IndexedDB) to prove the strip is genuinely mixed:
 * tabs of either kind coexist, switching follows the tab, and closing the active
 * tab moves the editor to the document that replaces it.
 */
describe("App — mixed document tabs", () => {
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

  /** Add a diagram through the project's + menu. */
  async function addDiagram(): Promise<void> {
    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
  }

  /** Add a markdown document through the project's + menu. */
  async function addNote(): Promise<void> {
    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-note"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });
  }

  it("starts with no open documents", () => {
    render(<App />);
    expect(screen.getByTestId("tab-bar-empty")).toHaveTextContent(
      "No documents open.",
    );
  });

  it("keeps a diagram and a markdown document open side by side", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram();
    await addNote();

    const tabs = screen.getAllByTestId("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("data-kind", "diagram");
    expect(tabs[1]).toHaveAttribute("data-kind", "note");
    // The note was added last, so it is the active document.
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("markdown-editor")).toBeInTheDocument();
  });

  it("switches editor kind when another tab is activated", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram();
    await addNote();

    // Activating the diagram tab swaps the markdown editor for the DSL editor
    // and the rendered note for the diagram canvas.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("tab")[0]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();

    // And back again.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("tab")[1]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("markdown-editor")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("dsl-textarea")).toBeNull();
  });

  it("follows the neighbouring document when the active tab closes", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram();
    await addNote();
    expect(screen.getAllByTestId("tab")).toHaveLength(2);

    // Closing the active note tab leaves the diagram tab, which becomes active
    // and must be loaded into the workspace — not just highlighted.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("tab-close")[1]);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("tab")).toHaveLength(1);
    });
    expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
  });

  it("closes a document from the command palette", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram();
    await addNote();

    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: "Close Tab" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("tab")).toHaveLength(1);
    });
    // The diagram that remained is the active document.
    expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
  });

  it("closes a note's tab when the note is deleted", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram();
    await addNote();

    fireEvent.contextMenu(screen.getByTestId("explorer-note"));
    fireEvent.click(screen.getByTestId("context-menu-delete"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("tab")).toHaveLength(1);
    });
    expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
  });

  it("renames an open note's tab when its file is renamed", async () => {
    render(<App />);
    await createProject("Docs");
    await addNote();

    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: "# Deployment\n\nSteps." },
    });
    await waitFor(() => {
      expect(screen.getByTestId("tab-label")).toHaveTextContent("Deployment");
    });

    fireEvent.contextMenu(screen.getByTestId("explorer-note"));
    fireEvent.click(screen.getByTestId("context-menu-rename"));
    fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
      target: { value: "deployment.md" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    // The heading still names the tab; the file name follows the rename.
    await waitFor(() => {
      expect(screen.getByTestId("note-filename")).toHaveTextContent(
        "deployment.md",
      );
    });
    expect(screen.getAllByTestId("tab")).toHaveLength(1);
  });
});
