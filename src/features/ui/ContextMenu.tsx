/**
 * A small context menu, positioned at a pointer or button.
 *
 * The explorer uses it for the actions that act on a single diagram or note
 * (rename, change title, delete). It is controlled: the caller owns the open
 * position and receives a callback per item, so the menu itself has no knowledge
 * of workspaces or files.
 *
 * It closes on Escape, on a click outside, and on scroll or resize — the three
 * ways a fixed-position menu would otherwise be left floating over stale
 * coordinates. Items are real buttons inside a `role="menu"`, so keyboard users
 * get the usual button semantics.
 */
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

/** One action in a {@link ContextMenu}. */
export interface ContextMenuItem {
  /** Stable id, used as the React key and the item's test id suffix. */
  id: string;
  /** Label shown to the user. */
  label: string;
  /** Run when the item is chosen. */
  onSelect: () => void;
  /** Render in the danger tone (used for delete). */
  danger?: boolean;
}

export interface ContextMenuProps {
  /** Viewport x of the menu's top-left corner. */
  x: number;
  /** Viewport y of the menu's top-left corner. */
  y: number;
  /** The actions to offer, in display order. */
  items: ContextMenuItem[];
  /** Dismiss without choosing anything. */
  onClose: () => void;
  /** Accessible name for the menu, e.g. "Actions for Login". */
  label?: string;
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  label = "Actions",
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && event.target instanceof Node) {
        if (!menuRef.current.contains(event.target)) onClose();
      }
    };
    const onDismiss = () => onClose();
    // Capture phase so a click on another row closes this menu before that row
    // opens its own.
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [onClose]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    // Arrow keys move between items so the menu is usable without a pointer.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ) ?? [],
      );
      if (buttons.length === 0) return;
      event.preventDefault();
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (index + step + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-testid="context-menu"
      style={{ left: x, top: y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`context-menu__item${
            item.danger ? " context-menu__item--danger" : ""
          }`}
          data-testid={`context-menu-${item.id}`}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
