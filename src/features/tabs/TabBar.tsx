/**
 * Tab bar.
 *
 * Renders the open {@link Tab}s as a strip of closable tabs above the editor.
 * The component is a pure function of its props: clicking a tab activates it and
 * clicking a tab's ✕ closes it, both routed through callbacks so the tab set lives
 * in the parent hook.
 *
 * A tab shows the document's title, a glyph naming its kind (a diagram or a
 * markdown document), a modified indicator while its buffer has unsaved changes,
 * and a close control. A tab with no close button (when `showClose` is false)
 * still activates on click.
 */
import { isDirty, type Tab } from "./tabs";

export interface TabBarProps {
  /** Every open tab, in the order they were opened. */
  tabs: Tab[];
  /** The id of the active tab, or `null` when none is open. */
  activeTabId: string | null;
  /** Called with a tab id when the user clicks the tab (not its ✕). */
  onActivateTab: (documentId: string) => void;
  /** Called with a tab id when the user clicks its ✕. */
  onCloseTab: (documentId: string) => void;
  /** Render a tab with no ✕ close button (useful when embedded elsewhere). */
  showClose?: boolean;
}

/** The glyph shown before a tab's title, naming its document kind. */
function kindGlyph(tab: Tab): string {
  return tab.kind === "note" ? "¶" : "▦";
}

/** A single tab button with a dirty indicator and an optional close control. */
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
  const dirty = isDirty(tab);
  const className = [
    "tab",
    `tab--${tab.kind}`,
    isActive ? "tab--active" : "",
    dirty ? "tab--dirty" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={className}
      data-testid="tab"
      data-kind={tab.kind}
      aria-selected={isActive ? "true" : undefined}
      aria-current={isActive ? "true" : undefined}
      onClick={onActivate}
    >
      <span className="tab__icon" aria-hidden="true">
        {kindGlyph(tab)}
      </span>
      <span className="tab__label" data-testid="tab-label">
        {tab.title}
      </span>
      {dirty && (
        <span
          className="tab__dirty"
          data-testid="tab-dirty"
          title="Unsaved changes"
          aria-label="Unsaved changes"
        >
          ●
        </span>
      )}
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
        <span className="tab-bar__empty">No documents open.</span>
      </div>
    );
  }

  return (
    <div
      className="tab-bar"
      data-testid="tab-bar"
      role="tablist"
      aria-label="Open documents"
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
