import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "../../../src/App";

/** Read the diagram text currently shown in the preview. */
function previewText(): string {
  return screen.getByTestId("preview-svg").textContent ?? "";
}

describe("App — editor views", () => {
  it("shows the code editor by default", () => {
    render(<App />);
    expect(screen.getByTestId("dsl-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("docs-page")).toBeNull();
  });

  it("opens the documentation as its own page and returns to the workspace", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("open-docs"));
    expect(screen.getByTestId("docs-page")).toBeInTheDocument();
    expect(screen.getByTestId("dsl-reference")).toBeInTheDocument();
    // The page replaces the workspace rather than sharing the editor pane.
    expect(screen.queryByTestId("dsl-editor")).toBeNull();

    fireEvent.click(screen.getByTestId("docs-back"));
    expect(screen.getByTestId("dsl-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("docs-page")).toBeNull();
  });

  it("keeps documentation out of the editor view tabs", () => {
    render(<App />);
    expect(screen.getByTestId("view-code")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Docs is a page, not a panel between Overview and History.
    expect(screen.queryByTestId("view-docs")).toBeNull();
    expect(screen.getByTestId("view-overview")).toBeInTheDocument();
    expect(screen.getByTestId("view-history")).toBeInTheDocument();
  });
});

describe("App — auto-update", () => {
  it("is on by default, so edits reach the preview immediately", () => {
    render(<App />);
    expect(screen.getByTestId("auto-update-toggle")).toBeChecked();
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant Widget\nWidget -> Widget: hi" },
    });
    expect(previewText()).toContain("Widget");
  });

  it("freezes the preview while paused", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("auto-update-toggle"));

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant Widget\nWidget -> Widget: hi" },
    });

    // The canvas still shows the diagram rendered before the pause.
    expect(previewText()).toContain("Login");
    expect(previewText()).not.toContain("Widget");
    expect(screen.getByTestId("preview-paused")).toBeInTheDocument();
    expect(screen.getByText("Source changed")).toBeInTheDocument();
  });

  it("catches up when the user renders", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("auto-update-toggle"));
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant Widget\nWidget -> Widget: hi" },
    });

    fireEvent.click(screen.getByTestId("render-button"));
    expect(previewText()).toContain("Widget");
    expect(previewText()).not.toContain("Login");
  });

  it("disables the render button when there is nothing to render", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("auto-update-toggle"));
    expect(screen.getByTestId("render-button")).toBeDisabled();
  });

  it("resumes syncing when auto-update is switched back on", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("auto-update-toggle"));
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant Widget\nWidget -> Widget: hi" },
    });
    expect(previewText()).not.toContain("Widget");

    fireEvent.click(screen.getByTestId("auto-update-toggle"));
    expect(previewText()).toContain("Widget");
  });
});

describe("App — status bar", () => {
  it("reports participant and message counts from the analysis", () => {
    render(<App />);
    // The seeded sample has three participants and four messages.
    expect(screen.getByTestId("status-participants").textContent).toBe(
      "3 participants",
    );
    expect(screen.getByTestId("status-messages").textContent).toBe(
      "4 messages",
    );
    expect(screen.getByTestId("status-diagnostics").textContent).toBe(
      "No problems",
    );
  });

  it("counts problems as the source becomes invalid", () => {
    render(<App />);
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant A\ndeactivate A" },
    });
    expect(screen.getByTestId("status-diagnostics").textContent).toBe(
      "1 problem",
    );
  });

  it("shows singular labels for a one-participant diagram", () => {
    render(<App />);
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant Solo" },
    });
    expect(screen.getByTestId("status-participants").textContent).toBe(
      "1 participant",
    );
    expect(screen.getByTestId("status-messages").textContent).toBe(
      "0 messages",
    );
  });
});
