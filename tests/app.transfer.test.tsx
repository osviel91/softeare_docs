import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../src/domain/workspace/types";
import {
  exportProjectToZip,
  importProjectFromZip,
} from "../src/workspace/transfer/project-archive";

// Capture what the export hands to the browser: the tests assert on the bytes,
// not on the download the browser would perform.
const transfer = vi.hoisted(() => ({
  downloads: [] as Array<{ filename: string; bytes: Uint8Array }>,
}));

vi.mock("../src/workspace/transfer/download", () => ({
  downloadBytes: (bytes: Uint8Array, filename: string) => {
    transfer.downloads.push({ filename, bytes });
  },
}));

/** An ArrayBuffer holding exactly the view's bytes, for building a `File`. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** A one-project archive to import. */
function fixtureArchive(): Uint8Array {
  const project: Project = {
    id: "remote",
    name: "Remote Service",
    datasetIds: ["d1"],
    noteIds: ["n1"],
  };
  const diagrams: DiagramFile[] = [
    {
      id: "d1",
      name: "request-flow.seq",
      projectId: "remote",
      source: "title Request Flow\nClient -> API: GET /orders",
    },
  ];
  const notes: NoteFile[] = [
    {
      id: "n1",
      name: "overview.md",
      projectId: "remote",
      markdown: "# Overview\n\nImported prose.",
    },
  ];
  return exportProjectToZip(project, diagrams, notes);
}

describe("App — project export and import", () => {
  afterEach(() => {
    transfer.downloads.length = 0;
  });

  async function createProject(name: string): Promise<void> {
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: name },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent(name);
    });
  }

  async function runProjectCommand(label: string): Promise<void> {
    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: label },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });
  }

  /** Feed a `.zip` to the hidden import input. */
  async function chooseArchive(bytes: Uint8Array, name = "project.zip") {
    const input = screen.getByTestId("import-file-input") as HTMLInputElement;
    const file = new File([bufferOf(bytes)], name, {
      type: "application/zip",
    });
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      fireEvent.change(input);
    });
  }

  it("exports the selected project as a portable ZIP", async () => {
    render(<App />);
    await createProject("Payments Service");

    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "title Checkout\nClient -> API: POST /payments" },
    });

    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-note"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("markdown-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("markdown-textarea"), {
      target: { value: "# Architecture\n\nProse." },
    });

    await runProjectCommand("Export Project");

    expect(transfer.downloads).toHaveLength(1);
    expect(transfer.downloads[0].filename).toBe("Payments-Service.zip");

    // What was handed to the browser is a real archive of this project.
    const parsed = importProjectFromZip(transfer.downloads[0].bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Payments Service");
    expect(parsed.value.notes).toEqual([
      { name: "Untitled.md", markdown: "# Architecture\n\nProse." },
    ]);
    expect(parsed.value.diagrams).toHaveLength(1);
    expect(parsed.value.diagrams[0].source).toContain("POST /payments");
  });

  it("asks for a file when Import Project is run", async () => {
    render(<App />);
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {
        /* the picker itself is the browser's job */
      });

    await runProjectCommand("Import Project");

    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("imports an archive as a new project in the explorer", async () => {
    render(<App />);
    await chooseArchive(fixtureArchive());

    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent(
        "Remote Service",
      );
    });
    // The imported project's files land in the explorer, and the first document
    // is loaded so the import is immediately visible.
    expect(screen.getByTestId("explorer-diagram")).toHaveTextContent(
      "Request Flow",
    );
    expect(screen.getByTestId("explorer-note")).toHaveTextContent("Overview");
    expect(screen.getByTestId("dsl-textarea")).toHaveValue(
      "title Request Flow\nClient -> API: GET /orders",
    );
  });

  it("keeps existing projects when importing", async () => {
    render(<App />);
    await createProject("Local");
    await chooseArchive(fixtureArchive());

    await waitFor(() => {
      expect(screen.getAllByTestId("project-name")).toHaveLength(2);
    });
    const names = screen
      .getAllByTestId("project-name")
      .map((element) => element.textContent);
    expect(names).toContain("Local");
    expect(names).toContain("Remote Service");
  });

  /**
   * Regression: the imported project's files must land under *its* header even
   * when another project in the same workspace already has files. The E2E check
   * that caught this counted the explorer's file rows workspace-wide, so an
   * imported project could look as though it had lost its files whenever any
   * other project had one. Scoping the assertion to the imported row is the
   * point of this test.
   */
  it("attaches the imported files to the imported project alone", async () => {
    render(<App />);
    await createProject("Local");
    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });

    await chooseArchive(fixtureArchive());
    await waitFor(() => {
      expect(screen.getAllByTestId("explorer-project")).toHaveLength(2);
    });

    /** The `<li>` for a project, so its rows can be counted in isolation. */
    const rowOf = (name: string): HTMLElement => {
      const row = screen
        .getAllByTestId("explorer-project")
        .find((element) => element.textContent?.includes(name));
      if (!row) throw new Error(`No explorer row for ${name}`);
      return row;
    };

    const imported = within(rowOf("Remote Service"));
    expect(imported.getAllByTestId("explorer-diagram")).toHaveLength(1);
    expect(imported.getAllByTestId("explorer-note")).toHaveLength(1);

    // The project that was already here still owns its own file.
    const local = within(rowOf("Local"));
    expect(local.getAllByTestId("explorer-diagram")).toHaveLength(1);
    expect(local.queryAllByTestId("explorer-note")).toHaveLength(0);
  });

  it("reports a file that is not a project archive", async () => {
    render(<App />);
    await chooseArchive(
      new TextEncoder().encode("this is not a zip file at all"),
      "notes.txt",
    );

    await waitFor(() => {
      expect(screen.getByTestId("transfer-error")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("project-name")).toBeNull();
  });

  it("reports an export attempted with no project selected", async () => {
    render(<App />);
    await runProjectCommand("Export Project");

    expect(transfer.downloads).toHaveLength(0);
    expect(screen.getByTestId("transfer-error")).toHaveTextContent(
      "Select a project",
    );
  });
});
