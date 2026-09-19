/**
 * Tab bar (Phase 6).
 *
 * Renders the open {@link Tab}s as a strip of closable tabs above the editor. The
 * component is a pure function of its props: clicking a tab activates it and
 * clicking a tab's ✕ closes it, both routed through callbacks so the tab set lives
 * in the parent hook. A tab with no close button (when `showClose` is false) still
 * activates on click.
 */
import type { Tab } from "./tabs";

export interface TabBarProps {
  /** Every open tab, in the order they were opened. */
  tabs: Tab[];
  /** The id of the active tab, or `null` when none is open. */
  activeTabId: string | null;
  /** Called with a tab id when the user clicks the tab (not its ✕). */
  onActivateTab: (diagramId: string) => void;
  /** Called with a tab id when the user clicks its ✕. */
  onCloseTab: (diagramId: string) => void;
  /** Render a tab with no ✕ close button (useful when embedded elsewhere). */
  showClose?: boolean;
}

/** A single tab button with an optional close control. */
function TabButton({
  tab,
  isActive,
  onActivate,
  onClose,
  showClose,
}: {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose?: () => void;
  showClose: boolean;
}) {
  return (
    <button
      type="button"
      className={`tab${isActive ? " tab--active" : ""}`}
      data-testid="tab"
      aria-selected={isActive ? "true" : undefined}
      aria-current={isActive ? "true" : undefined}
      onClick={onActivate}
    >
      <span className="tab__label" data-testid="tab-label">
        {tab.title}
      </span>
      {showClose && (
        <span
          className="tab__close"
          data-testid="tab-close"
          aria-label={`Close ${tab.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose?.();
          }}
        >
          ✕
        </span>
      )}
    </button>
  );
}

/** The tab strip; renders an empty hint when no tabs are open. */
export default function TabBar({
  tabs,
  activeTabId,
  onActivateTab,
  onCloseTab,
  showClose = true,
}: TabBarProps) {
  if (tabs.length === 0) {
    return (
      <div className="tab-bar" data-testid="tab-bar-empty">
        <span className="tab-bar__empty">No diagrams open.</span>
      </div>
    );
  }

  return (
    <div
      className="tab-bar"
      data-testid="tab-bar"
      role="tablist"
      aria-label="Open diagrams"
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          onActivate={() => onActivateTab(tab.id)}
          onClose={() => onCloseTab(tab.id)}
          showClose={showClose}
        />
      ))}
    </div>
  );
}
