import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Tab } from "../../../src/features/tabs/tabs";
import TabBar from "../../../src/features/tabs/TabBar";

const tabs: Tab[] = [
  {
    id: "diag-1",
    diagramId: "diag-1",
    projectId: "proj-1",
    title: "Welcome",
    source: "",
  },
  {
    id: "diag-2",
    diagramId: "diag-2",
    projectId: "proj-1",
    title: "Flow",
    source: "",
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

  it("renders one tab per open diagram", () => {
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

  it("marks the active tab with aria-selected", () => {
    render(
      <TabBar
        tabs={tabs}
        activeTabId="diag-2"
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
    expect(onActivateTab).toHaveBeenCalledWith("diag-2");
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
        activeTabId="diag-2"
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
