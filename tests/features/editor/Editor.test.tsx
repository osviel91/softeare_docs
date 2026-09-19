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
