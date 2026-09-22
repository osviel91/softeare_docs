import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./app-harness";

/** Create an in-browser project named `name` and wait for its header. */
async function createProject(name: string): Promise<void> {
  fireEvent.change(screen.getByTestId("project-name-input"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByTestId("create-project-button"));
  await waitFor(() => {
    expect(screen.getByTestId("project-name")).toHaveTextContent(name);
  });
}

/** Create a second project, once two headers make `getByTestId` ambiguous. */
async function createSecondProject(name: string): Promise<void> {
  fireEvent.change(screen.getByTestId("project-name-input"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByTestId("create-project-button"));
  await waitFor(() => {
    expect(screen.getAllByTestId("project-name")).toHaveLength(2);
  });
}

/** The diagram rows belonging to the project at `index` in the explorer. */
function diagramsInProject(index: number): HTMLElement[] {
  const projects = screen.getAllByTestId("explorer-project");
  return within(projects[index]).queryAllByTestId("explorer-diagram");
}

describe("App — project management", () => {
  it("renames a project through its ⋯ actions menu", async () => {
    render(<App />);
    await createProject("Notes");

    fireEvent.click(screen.getByTestId("project-menu-button"));
    fireEvent.click(screen.getByTestId("context-menu-rename-project"));

    expect(screen.getByTestId("prompt-dialog")).toHaveTextContent(
      "Rename project",
    );
    fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
      target: { value: "Ideas" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Ideas");
    });
  });

  it("deletes a project through the same ⋯ actions menu", async () => {
    render(<App />);
    await createProject("Notes");

    fireEvent.click(screen.getByTestId("project-menu-button"));
    fireEvent.click(screen.getByTestId("context-menu-delete-project"));

    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(
      "Delete project",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("explorer-project")).toBeNull();
    });
  });

  it("collapses and re-expands a project from its header chevron", async () => {
    render(<App />);
    await createProject("Notes");

    const toggle = screen.getByTestId("project-collapse-button");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("explorer-diagrams")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByTestId("project-collapse-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("explorer-diagrams")).toBeNull();

    fireEvent.click(screen.getByTestId("project-collapse-button"));
    expect(screen.getByTestId("explorer-diagrams")).toBeInTheDocument();
  });

  it("keeps showing a project's files after another project is selected", async () => {
    render(<App />);
    await createProject("Default");

    // Give the first project a diagram through its ＋ menu.
    fireEvent.click(screen.getByTestId("project-add-button"));
    fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    await waitFor(() => {
      expect(screen.getByTestId("explorer-diagram")).toBeInTheDocument();
    });

    // A second project becomes the selection, so Default is no longer selected.
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Project2" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getAllByTestId("project-name")).toHaveLength(2);
    });

    // Default's file stays listed under its expanded header...
    expect(screen.getByTestId("explorer-diagram")).toBeInTheDocument();
    expect(screen.getByTestId("select-diagram-button")).toBeInTheDocument();

    // ...and its chevron still folds it away and back.
    fireEvent.click(screen.getAllByTestId("project-collapse-button")[0]);
    expect(screen.queryByTestId("explorer-diagram")).toBeNull();
    fireEvent.click(screen.getAllByTestId("project-collapse-button")[0]);
    expect(screen.getByTestId("explorer-diagram")).toBeInTheDocument();
  });

  it("adds a file to the project you clicked without copying the selected project's files", async () => {
    render(<App />);
    await createProject("Default");
    fireEvent.click(screen.getByTestId("project-add-button"));
    fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    await waitFor(() => {
      expect(diagramsInProject(0)).toHaveLength(1);
    });

    await createSecondProject("Project2");

    // Re-select Default by loading its diagram, then add a file to Project2 —
    // the project that is *not* selected. Its row must list only its own file.
    const projects = screen.getAllByTestId("explorer-project");
    fireEvent.click(within(projects[0]).getByTestId("select-diagram-button"));
    fireEvent.click(within(projects[1]).getByTestId("project-add-button"));
    fireEvent.click(screen.getByTestId("context-menu-new-diagram"));

    await waitFor(() => {
      expect(diagramsInProject(1)).toHaveLength(1);
    });
    // Default keeps exactly its own file: nothing is duplicated across headers.
    expect(diagramsInProject(0)).toHaveLength(1);
  });

  it("deletes a file from its own project without disturbing the other one", async () => {
    render(<App />);
    await createProject("Default");
    fireEvent.click(screen.getByTestId("project-add-button"));
    fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    await waitFor(() => {
      expect(diagramsInProject(0)).toHaveLength(1);
    });

    await createSecondProject("Project2");
    fireEvent.click(
      within(screen.getAllByTestId("explorer-project")[1]).getByTestId(
        "project-add-button",
      ),
    );
    fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    await waitFor(() => {
      expect(diagramsInProject(1)).toHaveLength(1);
    });

    // Delete Default's (non-selected) only file from its row menu.
    fireEvent.click(
      within(screen.getAllByTestId("explorer-project")[0]).getByTestId(
        "diagram-menu-button",
      ),
    );
    fireEvent.click(screen.getByTestId("context-menu-delete"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });

    await waitFor(() => {
      expect(diagramsInProject(0)).toHaveLength(0);
    });
    // Project2's file survives, and Default's header is still expanded.
    expect(diagramsInProject(1)).toHaveLength(1);
    expect(screen.getAllByTestId("project-collapse-button")[0]).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("collapses and expands every project from the command shortcuts", async () => {
    render(<App />);
    await createProject("Notes");

    // Ctrl/Cmd+Alt+C — "Collapse All Projects".
    fireEvent.keyDown(document, { key: "c", ctrlKey: true, altKey: true });
    expect(screen.queryByTestId("explorer-diagrams")).toBeNull();

    // Ctrl/Cmd+Alt+Shift+C — "Expand All Projects".
    fireEvent.keyDown(document, {
      key: "c",
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(screen.getByTestId("explorer-diagrams")).toBeInTheDocument();
  });
});

describe("App — command shortcuts", () => {
  it("shows the palette shortcut on the toolbar button", () => {
    render(<App />);
    expect(screen.getByTestId("palette-hint")).toHaveTextContent(
      "Ctrl+Shift+P",
    );
  });

  it("lists a shortcut beside every command in the palette", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("command-palette-button"));

    const shortcuts = screen
      .getAllByTestId("palette-shortcut")
      .map((node) => node.textContent);
    expect(shortcuts).toContain("Ctrl+Alt+N");
    expect(shortcuts).toContain("F2");
    expect(screen.getByTestId("palette-open-hint")).toHaveTextContent(
      "Ctrl+Shift+P",
    );
  });

  it("runs a command from its own shortcut without opening the palette", async () => {
    render(<App />);
    await createProject("Notes");

    // Ctrl/Cmd+Alt+N is "New Diagram"; it must create a file and open its tab.
    await act(async () => {
      fireEvent.keyDown(document, { key: "n", ctrlKey: true, altKey: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId("explorer-diagram")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });
});

describe("App — project history tree", () => {
  /** Add a diagram through the project's ＋ menu with the given source. */
  async function addDiagram(source: string): Promise<void> {
    fireEvent.click(screen.getByTestId("project-add-button"));
    fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: source },
    });
  }

  /** The history branch whose header names `title`. */
  function branchNamed(title: string): HTMLElement {
    const branch = screen
      .getAllByTestId("history-branch")
      .find((element) => element.textContent?.includes(title));
    if (!branch) throw new Error(`No history branch for ${title}`);
    return branch;
  }

  it("shows one branch per diagram, each with its own versions", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram("title Alpha\nA -> B: one");
    await addDiagram("title Beta\nA -> B: two");

    fireEvent.click(screen.getByTestId("view-history"));
    await waitFor(() => {
      expect(screen.getAllByTestId("history-branch")).toHaveLength(2);
    });

    // Each branch is named for its diagram, and every version row says which
    // diagram it belongs to.
    const names = screen
      .getAllByTestId("history-branch-name")
      .map((node) => node.textContent);
    expect(names).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    const rows = screen.getAllByTestId("history-version");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.getAttribute("data-diagram-id")).toBeTruthy();
    }
    // Exactly one branch — the open diagram — is marked.
    expect(screen.getAllByTestId("history-branch-open")).toHaveLength(1);
  });

  it("restores a version from another diagram by opening that diagram", async () => {
    render(<App />);
    await createProject("Docs");
    await addDiagram("title Alpha\nA -> B: one");
    // Capture Alpha's content explicitly so its branch is deterministic.
    fireEvent.click(screen.getByTestId("view-history"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-version-button"));
    });
    fireEvent.click(screen.getByTestId("view-code"));

    await addDiagram("title Beta\nA -> B: two");

    // Restore Alpha's version while Beta is the open diagram.
    fireEvent.click(screen.getByTestId("view-history"));
    await waitFor(() => {
      expect(screen.getAllByTestId("history-branch")).toHaveLength(2);
    });
    const alpha = branchNamed("Alpha");
    await act(async () => {
      fireEvent.click(
        within(alpha).getAllByTestId("restore-version-button")[0],
      );
    });

    // The editor switched to Alpha and shows the restored content.
    fireEvent.click(screen.getByTestId("view-code"));
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toHaveValue(
        "title Alpha\nA -> B: one",
      );
    });
  });
});
