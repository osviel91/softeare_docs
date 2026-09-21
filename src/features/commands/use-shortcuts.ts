/**
 * Global shortcut listener for the command registry (Phase 6).
 *
 * One listener on `document` turns key presses into commands: it walks the
 * registry, finds the first command whose {@link KeyBinding} matches, and runs
 * it. Registering the chords here — instead of one `useEffect` per feature —
 * means a command's shortcut and its palette entry are the same fact.
 *
 * Two guards keep the listener from fighting the rest of the app:
 *
 * - It is disabled while a modal that owns the keyboard (the command palette,
 *   quick open, project search) is on screen.
 * - A chord with no modifier is not fired while a text field has focus, so
 *   typing a project name cannot trigger a bare `F2` command. Because the editor
 *   is a `contenteditable` surface rather than an `<input>`, editor shortcuts
 *   still work.
 */
import { useEffect } from "react";
import type { CommandRegistry } from "./command";
import { bindingMatches } from "./shortcuts";

/** Whether focus currently sits in a field that consumes plain keystrokes. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Bind every command that declares a shortcut.
 *
 * @param registry - The current command registry.
 * @param enabled - When false, no shortcut fires (a modal owns the keyboard).
 */
export function useShortcuts(registry: CommandRegistry, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    function onKeydown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      const typing = isTextField(event.target);
      for (const command of registry.commands) {
        if (!command.binding) continue;
        if (!bindingMatches(command.binding, event)) continue;
        // A plain key (no modifier) belongs to whatever field has focus.
        if (typing && !command.binding.mod && !command.binding.alt) continue;
        event.preventDefault();
        registry.run(command.id);
        return;
      }
    }

    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [registry, enabled]);
}
