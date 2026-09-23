import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MarkdownEditor from "../../../src/features/notes/MarkdownEditor";
import MarkdownView from "../../../src/features/notes/MarkdownView";

describe("MarkdownEditor", () => {
  it("shows the markdown and reports edits", () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"# One\n\ntext"} onChange={onChange} />);
    const textarea = screen.getByTestId("markdown-textarea");
    expect(textarea).toHaveValue("# One\n\ntext");
    fireEvent.change(textarea, { target: { value: "# Two" } });
    expect(onChange).toHaveBeenCalledWith("# Two");
  });

  it("counts lines", () => {
    render(<MarkdownEditor value={"a\nb\nc"} onChange={vi.fn()} />);
    expect(screen.getByTestId("markdown-line-count")).toHaveTextContent(
      "3 lines",
    );
  });

  it("keeps one visual row per source line", () => {
    render(
      <MarkdownEditor
        value="a very long markdown source line"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("markdown-textarea")).toHaveAttribute(
      "wrap",
      "off",
    );
  });

  it("advertises the diagram link syntax", () => {
    render(<MarkdownEditor value="" onChange={vi.fn()} />);
    expect(screen.getByTestId("markdown-hint")).toHaveTextContent("[[Name]]");
  });
});

describe("MarkdownView", () => {
  it("renders headings, emphasis, and lists", () => {
    render(<MarkdownView markdown={"# Title\n\n- **one**\n- two"} />);
    const body = screen.getByTestId("markdown-body");
    expect(body.querySelector("h1")?.textContent).toBe("Title");
    expect(body.querySelector("strong")?.textContent).toBe("one");
    expect(body.querySelectorAll("li")).toHaveLength(2);
  });

  it("reports a wiki-link activation to the shell", () => {
    const onOpenDiagramLink = vi.fn();
    render(
      <MarkdownView
        markdown="See [[Welcome]]."
        resolveWikiLink={() => "#diagram/1"}
        onOpenDiagramLink={onOpenDiagramLink}
      />,
    );
    fireEvent.click(screen.getByText("Welcome"));
    expect(onOpenDiagramLink).toHaveBeenCalledWith("Welcome");
  });

  it("styles an unresolved link as broken but still reports it", () => {
    const onOpenDiagramLink = vi.fn();
    render(
      <MarkdownView
        markdown="See [[Missing]]."
        resolveWikiLink={() => null}
        onOpenDiagramLink={onOpenDiagramLink}
      />,
    );
    const link = screen.getByText("Missing");
    expect(link).toHaveClass("markdown__link--broken");
    fireEvent.click(link);
    expect(onOpenDiagramLink).toHaveBeenCalledWith("Missing");
  });

  it("ignores clicks that are not on a wiki-link", () => {
    const onOpenDiagramLink = vi.fn();
    render(
      <MarkdownView
        markdown="plain text"
        onOpenDiagramLink={onOpenDiagramLink}
      />,
    );
    fireEvent.click(screen.getByTestId("markdown-body"));
    expect(onOpenDiagramLink).not.toHaveBeenCalled();
  });
});
