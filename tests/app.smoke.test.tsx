import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
