import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Tab } from "../../../src/features/tabs/tabs";
import TabBar from "../../../src/features/tabs/TabBar";

const tabs: Tab[] = [
  {
    id: "diag-1",
    kind: "diagram",
    documentId: "diag-1",
    projectId: "proj-1",
    name: "Welcome",
    title: "Welcome",
    source: "",
    savedSource: "",
  },
  {
    id: "note-2",
    kind: "note",
    documentId: "note-2",
    projectId: "proj-1",
    name: "Flow.md",
    title: "Flow",
    source: "# Flow",
    savedSource: "# Flow",
  },
];

describe("TabBar", () => {
  it("shows an empty hint when there are no tabs", () => {
    render(
      <TabBar
        tabs={[]}
        activeTabId={null}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tab-bar-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-bar")).toBeNull();
  });

  it("renders one tab per open document", () => {
    render(
      <TabBar
        tabs={tabs}
        activeTabId="diag-1"
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );
    const buttons = screen.getAllByTestId("tab");
    expect(buttons).toHaveLength(2);
    expect(screen.getAllByTestId("tab-label")[0]).toHaveTextContent("Welcome");
  });

  it("names each tab's document kind", () => {
    render(
      <TabBar
        tabs={tabs}
        activeTabId="diag-1"
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );
    const buttons = screen.getAllByTestId("tab");
    expect(buttons[0]).toHaveAttribute("data-kind", "diagram");
    expect(buttons[1]).toHaveAttribute("data-kind", "note");
  });

  it("shows no modified indicator while a buffer is saved", () => {
    render(
      <TabBar
        tabs={tabs}
        activeTabId="diag-1"
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("tab-dirty")).toBeNull();
  });

  it("marks a tab with unsaved changes", () => {
    const dirty: Tab[] = [{ ...tabs[0], source: "participant A" }];
    render(
      <TabBar
        tabs={dirty}
        activeTabId="diag-1"
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );
    expect(screen.getByTestId("tab-dirty")).toHaveTextContent("●");
    expect(screen.getByTestId("tab")).toHaveClass("tab--dirty");
  });

  it("marks the active tab with aria-selected", () => {
    render(
      <TabBar
        tabs={tabs}
        activeTabId="note-2"
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );
    const buttons = screen.getAllByTestId("tab");
    expect(buttons[0]).not.toHaveAttribute("aria-selected");
    expect(buttons[1]).toHaveAttribute("aria-selected", "true");
  });

  it("activates a tab when its label is clicked", () => {
    const onActivateTab = vi.fn();
    render(
      <TabBar
        tabs={tabs}
        activeTabId="diag-1"
        onActivateTab={onActivateTab}
        onCloseTab={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByTestId("tab")[1]);
    expect(onActivateTab).toHaveBeenCalledWith("note-2");
  });

  it("closes a tab via its ✕ without activating it", () => {
    const onCloseTab = vi.fn();
    render(
      <TabBar
        tabs={tabs}
        activeTabId="diag-1"
        onActivateTab={vi.fn()}
        onCloseTab={onCloseTab}
      />,
    );
    fireEvent.click(screen.getAllByTestId("tab-close")[0]);
    expect(onCloseTab).toHaveBeenCalledWith("diag-1");
  });

  it("does not activate a tab when its ✕ is clicked", () => {
    const onActivateTab = vi.fn();
    render(
      <TabBar
        tabs={tabs}
        activeTabId="note-2"
        onActivateTab={onActivateTab}
        onCloseTab={vi.fn()}
      />,
    );
    // The ✕ is on diag-1 (first tab); clicking it must not activate diag-1.
    fireEvent.click(screen.getAllByTestId("tab-close")[0]);
    expect(onActivateTab).not.toHaveBeenCalled();
  });

  it("hides the ✕ when showClose is false", () => {
    render(
      <TabBar
        tabs={tabs}
        activeTabId="diag-1"
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
        showClose={false}
      />,
    );
    expect(screen.queryByTestId("tab-close")).toBeNull();
  });
});
