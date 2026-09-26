import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./app-harness";

const FLOW = [
  "event OrderCreated",
  "event PaymentRequested",
  "producer OrderService",
  "consumer BillingService",
  "OrderService publishes OrderCreated",
  "BillingService consumes OrderCreated",
].join("\n");

async function command(label: string): Promise<void> {
  fireEvent.click(screen.getByTestId("command-palette-button"));
  fireEvent.change(screen.getByTestId("palette-input"), { target: { value: label } });
  await act(async () => fireEvent.click(screen.getByTestId("palette-item-button")));
}

async function project(): Promise<void> {
  fireEvent.change(screen.getByTestId("project-name-input"), { target: { value: "Compare" } });
  fireEvent.click(screen.getByTestId("create-project-button"));
  await waitFor(() => expect(screen.getByTestId("project-name")).toHaveTextContent("Compare"));
}

describe("App — dual viewer foundation", () => {
  it("enters and exits Sequence to Sequence comparison", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("compare-mode-button"));

    expect(screen.getByTestId("comparison-view")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-pane-a")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-pane-b")).toBeInTheDocument();
    expect(screen.getAllByTestId("preview-svg")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.queryByTestId("comparison-view")).toBeNull();
    expect(screen.getByLabelText("DSL editor")).toBeInTheDocument();
  });

  it("supports Event Flow to Sequence and isolates Event Flow projection controls", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Event Flow");
    await command("New Diagram");
    // Return to the event flow as Viewer A; the sequence remains available as B.
    const eventFlowButton = screen
      .getAllByTestId("select-diagram-button")
      .find((button) => button.getAttribute("aria-label")?.includes("eventseq"));
    expect(eventFlowButton).toBeDefined();
    fireEvent.click(eventFlowButton!);
    fireEvent.change(screen.getByTestId("dsl-textarea"), { target: { value: FLOW } });
    await waitFor(() => expect(screen.getByTestId("preview-svg")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("compare-mode-button"));

    expect(screen.getByTestId("comparison-pane-a")).toHaveTextContent("Event Flow");
    expect(screen.getByTestId("comparison-pane-b")).toHaveTextContent("Sequence diagram");
    expect(screen.getAllByTestId("comparison-pane-a").length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Catalog" }));
    expect(screen.getByTestId("event-catalog")).toBeInTheDocument();
    expect(screen.getAllByTestId("event-flow-preview")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
  });

  it("keeps maximize and restore inside comparison mode", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("compare-mode-button"));
    fireEvent.click(screen.getByRole("button", { name: "Maximize Viewer A" }));

    expect(screen.getByTestId("comparison-pane-a")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-pane-b").parentElement).toHaveClass("comparison__slot--hidden");
    expect(screen.getByRole("button", { name: "Restore Viewer A" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore Viewer A" }));
    expect(screen.getByTestId("comparison-pane-b")).toBeInTheDocument();
  });

  it("shows a semantic comparison summary without treating names as identities", async () => {
    render(<App />);
    await project();
    await command("New Diagram");
    await command("New Diagram");
    fireEvent.click(screen.getByTestId("compare-mode-button"));

    expect(screen.getByTestId("semantic-comparison-summary")).toHaveTextContent("Shared identities: 0");
    expect(screen.getByTestId("semantic-comparison-summary")).toHaveTextContent("Candidates/unresolved: 0");
  });
});
