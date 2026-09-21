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
 *
 * Because it is `position: fixed`, an anchor near the bottom or right edge of
 * the window would otherwise place the menu's own items off-screen, where
 * neither the user nor an automated click can reach them. The menu therefore
 * measures itself once it is in the DOM and shifts — never clips — so every item
 * stays inside the viewport. A menu taller or wider than the viewport is pinned
 * to the near margin, which is the only position where its first items remain
 * reachable.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

/** The gap kept between the menu and the viewport's edges, in pixels. */
export const VIEWPORT_MARGIN = 8;

/**
 * Shift a menu box so it fits the viewport.
 *
 * Pure and exported so the geometry can be unit-tested without a real browser:
 * jsdom has no layout, so measuring a rendered menu there would always report a
 * zero-sized box.
 */
export function clampMenuToViewport(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  // Prefer the anchor, then pull back from the far edge. `Math.max` keeps the
  // near margin authoritative when the menu is larger than the viewport.
  const maxX = viewport.width - size.width - VIEWPORT_MARGIN;
  const maxY = viewport.height - size.height - VIEWPORT_MARGIN;
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(anchor.x, maxX)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(anchor.y, maxY)),
  };
}

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
  // Where the menu is drawn. Starts at the requested anchor and is corrected
  // before the first paint, so the menu never flashes off-screen.
  const [position, setPosition] = useState({ x, y });

  // The anchor is fixed for the life of a menu (a different anchor mounts a new
  // one through React's keying), so this measures once.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    // A zero-sized box means there is no layout to measure (jsdom): leave the
    // requested position alone rather than pinning every menu to the margin.
    if (rect.width === 0 && rect.height === 0) return;
    const next = clampMenuToViewport(
      { x, y },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPosition((current) =>
      current.x === next.x && current.y === next.y ? current : next,
    );
  }, [x, y]);

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
      style={{ left: position.x, top: position.y }}
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
