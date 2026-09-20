/**
 * Command palette controller (Phase 6).
 *
 * Owns the transient open/closed state of the palette and wires the global
 * shortcut (Ctrl/Cmd+P toggles it, Esc dismisses it). The palette itself owns
 * the query and row selection; this hook only decides whether the modal is shown
 * and how it is opened/closed, so the App stays a thin shell.
 */
import { useCallback, useEffect, useState } from "react";

/** The open/closed state and the actions the App needs to render the palette. */
export interface CommandPaletteController {
  /** Whether the palette modal is currently shown. */
  isOpen: boolean;
  /** Open the palette (also bound to Ctrl/Cmd+P). */
  open: () => void;
  /** Dismiss the palette. */
  close: () => void;
}

/**
 * Manage the palette's open state and its global keyboard shortcut.
 *
 * Ctrl/Cmd+P toggles the palette open and closed (a common editor pattern), and
 * Esc dismisses it when open. The shortcut is attached to `document` so it works
 * regardless of where focus currently is.
 */
export function useCommandPalette(): CommandPaletteController {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setIsOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, []);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return { isOpen, open, close };
}
