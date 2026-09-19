import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "../src/App";

describe("App shell", () => {
  it("renders the product name in the toolbar", () => {
    render(<App />);
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getAllByText("SequenceDiagrams Manager").length).toBe(2);
  });

  it("renders the three workspace panes", () => {
    render(<App />);
    expect(screen.getByLabelText("Project explorer")).toBeInTheDocument();
    expect(screen.getByLabelText("DSL editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Diagram preview")).toBeInTheDocument();
  });

  it("seeds the editor with a valid sample and previews it", () => {
    render(<App />);
    // The sample source has a title and participants; the preview should show them.
    // Assert on the container's concatenated text content: a label like "Login"
    // can appear more than once (title + message), so getByText would be ambiguous.
    const svg = screen.getByTestId("preview-svg");
    expect(svg.textContent).toContain("Login");
    expect(svg.textContent).toContain("User");
  });

  it("updates the preview when the editor text changes", () => {
    render(<App />);
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant Widget\nWidget -> Widget: hi" },
    });
    const svg = screen.getByTestId("preview-svg");
    expect(svg.textContent).toContain("Widget");
    expect(svg.textContent).not.toContain("Login");
  });

  it("blanks the preview and shows a hint when the editor becomes invalid", () => {
    render(<App />);
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant A\nparticipant A\nA -> A: self" },
    });
    expect(screen.getByTestId("preview-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-svg")).toBeNull();
  });
});
