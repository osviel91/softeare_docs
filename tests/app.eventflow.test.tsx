import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./app-harness";

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

  it("lists an event flow once, under its own kind, in quick open", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();

    fireEvent.keyDown(document, { key: "p", metaKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("quick-open")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("quick-open-input"), {
      target: { value: "Untitled" },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("quick-open-item").length).toBeGreaterThan(
        0,
      );
    });

    const items = screen.getAllByTestId("quick-open-item");
    // The flow is a resource, so it appears exactly once — not once as the file
    // and again as a symbol mislabelled an "event".
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Event flows");
  });

  it("offers the event-flow snippets in an event flow, not the sequence ones", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();

    fireEvent.click(screen.getByTestId("snippets-button"));
    const offered = screen
      .getAllByTestId("snippet-item")
      .map((item) => item.textContent ?? "")
      .join(" ");
    expect(offered).toContain("Broker");
    expect(offered).toContain("Publish");
    // The sequence language's constructs would be syntax errors here.
    expect(offered).not.toContain("Participants");
    expect(offered).not.toContain("Activation");
  });

  it("keeps the sequence snippets for a sequence diagram", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    await runCommand("New Diagram");
    await waitFor(() => {
      expect(screen.getByTestId("dsl-textarea")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("snippets-button"));
    const offered = screen
      .getAllByTestId("snippet-item")
      .map((item) => item.textContent ?? "")
      .join(" ");
    expect(offered).toContain("Participants");
    expect(offered).not.toContain("Broker");
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

  it("switches to a source-linked catalog without changing the source", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    const catalogFlow = FLOW.replace(
      "event OrderCreated",
      "event OrderCreated {\n  description: Emitted after persistence.\n  schema: orders.v1\n  custom: retained\n}",
    );
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: catalogFlow },
    });
    await waitFor(() =>
      expect(screen.getByTestId("preview-svg")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Catalog" }));
    expect(screen.getByTestId("event-catalog")).toHaveTextContent(
      "OrderCreated",
    );
    expect(screen.getByTestId("event-catalog")).toHaveTextContent("orders.v1");
    expect(screen.getByTestId("event-catalog")).toHaveTextContent(
      "Emitted after persistence.",
    );
    expect(screen.getByTestId("event-catalog")).toHaveTextContent(
      "OrderService",
    );
    expect(screen.getByTestId("event-catalog")).toHaveTextContent(
      "BillingService",
    );
    expect(screen.getByTestId("dsl-textarea")).toHaveValue(catalogFlow);

    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
  });

  it("switches between Flow, Catalog, and Topology without changing source", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: FLOW },
    });
    await waitFor(() =>
      expect(screen.getByTestId("preview-svg")).toBeInTheDocument(),
    );
    const editor = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    const source = editor.value;

    fireEvent.click(screen.getByRole("button", { name: "Catalog" }));
    expect(screen.getByTestId("event-catalog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Topology" }));
    expect(screen.getByTestId("topology-svg")).toBeInTheDocument();
    expect(screen.getByTestId("event-topology")).toHaveTextContent(
      "OrderService",
    );
    expect(screen.getByTestId("event-topology")).toHaveTextContent(
      "PaymentRequested",
    );
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
    expect(editor).toHaveValue(source);
  });

  it("opens the causal investigation view and focuses a handler", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    const source = [
      "event Received", "event Created", "handler TransactionHandler in TransactionsService",
      "Received handled by TransactionHandler", "TransactionHandler causes Created",
      "effect persist on TransactionHandler kind state: persist transaction",
    ].join("\n");
    fireEvent.change(screen.getByTestId("dsl-textarea"), { target: { value: source } });
    fireEvent.click(screen.getByRole("button", { name: "Causal" }));
    expect(screen.getByTestId("causal-svg").querySelector("svg")).toHaveAttribute("aria-label", "Causal event flow");
    const handler = screen.getByTestId("causal-svg").querySelector('[data-causal-id="handler:TransactionHandler"]');
    expect(handler).not.toBeNull();
    fireEvent.click(handler!);
    expect(screen.getByLabelText("Causal selection details")).toHaveTextContent("TransactionHandler");
  });

  it("shows authored entity details alongside derived causal information", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    const source = [
      "event Received {",
      "  details: \"\"\"",
      "  Emitted only after the persisted record is available.",
      "  \"\"\"",
      "}",
      "event Created",
      "handler TransactionHandler {",
      "  details: \"\"\"",
      "  Validates and transforms the received record.",
      "  \"\"\"",
      "}",
      "Received handled by TransactionHandler",
      "TransactionHandler causes Created",
      "effect persist on TransactionHandler kind state: persist transaction {",
      "  details: \"\"\"",
      "  The persistence guarantee is not documented.",
      "  \"\"\"",
      "}",
    ].join("\n");
    fireEvent.change(screen.getByTestId("dsl-textarea"), { target: { value: source } });
    fireEvent.click(screen.getByRole("button", { name: "Causal" }));
    const handler = screen.getByTestId("causal-svg").querySelector('[data-causal-id="handler:TransactionHandler"]');
    fireEvent.click(handler!);
    expect(screen.getByLabelText("Causal selection details")).toHaveTextContent(
      "Validates and transforms the received record.",
    );
    expect(screen.getByLabelText("Causal selection details")).toHaveTextContent("Inputs: Received");
    expect(screen.getByLabelText("Causal selection details")).toHaveTextContent("Outputs: Created");
  });

  it("defaults to Causal when explicit causal facts are present", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    fireEvent.change(screen.getByTestId("dsl-textarea"), { target: { value: [
      "event Input", "event Output", "handler Handle", "Input handled by Handle", "Handle causes Output",
    ].join("\n") } });
    await waitFor(() => expect(screen.getByTestId("causal-svg")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Flow" }));
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
  });

  it("explains why a legacy topology-only flow has no causal view", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    fireEvent.change(screen.getByTestId("dsl-textarea"), { target: { value: FLOW } });
    fireEvent.click(screen.getByRole("button", { name: "Causal" }));
    expect(screen.getByTestId("event-causal-empty")).toHaveTextContent("Topology is documented");
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
    // Each problem names the project and document it belongs to, so two
    // same-named files can never be confused.
    expect(messages.every((text) => text.includes("Payments ›"))).toBe(true);
  });

  it("counts an event flow's own problems, not the sequence parser's", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();

    // Valid event-flow text is full of constructs the sequence grammar rejects;
    // the status bar must not report those as this document's problems.
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: FLOW },
    });
    await waitFor(() => {
      expect(screen.getByTestId("status-diagnostics").textContent).toBe(
        "No problems",
      );
    });
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

  it("bolds event-flow names and follows a declaration rename", async () => {
    render(<App />);
    await createProject();
    await newEventFlow();
    fireEvent.change(screen.getByTestId("dsl-textarea"), {
      target: { value: FLOW },
    });

    const textarea = screen.getByTestId("dsl-textarea") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(textarea.value).toBe(FLOW);
    });

    const highlight = screen.getByTestId("editor-highlight");
    const bolded = [...highlight.querySelectorAll("strong")].map(
      (element) => element.textContent,
    );
    // Declarations and the edges that name them are all bold.
    expect(bolded).toContain("OrderCreated");
    expect(bolded).toContain("BillingService");
    expect(bolded).toContain("orders");
    expect(bolded).toContain("Kafka");

    // Retyping the event's name carries the edges with it.
    fireEvent.change(textarea, {
      target: { value: FLOW.replace("event OrderCreated", "event OrderPaid") },
    });

    expect(textarea.value).toContain("event OrderPaid");
    expect(textarea.value).toContain(
      "OrderService publishes OrderPaid to orders",
    );
    expect(textarea.value).toContain(
      "BillingService consumes OrderPaid from orders",
    );
    expect(textarea.value).not.toMatch(/\bOrderCreated\b/);
    // The flow still renders rather than collapsing on an unknown event.
    expect(screen.getByTestId("preview-svg")).toBeInTheDocument();
  });
});
