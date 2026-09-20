import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ConfirmDialog from "../../../src/features/ui/ConfirmDialog";

describe("ConfirmDialog", () => {
  it("presents the action, its consequence, and its buttons", () => {
    render(
      <ConfirmDialog
        title="Delete diagram “Welcome”?"
        message="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    expect(screen.getByText("Delete diagram “Welcome”?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-dialog-confirm")).toHaveTextContent(
      "Delete",
    );
  });

  it("calls onConfirm when the destructive action is chosen", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        message="message"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel from the cancel button, Escape, and the backdrop", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        message="message"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    fireEvent.keyDown(screen.getByTestId("confirm-dialog"), { key: "Escape" });
    fireEvent.mouseDown(screen.getByTestId("confirm-dialog-overlay"));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("offers the non-destructive alternative when supplied", () => {
    const onAlternative = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        message="message"
        confirmLabel="Delete from disk"
        alternativeLabel="Remove from app"
        onAlternative={onAlternative}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-dialog-alternative"));
    expect(onAlternative).toHaveBeenCalledTimes(1);
  });

  it("omits the alternative when only a label is supplied", () => {
    render(
      <ConfirmDialog
        title="Delete?"
        message="message"
        confirmLabel="Delete"
        alternativeLabel="Remove from app"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("confirm-dialog-alternative")).toBeNull();
  });

  it("focuses the destructive action so keyboard users can act directly", () => {
    render(
      <ConfirmDialog
        title="Delete?"
        message="message"
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("confirm-dialog-confirm")).toHaveFocus();
  });
});
