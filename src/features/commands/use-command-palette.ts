/**
 * Command palette controller (Phase 6).
 *
 * Owns the transient open/closed state of the palette and wires the global
 * shortcut (Ctrl/Cmd+Shift+P toggles it, Esc dismisses it). The palette itself
 * owns the query and row selection; this hook only decides whether the modal is
 * shown and how it is opened/closed, so the App stays a thin shell.
 *
 * Shift is part of the binding because plain Ctrl/Cmd+P belongs to quick open —
 * the two overlays answer different questions ("what can I do?" versus "what can
 * I open?") and sharing one shortcut would make each unreliable.
 */
import { useCallback, useEffect, useState } from "react";
import { COMMAND_PALETTE_BINDING, bindingMatches } from "./shortcuts";

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
 * {@link COMMAND_PALETTE_BINDING} toggles the palette open and closed, and Esc
 * dismisses it when open. The shortcut is attached to `document` so it works
 * regardless of where focus currently is.
 */
export function useCommandPalette(): CommandPaletteController {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if (bindingMatches(COMMAND_PALETTE_BINDING, event)) {
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
