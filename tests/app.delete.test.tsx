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
 * In-browser projects (no folder open). jsdom has no IndexedDB, so the app uses
 * its in-memory fallback: projects live for the life of the render, which is all
 * these tests need.
 */
describe("App — safe delete for in-browser projects", () => {
  it("confirms before deleting a project, with no disk option", async () => {
    render(<App />);

    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Notes" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Notes");
    });

    fireEvent.click(screen.getByTestId("project-menu-button"));
    fireEvent.click(screen.getByTestId("context-menu-delete-project"));
    expect(screen.getByTestId("confirm-dialog")).toHaveTextContent(
      "Delete project",
    );
    // There is no separate disk copy, so only the permanent action is offered.
    expect(screen.queryByTestId("confirm-dialog-alternative")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("project-name")).toBeNull();
    });
  });

  it("leaves the workspace untouched when the dialog is cancelled", async () => {
    render(<App />);

    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Keep me" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Keep me");
    });

    fireEvent.click(screen.getByTestId("project-menu-button"));
    fireEvent.click(screen.getByTestId("context-menu-delete-project"));
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(screen.getByTestId("project-name")).toHaveTextContent("Keep me");
  });
});
