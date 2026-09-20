import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import QuickOpen from "../../../src/features/quickopen/QuickOpen";
import type { QuickOpenItem } from "../../../src/features/quickopen/quick-open-model";

const items: QuickOpenItem[] = [
  {
    id: "diagram:pay",
    label: "Payment Processing",
    detail: "payment.seq",
    group: "Diagrams",
    search: "Payment Processing payment.seq",
  },
  {
    id: "diagram:inv",
    label: "Invoice List",
    detail: "invoice.seq",
    group: "Diagrams",
    search: "Invoice List invoice.seq",
  },
  {
    id: "document:arch",
    label: "Architecture",
    detail: "architecture.md",
    group: "Documents",
    search: "Architecture architecture.md",
  },
  {
    id: "diagram:pay#participant:svc",
    label: "PaymentService",
    detail: "participant · payment.seq",
    group: "Symbols",
    search: "PaymentService participant · payment.seq",
  },
];

function setup() {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<QuickOpen items={items} onPick={onPick} onClose={onClose} />);
  return { onPick, onClose };
}

/** Type into the overlay's input, the way a user would. */
function type(value: string) {
  fireEvent.change(screen.getByTestId("quick-open-input"), {
    target: { value },
  });
}

describe("QuickOpen", () => {
  it("renders every item in browse order with a count", () => {
    setup();
    expect(
      screen
        .getAllByTestId("quick-open-item-label")
        .map((node) => node.textContent),
    ).toEqual([
      "Payment Processing",
      "Invoice List",
      "Architecture",
      "PaymentService",
    ]);
    expect(screen.getAllByTestId("quick-open-item")).toHaveLength(4);
    expect(screen.getByTestId("quick-open-count")).toHaveTextContent(
      "4 results",
    );
  });

  it("shows the group and detail of each row", () => {
    setup();
    const first = screen.getAllByTestId("quick-open-item")[0];
    expect(first).toHaveTextContent("Diagrams");
    expect(first).toHaveTextContent("payment.seq");
  });

  it("filters as you type", () => {
    setup();
    type("invoice");
    expect(screen.getAllByTestId("quick-open-item")).toHaveLength(1);
    expect(screen.getByTestId("quick-open-item-label")).toHaveTextContent(
      "Invoice List",
    );
    expect(screen.getByTestId("quick-open-count")).toHaveTextContent(
      "1 result",
    );
  });

  it("highlights the matched characters of the label", () => {
    setup();
    type("pay");
    const first = screen.getAllByTestId("quick-open-item")[0];
    const label = first.querySelector(
      '[data-testid="quick-open-item-label"]',
    ) as HTMLElement;
    const marks = label.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("Pay");
    // The detail carries the same word but must not be highlighted.
    expect(
      first.querySelector(".quick-open__detail")?.querySelectorAll("mark"),
    ).toHaveLength(0);
  });

  it("does not highlight when the match is only in the detail", () => {
    setup();
    type("md");
    const label = screen.getByTestId("quick-open-item-label");
    expect(label.querySelectorAll("mark")).toHaveLength(0);
  });

  it("shows the empty state when nothing matches", () => {
    setup();
    type("zzzz");
    expect(screen.getByTestId("quick-open-empty")).toHaveTextContent(
      "No matches",
    );
    expect(screen.queryAllByTestId("quick-open-item")).toHaveLength(0);
    expect(screen.getByTestId("quick-open-count")).toHaveTextContent(
      "0 results",
    );
  });

  it("picks the first row with Enter and no mouse", () => {
    const { onPick } = setup();
    fireEvent.keyDown(screen.getByTestId("quick-open-input"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(items[0]);
  });

  it("navigates with the arrow keys and wraps at both ends", () => {
    setup();
    const rows = () => screen.getAllByTestId("quick-open-item");
    const input = screen.getByTestId("quick-open-input");
    expect(rows()[0]).toHaveClass("palette__item--active");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(rows()[1]).toHaveClass("palette__item--active");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(rows()[0]).toHaveClass("palette__item--active");

    // ArrowUp at the first wraps to the last.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(rows()[3]).toHaveClass("palette__item--active");

    // ArrowDown at the last wraps back to the first.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(rows()[0]).toHaveClass("palette__item--active");
  });

  it("picks the highlighted row with Enter", () => {
    const { onPick } = setup();
    const input = screen.getByTestId("quick-open-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(items[1]);
  });

  it("picks a row when it is clicked", () => {
    const { onPick } = setup();
    fireEvent.click(screen.getAllByTestId("quick-open-item")[2]);
    expect(onPick).toHaveBeenCalledWith(items[2]);
  });

  it("resets the highlight when the query changes", () => {
    setup();
    const input = screen.getByTestId("quick-open-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    type("invoice");
    expect(screen.getAllByTestId("quick-open-item")[0]).toHaveClass(
      "palette__item--active",
    );
  });

  it("does not pick when there are no results", () => {
    const { onPick } = setup();
    type("zzzz");
    fireEvent.keyDown(screen.getByTestId("quick-open-input"), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByTestId("quick-open-input"), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Tab", () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByTestId("quick-open-input"), { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked, not when the panel is", () => {
    const { onClose } = setup();
    fireEvent.mouseDown(screen.getByTestId("quick-open-input"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("quick-open"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
