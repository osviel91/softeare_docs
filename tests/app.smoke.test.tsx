import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "./app-harness";

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

  it("shows the diagram's step numbers beside the matching source lines", () => {
    render(<App />);
    // The sample diagram has four messages, numbered 1..4 in source order.
    const badges = screen.getAllByTestId("editor-step");
    expect(badges.map((badge) => badge.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    // The canvas prints the same numbers, so a line and its arrow can be
    // matched by the number alone.
    const printed = [
      ...screen
        .getByTestId("preview-svg")
        .querySelectorAll("[data-sequence-number]"),
    ].map((node) => node.getAttribute("data-sequence-number"));
    expect(printed).toEqual(["1", "2", "3", "4"]);
  });

  it("bolds participants and follows a declaration rename through the source", () => {
    render(<App />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    const highlight = screen.getByTestId("editor-highlight");

    // The seeded sample declares User/API/DB and names them in its messages.
    expect(
      [...highlight.querySelectorAll("strong")].map((el) => el.textContent),
    ).toContain("API");

    const renamed = textarea.value.replace(
      "participant API",
      "participant Gateway",
    );
    fireEvent.change(textarea, { target: { value: renamed } });

    // Every usage followed the declaration, so the diagram cannot collapse into
    // "unknown participant" while the name is being retyped.
    expect(textarea.value).toContain("participant Gateway");
    expect(textarea.value).toContain("User ->> Gateway: Login");
    expect(textarea.value).not.toMatch(/\bAPI\b/);
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
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
    // Numbers the canvas no longer draws are not claimed in the gutter either.
    expect(screen.queryAllByTestId("editor-step")).toEqual([]);
  });
});
