import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import Editor from "../../../src/features/editor/Editor";
import {
  DiagnosticCode,
  type Diagnostic,
} from "../../../src/language/diagnostics/diagnostics";

describe("Editor", () => {
  it("renders a controlled textarea with the given value", () => {
    render(<Editor value="participant A" onChange={vi.fn()} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe("participant A");
  });

  it("reports edits through onChange", () => {
    const onChange = vi.fn();
    render(<Editor value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "participant B" },
    });
    expect(onChange).toHaveBeenCalledWith("participant B");
  });

  it("shows a clean-state hint when there are no diagnostics", () => {
    render(<Editor value="participant A\nA -> B: hi" onChange={vi.fn()} />);
    expect(screen.getByText("No problems detected.")).toBeInTheDocument();
    expect(screen.queryByTestId("dsl-diagnostics")).toBeNull();
  });

  it("lists diagnostics with their severity", () => {
    const diagnostics: Diagnostic[] = [
      {
        severity: "error",
        message: 'Unknown participant "Z"',
        code: DiagnosticCode.UnknownParticipant,
      },
    ];
    render(
      <Editor
        value="A -> Z: hi"
        onChange={vi.fn()}
        diagnostics={diagnostics}
      />,
    );
    const list = screen.getByTestId("dsl-diagnostics");
    expect(list).toBeInTheDocument();
    expect(screen.getByText('Unknown participant "Z"')).toBeInTheDocument();
  });
});

describe("Editor — line numbers", () => {
  it("shows one line number per source line", () => {
    render(
      <Editor
        value={"participant A\nparticipant B\nA -> B: hi"}
        onChange={vi.fn()}
      />,
    );
    const gutter = screen.getByTestId("editor-gutter");
    expect(gutter.querySelectorAll(".editor__line-number")).toHaveLength(3);
    expect(gutter.textContent).toBe("123");
  });

  it("grows the gutter as lines are added", () => {
    const { rerender } = render(<Editor value="a" onChange={vi.fn()} />);
    expect(
      screen
        .getByTestId("editor-gutter")
        .querySelectorAll(".editor__line-number"),
    ).toHaveLength(1);
    rerender(<Editor value={"a\nb\nc"} onChange={vi.fn()} />);
    expect(
      screen
        .getByTestId("editor-gutter")
        .querySelectorAll(".editor__line-number"),
    ).toHaveLength(3);
  });

  it("counts a trailing newline as its own line", () => {
    render(<Editor value={"a\n"} onChange={vi.fn()} />);
    expect(
      screen
        .getByTestId("editor-gutter")
        .querySelectorAll(".editor__line-number"),
    ).toHaveLength(2);
  });

  it("hides the gutter from assistive technology", () => {
    render(<Editor value="a" onChange={vi.fn()} />);
    expect(screen.getByTestId("editor-gutter")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

describe("Editor — snippets", () => {
  it("keeps the menu closed until asked", () => {
    render(<Editor value="" onChange={vi.fn()} />);
    expect(screen.queryByTestId("snippets-menu")).toBeNull();
    fireEvent.click(screen.getByTestId("snippets-button"));
    expect(screen.getByTestId("snippets-menu")).toBeInTheDocument();
  });

  it("inserts a snippet at the caret and closes the menu", () => {
    const onChange = vi.fn();
    render(<Editor value="title Flow" onChange={onChange} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    // Caret at the end of the existing text.
    textarea.setSelectionRange(10, 10);
    fireEvent.click(screen.getByTestId("snippets-button"));
    fireEvent.click(screen.getAllByTestId("snippet-item")[0]);
    // A newline is added first so the fragment starts on its own line.
    expect(onChange).toHaveBeenCalledWith(
      "title Flow\nparticipant User\nparticipant API",
    );
    expect(screen.queryByTestId("snippets-menu")).toBeNull();
  });

  it("does not add a leading newline on an empty document", () => {
    const onChange = vi.fn();
    render(<Editor value="" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("snippets-button"));
    fireEvent.click(screen.getAllByTestId("snippet-item")[1]);
    expect(onChange).toHaveBeenCalledWith("alias U = User");
  });

  it("replaces the current selection", () => {
    const onChange = vi.fn();
    render(<Editor value="keep me" onChange={onChange} />);
    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    textarea.setSelectionRange(5, 7); // select "me"
    fireEvent.click(screen.getByTestId("snippets-button"));
    fireEvent.click(screen.getAllByTestId("snippet-item")[1]);
    expect(onChange).toHaveBeenCalledWith("keep \nalias U = User");
  });

  it("offers a snippet for every DSL construct", () => {
    render(<Editor value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("snippets-button"));
    const labels = screen
      .getAllByTestId("snippet-item")
      .map((item) => item.textContent);
    expect(labels.length).toBeGreaterThanOrEqual(6);
    expect(labels.join(" ")).toMatch(/Activation/);
    expect(labels.join(" ")).toMatch(/Note/);
    expect(labels.join(" ")).toMatch(/Alias/);
  });
});
