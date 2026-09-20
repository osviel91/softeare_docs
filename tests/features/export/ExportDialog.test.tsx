import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ExportDialog, {
  type ExportDialogProps,
} from "../../../src/features/export/ExportDialog";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#ffffff"/></svg>';

/** Render the dialog with spies, overriding individual props per test. */
function setup(overrides: Partial<ExportDialogProps> = {}) {
  const onClose = vi.fn();
  const onExport = vi.fn();
  render(
    <ExportDialog
      svg={SVG}
      width={200}
      height={100}
      name="checkout-flow"
      onClose={onClose}
      onExport={onExport}
      {...overrides}
    />,
  );
  return { onClose, onExport };
}

describe("ExportDialog", () => {
  it("renders a modal preview of the current SVG", () => {
    setup();
    const dialog = screen.getByTestId("export-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const preview = screen.getByTestId("export-preview") as HTMLImageElement;
    expect(preview.getAttribute("src")).toContain("data:image/svg+xml");
    expect(preview.getAttribute("src")).toContain(encodeURIComponent("<rect"));
  });

  it("calls nothing on mount", () => {
    const { onClose, onExport } = setup();
    expect(onClose).not.toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
  });

  it("defaults to the SVG format and the document name", () => {
    setup();
    expect(screen.getByTestId("export-format-svg")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("export-theme-light")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("export-file-name")).toHaveTextContent(
      "checkout-flow.svg",
    );
  });

  it("hands the chosen format, theme and options to the confirm handler", () => {
    const { onExport } = setup();

    fireEvent.click(screen.getByTestId("export-format-png"));
    fireEvent.click(screen.getByTestId("export-theme-dark"));
    fireEvent.change(screen.getByTestId("export-background"), {
      target: { value: "transparent" },
    });
    fireEvent.change(screen.getByTestId("export-scale"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByTestId("export-padding"), {
      target: { value: "16" },
    });
    // Checked by default; one click turns the title off.
    fireEvent.click(screen.getByTestId("export-include-title"));
    fireEvent.click(screen.getByTestId("export-confirm"));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledWith({
      format: "png",
      theme: "dark",
      background: "transparent",
      scale: 3,
      padding: 16,
      includeTitle: false,
      title: "checkout-flow",
    });
  });

  it("accepts a custom CSS colour for the background", () => {
    const { onExport } = setup();
    fireEvent.change(screen.getByTestId("export-background"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByTestId("export-background-custom"), {
      target: { value: "#102030" },
    });
    fireEvent.click(screen.getByTestId("export-confirm"));

    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({ background: "#102030" }),
    );
  });

  it("tracks the file name as the format changes", () => {
    setup();
    fireEvent.click(screen.getByTestId("export-format-pdf"));
    expect(screen.getByTestId("export-file-name")).toHaveTextContent(
      "checkout-flow.pdf",
    );
  });

  it("closes on cancel", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByTestId("export-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByTestId("export-confirm"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked", () => {
    const { onClose } = setup();
    fireEvent.mouseDown(screen.getByTestId("export-overlay"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the panel itself is clicked", () => {
    const { onClose } = setup();
    fireEvent.mouseDown(screen.getByTestId("export-dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes after a confirmed export", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByTestId("export-confirm"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("accepts onConfirm as the alias for onExport", () => {
    const onConfirm = vi.fn();
    render(
      <ExportDialog
        svg={SVG}
        width={200}
        height={100}
        name="checkout-flow"
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("export-format-pdf"));
    fireEvent.click(screen.getByTestId("export-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ format: "pdf" }),
    );
  });
});
