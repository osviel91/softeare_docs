import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PromptDialog from "../../../src/features/ui/PromptDialog";

describe("PromptDialog", () => {
  it("pre-fills and focuses the input", () => {
    render(
      <PromptDialog
        title="Rename diagram"
        label="File name"
        initialValue="welcome.seq"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByTestId("prompt-dialog-input");
    expect(input).toHaveValue("welcome.seq");
    expect(input).toHaveFocus();
  });

  it("submits the trimmed value from the form", () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        title="Rename"
        label="File name"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
      target: { value: "  start.seq  " },
    });
    fireEvent.click(screen.getByTestId("prompt-dialog-confirm"));
    expect(onConfirm).toHaveBeenCalledWith("start.seq");
  });

  it("refuses an empty value", () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        title="Rename"
        label="File name"
        initialValue="a.seq"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("prompt-dialog-input"), {
      target: { value: "   " },
    });
    expect(screen.getByTestId("prompt-dialog-confirm")).toBeDisabled();
    fireEvent.submit(screen.getByTestId("prompt-dialog"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels from the button, Escape, and the backdrop", () => {
    const onCancel = vi.fn();
    render(
      <PromptDialog
        title="Rename"
        label="File name"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("prompt-dialog-cancel"));
    fireEvent.keyDown(screen.getByTestId("prompt-dialog"), { key: "Escape" });
    fireEvent.mouseDown(screen.getByTestId("prompt-dialog-overlay"));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});
