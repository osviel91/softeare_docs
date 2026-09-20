import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../src/App";

/**
 * Phase C: event flows as a first-class document language.
 *
 * Driven through the real shell against the in-memory repository, so the whole
 * path is covered: the command creates a `.eventseq` file, the editor and
 * preview switch language by extension, the index turns the model into project
 * symbols and diagnostics, and selection travels through node ids.
 */
const FLOW = [
  "title Order Processing",
  "",
  "event OrderCreated",
  "event PaymentRequested",
  "",
  "broker Kafka",
  "topic orders on Kafka",
  "",
  "producer OrderService",
  "consumer BillingService",
  "service PaymentService",
  "",
  "OrderService publishes OrderCreated to orders",
  "BillingService consumes OrderCreated from orders",
  "BillingService publishes PaymentRequested to orders",
  "PaymentService consumes PaymentRequested from orders",
].join("\n");

describe("App — event flows", () => {
  async function createProject(): Promise<void> {
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "Payments" },
    });
    fireEvent.click(screen.getByTestId("create-project-button"));
    await waitFor(() => {
      expect(screen.getByTestId("project-name")).toHaveTextContent("Payments");
    });
  }

  async function runCommand(label: string): Promise<void> {
    fireEvent.click(screen.getByTestId("command-palette-button"));
    fireEvent.change(screen.getByTestId("palette-input"), {
      target: { value: label },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-item-button"));
    });
  }

  /** Create an event flow through the palette and wait for its editor. */
  async function newEventFlow(): Promise<void> {
    await runCommand("New Event Flow");
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Event flow editor")).toBeInTheDocument();
  }

  it("creates a .eventseq document and opens it in the event-flow editor", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();

    expect(screen.getByTestId("explorer-diagram")).toHaveTextContent(
      "Untitled.eventseq",
    );
    // The tab says which diagram language it holds.
    expect(screen.getByTestId("tab")).toHaveAttribute("data-kind", "diagram");
    expect(screen.getByTestId("tab")).toHaveTextContent("⇄");
    // An empty flow draws nothing yet — the preview is there, with no nodes.
    expect(screen.getByTestId("event-flow-preview")).toBeInTheDocument();
    expect(
      screen
        .queryAllByTestId("preview-svg")[0]
        ?.querySelector("[data-node-id]") ?? null,
    ).toBeNull();
  });

  it("renders a complete flow as a diagram with addressable nodes", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: FLOW },
    });

    await waitFor(() => {
      expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
    });
    const svg = screen.getByTestId("preview-svg");
    // One addressable node per producer, event and consumer.
    expect(svg.querySelectorAll('[data-node-id^="event@"]').length).toBe(2);
    expect(svg.querySelectorAll('[data-node-id^="subscription@"]').length).toBe(
      2,
    );
    expect(svg.textContent).toContain("OrderCreated");
    expect(svg.textContent).toContain("BillingService");
    // The fan-out is drawn as one line per consumer.
    expect(screen.getByTestId("status-participants")).toHaveTextContent(
      "2 events",
    );
  });

  it("outlines what the flow declares and what happens", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: FLOW },
    });

    fireEvent.click(screen.getByTestId("view-outline"));
    await waitFor(() => {
      expect(screen.getByTestId("outline")).toBeInTheDocument();
    });
    const topLevel = screen
      .getAllByTestId("outline-item-label")
      .map((element) => element.textContent);
    expect(topLevel).toContain("Events (2)");
    expect(topLevel).toContain("Services");
    expect(topLevel).toContain("Channels");
    expect(topLevel).toContain("Flow");

    // Expanding the events section lists the vocabulary.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("outline-item-toggle")[0]);
    });
    const labels = screen
      .getAllByTestId("outline-item-label")
      .map((element) => element.textContent);
    expect(labels).toContain("OrderCreated");
    expect(labels).toContain("PaymentRequested");
  });

  it("turns event-driven design mistakes into project problems", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();

    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: "event Lonely\nGhost publishes Nowhere" },
    });

    fireEvent.click(screen.getByTestId("view-problems"));
    await waitFor(() => {
      expect(screen.getByTestId("problems")).toBeInTheDocument();
    });
    const messages = screen
      .queryAllByTestId("problem-item")
      .map((element) => element.textContent ?? "");
    expect(messages.some((text) => text.includes("Unknown service"))).toBe(
      true,
    );
    expect(messages.some((text) => text.includes("Unknown event"))).toBe(true);
    // An event nothing publishes is the check an EDD review actually wants.
    expect(messages.some((text) => text.includes("has no producer"))).toBe(
      true,
    );
  });

  it("completes event names declared by the flow", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();

    const editor = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: { value: `${FLOW}\nOrderService publishes ` },
    });
    // `change` sets the value without moving the caret, and completion answers
    // for the caret, so put it at the end of the line first.
    editor.setSelectionRange(editor.value.length, editor.value.length);
    await act(async () => {
      fireEvent.keyUp(editor, { key: " " });
    });

    await waitFor(() => {
      expect(screen.getByTestId("completions")).toBeInTheDocument();
    });
    const labels = screen
      .getAllByTestId("completion-item")
      .map((element) => element.textContent ?? "");
    expect(labels.some((label) => label.includes("OrderCreated"))).toBe(true);
  });

  it("selects an event's source when its rendered box is clicked", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: FLOW },
    });
    await waitFor(() => {
      expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
    });

    const eventBox = screen
      .getByTestId("preview-svg")
      .querySelector('[data-node-id^="event@"]');
    expect(eventBox).not.toBeNull();
    await act(async () => {
      fireEvent.click(eventBox!);
    });

    const editor = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(
        editor.value.slice(editor.selectionStart, editor.selectionEnd),
      ).toContain("OrderCreated");
    });
  });

  it("keeps sequence diagrams working beside event flows", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();

    // A sequence diagram created after an event flow still gets its own editor
    // and preview; the two languages share a store but not a pipeline.
    await runCommand("New Diagram");
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: {
        value: "title Checkout\nparticipant A\nparticipant B\nA -> B: hi",
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("preview-svg").textContent).toContain(
        "Checkout",
      );
    });
    expect(screen.getByTestId("status-messages")).toHaveTextContent(
      "1 message",
    );
  });
});
