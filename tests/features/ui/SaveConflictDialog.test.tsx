/**
 * The save-conflict dialog (Phase 4A).
 *
 * The dialog's whole job is to make a `409` a decision rather than a loss, so the
 * tests here are about the three outcomes being reachable and the safe one being
 * the default: focus starts on *Reload*, and every action reports intent without
 * the dialog deciding anything itself.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SaveConflictDialog from "../../../src/features/ui/SaveConflictDialog";

/** Render the dialog with sensible handlers. */
function renderDialog(
  overrides: Partial<React.ComponentProps<typeof SaveConflictDialog>> = {},
) {
  const handlers = {
    onReload: vi.fn(),
    onKeepMine: vi.fn(),
    onCopyMine: vi.fn(),
    onCancel: vi.fn(),
  };
  render(
    <SaveConflictDialog
      documentName="checkout.seq"
      message="The resource changed since it was read."
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("SaveConflictDialog", () => {
  it("says what happened and which document is at risk", () => {
    renderDialog();
    expect(screen.getByTestId("save-conflict-dialog")).toHaveTextContent(
      "This document has changed on the server",
    );
    expect(screen.getByTestId("save-conflict-document")).toHaveTextContent(
      "checkout.seq",
    );
  });

  it("offers every honest outcome", () => {
    renderDialog();
    expect(screen.getByTestId("save-conflict-reload")).toBeInTheDocument();
    expect(screen.getByTestId("save-conflict-keep")).toBeInTheDocument();
    expect(screen.getByTestId("save-conflict-copy")).toBeInTheDocument();
    expect(screen.getByTestId("save-conflict-cancel")).toBeInTheDocument();
  });

  it("starts focus on the safe action, not the overwrite", () => {
    renderDialog();
    // A keyboard user pressing Enter should reload, never replace a colleague's
    // work by default.
    expect(screen.getByTestId("save-conflict-reload")).toHaveFocus();
  });

  it("reports each choice without acting on it", () => {
    const handlers = renderDialog();
    fireEvent.click(screen.getByTestId("save-conflict-reload"));
    fireEvent.click(screen.getByTestId("save-conflict-keep"));
    fireEvent.click(screen.getByTestId("save-conflict-copy"));
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
    expect(handlers.onKeepMine).toHaveBeenCalledTimes(1);
    expect(handlers.onCopyMine).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it("confirms that the buffer was copied", () => {
    renderDialog({ copied: true });
    expect(screen.getByTestId("save-conflict-copy")).toHaveTextContent(
      "Copied",
    );
  });

  it("cancels on Escape and on a backdrop press, keeping the buffer", () => {
    const handlers = renderDialog();
    fireEvent.keyDown(screen.getByTestId("save-conflict-dialog"), {
      key: "Escape",
    });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId("save-conflict-overlay"));
    expect(handlers.onCancel).toHaveBeenCalledTimes(2);
    // Cancelling never writes and never reloads.
    expect(handlers.onKeepMine).not.toHaveBeenCalled();
    expect(handlers.onReload).not.toHaveBeenCalled();
  });
});
