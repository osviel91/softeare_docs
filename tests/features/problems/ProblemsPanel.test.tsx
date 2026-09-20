import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ProjectDiagnostic } from "../../../src/domain/project/project-index";
import ProblemsPanel from "../../../src/features/problems/ProblemsPanel";

/** A diagnostic, with the fields a test does not care about defaulted. */
function problem(
  overrides: Partial<ProjectDiagnostic> = {},
): ProjectDiagnostic {
  return {
    severity: "error",
    message: "Something is wrong",
    resourceId: "diagram-checkout",
    ...overrides,
  };
}

/** The heading text of every severity group, in document order. */
function headings(): string[] {
  return screen
    .getAllByTestId("problems-group")
    .map((group) => group.querySelector("h3")?.textContent ?? "");
}

describe("ProblemsPanel", () => {
  it("groups every severity in most-severe-first order, with counts", () => {
    render(
      <ProblemsPanel
        diagnostics={[
          problem({ severity: "info", message: "Note this" }),
          problem({ severity: "error", message: "Broken" }),
          problem({ severity: "error", message: "Also broken" }),
        ]}
        onOpen={vi.fn()}
      />,
    );

    expect(headings()).toEqual(["Errors (2)", "Warnings (0)", "Info (1)"]);
    expect(
      screen
        .getAllByTestId("problems-group")
        .map((group) => group.getAttribute("data-severity")),
    ).toEqual(["error", "warning", "info"]);
  });

  it("shows each row under its own severity", () => {
    render(
      <ProblemsPanel
        diagnostics={[
          problem({ severity: "warning", message: "Risky" }),
          problem({ severity: "info", message: "FYI" }),
        ]}
        onOpen={vi.fn()}
      />,
    );

    const groups = screen.getAllByTestId("problems-group");
    expect(within(groups[0]).queryAllByTestId("problem-item")).toHaveLength(0);
    expect(within(groups[1]).getAllByTestId("problem-item")).toHaveLength(1);
    expect(within(groups[2]).getAllByTestId("problem-item")).toHaveLength(1);
    expect(screen.getAllByTestId("problem-item")[0]).toHaveAttribute(
      "data-severity",
      "warning",
    );
  });

  it("shows the message and `name:line` for a ranged diagnostic", () => {
    const diagnostic = problem({
      message: "Unknown participant DB",
      sourceRange: {
        start: { line: 4, column: 2 },
        end: { line: 4, column: 8 },
      },
    });
    render(
      <ProblemsPanel
        diagnostics={[diagnostic]}
        onOpen={vi.fn()}
        labelFor={(id) => (id === "diagram-checkout" ? "checkout.seq" : id)}
      />,
    );

    const item = screen.getByTestId("problem-item");
    expect(item).toHaveTextContent("Unknown participant DB");
    expect(item).toHaveTextContent("checkout.seq:5");
  });

  it("omits the line and falls back to the resource id without a range or labelFor", () => {
    render(
      <ProblemsPanel
        diagnostics={[problem({ message: "No file" })]}
        onOpen={vi.fn()}
      />,
    );

    const item = screen.getByTestId("problem-item");
    expect(item).toHaveTextContent("diagram-checkout");
    expect(item).not.toHaveTextContent("diagram-checkout:");
  });

  it("opens the exact diagnostic that was clicked", () => {
    const onOpen = vi.fn();
    const first = problem({ message: "First" });
    const second = problem({ message: "Second", severity: "warning" });
    render(
      <ProblemsPanel
        diagnostics={[first, second]}
        onOpen={onOpen}
        labelFor={() => "checkout.seq"}
      />,
    );

    fireEvent.click(screen.getAllByTestId("problem-item")[1]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(second);
  });

  it("renders a calm empty state instead of the severity groups", () => {
    render(<ProblemsPanel diagnostics={[]} onOpen={vi.fn()} />);

    expect(screen.getByTestId("problems")).toBeInTheDocument();
    expect(screen.getByTestId("problems-empty")).toHaveTextContent(
      "No problems found.",
    );
    expect(screen.queryAllByTestId("problems-group")).toHaveLength(0);
    expect(screen.queryAllByTestId("problem-item")).toHaveLength(0);
  });

  it("keeps the input order inside a severity group", () => {
    render(
      <ProblemsPanel
        diagnostics={[
          problem({ message: "Alpha" }),
          problem({ message: "Beta" }),
        ]}
        onOpen={vi.fn()}
      />,
    );

    const messages = screen
      .getAllByTestId("problem-item")
      .map((item) => item.textContent);
    expect(messages[0]).toContain("Alpha");
    expect(messages[1]).toContain("Beta");
  });
});
