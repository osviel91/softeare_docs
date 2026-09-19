import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("Preview", () => {
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
