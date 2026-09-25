import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./app-harness";
import { readZip } from "../src/workspace/transfer/zip";

// Capture what the shell hands to the browser rather than performing a download.
const transfer = vi.hoisted(() => ({
  downloads: [] as Array<{ filename: string; bytes: Uint8Array }>,
}));

vi.mock("../src/workspace/transfer/download", () => ({
  downloadBytes: (bytes: Uint8Array, filename: string) => {
    transfer.downloads.push({ filename, bytes });
  },
}));

/**
 * Export, driven through the real shell.
 *
 * The bytes are asserted rather than the mechanism: a diagram export must be a
 * real SVG document, and a documentation-site export must be a ZIP that contains
 * the site's pages. That is what "export works" means to a user, and it is what a
 * regression would break.
 */
describe("App — export", () => {
  const SOURCE = [
    "title Checkout",
    "participant Cart",
    "participant Payment",
    "",
    "Cart ->> Payment: Authorize",
  ].join("\n");
  const EVENT_FLOW = [
    "title Order Processing",
    "event OrderCreated",
    "producer OrderService",
    "consumer BillingService",
    "OrderService publishes OrderCreated",
    "BillingService consumes OrderCreated",
  ].join("\n");

  afterEach(() => {
    transfer.downloads.length = 0;
  });

  async function projectWithDiagram(): Promise<void> {
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Payments" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Payments");
    });

    fireEvent.click(screen.getByTestId("project-add-button"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-new-diagram"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: SOURCE },
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
  }

  async function runCommand(label: string): Promise<void> {
    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: label },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });
  }

  it("exports the current Event Flow as a rendered SVG document", async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Payments" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Payments");
    });
    await runCommand("New Event Flow");
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: EVENT_FLOW },
    });

    fireEvent.click(screen.getByTestId("resource-export-action"));
    expect(screen.getByTestId("export-preview")).toHaveAttribute(
      "src",
      expect.stringContaining("Order%20Processing"),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-confirm"));
    });

    await waitFor(() => expect(transfer.downloads).toHaveLength(1));
    const text = new TextDecoder().decode(transfer.downloads[0].bytes);
    expect(text.startsWith("<svg")).toBe(true);
    expect(text).toContain("Order Processing");
    expect(text).toContain("OrderCreated");
  });

  it("exports the current diagram as an SVG document", async () => {
    render(<App />);
    await projectWithDiagram();
    // Back to the diagram so the export targets it, not the note.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("tab")[0]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("resource-export-action"));
    expect(screen.getByTestId("export-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("export-cancel"));

    await runCommand("Export Diagram");
    await waitFor(() => {
      expect(screen.getByTestId("export-dialog")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-confirm"));
    });

    await waitFor(() => {
      expect(transfer.downloads).toHaveLength(1);
    });
    const [download] = transfer.downloads;
    expect(download.filename).toMatch(/\.svg$/);
    const text = new TextDecoder().decode(download.bytes);
    expect(text.startsWith("<svg")).toBe(true);
    expect(text).toContain("Authorize");
    expect(screen.queryByTestId("export-dialog")).toBeNull();
  });

  it("writes the project's documentation as a ZIP of HTML", async () => {
    render(<App />);
    await projectWithDiagram();

    await runCommand("Export Documentation Site");

    await waitFor(() => {
      expect(transfer.downloads).toHaveLength(1);
    });
    const [download] = transfer.downloads;
    expect(download.filename).toBe("Payments-docs.zip");

    const entries = readZip(download.bytes);
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    const paths = entries.value.map((entry) => entry.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("styles/site.css");
    // The project's diagram and document each get a page, and the diagram is
    // also written as a standalone SVG.
    expect(paths.some((path) => path.startsWith("diagrams/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("docs/"))).toBe(true);

    const indexHtml = new TextDecoder().decode(
      entries.value.find((entry) => entry.path === "index.html")!.data,
    );
    expect(indexHtml).toContain("<html");
    expect(indexHtml).toContain("Payments");
  });

  it("exports the project chosen from its ⋯ menu", async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "First" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("First");
    });
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Second" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getAllByTestId("explorer-project")).toHaveLength(2);
    });

    fireEvent.click(
      within(screen.getAllByTestId("explorer-project")[0]).getByTestId(
        "project-menu-button",
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-menu-download-project"));
    });

    await waitFor(() => {
      expect(transfer.downloads).toHaveLength(1);
    });
    expect(transfer.downloads[0].filename).toBe("First.zip");
  });

  it("reports a site export attempted with no project selected", async () => {
    render(<App />);
    await runCommand("Export Documentation Site");
    expect(transfer.downloads).toHaveLength(0);
    expect(screen.getByTestId("transfer-error")).toHaveTextContent(
      "Open a project",
    );
  });
});
