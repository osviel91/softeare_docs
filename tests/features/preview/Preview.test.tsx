import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Preview from "../../../src/features/preview/Preview";

const VALID = `title Login

participant User
participant API

User -> API: Login
`;

const DUPLICATES = `participant A
participant A
A -> A: self
`;

const WITH_NOTES = `participant User
participant API
User -> API: Login
note right of API : Reads from cache
note over User : Owns the session
`;

/** The bullet for a note index inside the injected SVG. */
function bullet(index: number): Element {
  const element = document.querySelector(`[data-note-index="${index}"]`);
  if (!element) throw new Error(`no note bullet at index ${index}`);
  return element;
}

describe("Preview", () => {
  it("selects a bound semantic badge with pointer and keyboard activation", () => {
    const select = vi.fn();
    render(
      <Preview
        source={`participant A\nparticipant B\nA -> B: Created\nsemantic event publish Created messageRef msg-created\n`}
        onSemanticMessageSelect={select}
      />,
    );
    const badge = screen.getByText("EVENT · publish");
    fireEvent.click(badge);
    fireEvent.keyDown(badge, { key: "Enter" });
    expect(select).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledWith("msg-created", expect.any(String));
  });

  it("renders the diagram svg when the source is valid", () => {
    render(<Preview source={VALID} />);
    const svg = screen.getByTestId("preview-svg");
    expect(svg).toBeInTheDocument();
    // The participant label flows through the pipeline into the DOM.
    expect(screen.getByText("User")).toBeInTheDocument();
  });

  it("shows an empty-state hint when the source is invalid", () => {
    render(<Preview source={DUPLICATES} />);
    expect(screen.getByTestId("preview-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-svg")).toBeNull();
  });

  it("reports the issue count in the empty-state hint", () => {
    render(<Preview source={DUPLICATES} />);
    // The hint splits across multiple text nodes, so assert on the element's
    // concatenated text content rather than a getByText regex.
    expect(screen.getByTestId("preview-empty").textContent).toMatch(
      /Fix 1 issue/,
    );
  });
});

describe("Preview — notes as bullets", () => {
  it("attaches a collapsed bullet to each note's element", () => {
    render(<Preview source={WITH_NOTES} />);
    // A bullet per note, and no callout text until one is expanded.
    expect(bullet(0)).toBeInTheDocument();
    expect(bullet(1)).toBeInTheDocument();
    expect(screen.queryByText("Reads from cache")).toBeNull();
    expect(screen.getByTestId("preview-notes").textContent).toContain(
      "2 notes",
    );
  });

  it("expands and collapses a note from its bullet", () => {
    render(<Preview source={WITH_NOTES} />);

    fireEvent.click(bullet(0));
    expect(screen.getByText("Reads from cache")).toBeInTheDocument();
    // Only the clicked note expanded.
    expect(screen.queryByText("Owns the session")).toBeNull();

    fireEvent.click(bullet(0));
    expect(screen.queryByText("Reads from cache")).toBeNull();
  });

  it("toggles a bullet from the keyboard", () => {
    render(<Preview source={WITH_NOTES} />);
    fireEvent.keyDown(bullet(1), { key: "Enter" });
    expect(screen.getByText("Owns the session")).toBeInTheDocument();
    fireEvent.keyDown(bullet(1), { key: " " });
    expect(screen.queryByText("Owns the session")).toBeNull();
  });

  it("expands and collapses every note from the toolbar", () => {
    render(<Preview source={WITH_NOTES} />);

    fireEvent.click(screen.getByTestId("expand-notes-button"));
    expect(screen.getByText("Reads from cache")).toBeInTheDocument();
    expect(screen.getByText("Owns the session")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("collapse-notes-button"));
    expect(screen.queryByText("Reads from cache")).toBeNull();
    expect(screen.queryByText("Owns the session")).toBeNull();
  });

  it("hides the notes toolbar when the diagram has no notes", () => {
    render(<Preview source={VALID} />);
    expect(screen.queryByTestId("preview-notes")).toBeNull();
  });

  it("collapses expanded notes when the source changes", () => {
    const { rerender } = render(<Preview source={WITH_NOTES} />);
    fireEvent.click(bullet(0));
    expect(screen.getByText("Reads from cache")).toBeInTheDocument();

    // A different source: note indices can shift, so expansion resets.
    rerender(<Preview source={`${WITH_NOTES}note left of User : Extra\n`} />);
    expect(screen.queryByText("Reads from cache")).toBeNull();
  });
});
