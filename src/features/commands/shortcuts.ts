/**
 * Keyboard bindings for commands.
 *
 * A {@link KeyBinding} is a small, plain description of a chord — the key plus
 * the modifier keys it requires — rather than a closure over a `KeyboardEvent`.
 * Keeping it a value lets the same binding drive three things from one place:
 * the global listener that runs the command, the label the palette prints beside
 * it, and (for the palette itself) the shortcut shown in the toolbar.
 *
 * `mod` means Control on Windows/Linux and Command on macOS, which is what makes
 * "the platform's primary modifier" a single concept in this codebase. Bindings
 * are matched against the lowercased `event.key`, so letters work regardless of
 * keyboard layout and function keys match as `f2`.
 */

/** A chord a command can be run with. */
export interface KeyBinding {
  /** Lowercased `KeyboardEvent.key`, e.g. `"p"`, `"f2"`, `"["`. */
  key: string;
  /** Primary modifier: Ctrl on Windows/Linux, Cmd on macOS. */
  mod?: boolean;
  /** Shift must be held. */
  shift?: boolean;
  /** Alt (Option on macOS) must be held. */
  alt?: boolean;
}

/** True when `event` is exactly the chord `binding` describes. */
export function bindingMatches(
  binding: KeyBinding,
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
): boolean {
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false;
  if (Boolean(binding.mod) !== (event.ctrlKey || event.metaKey)) return false;
  if (Boolean(binding.shift) !== event.shiftKey) return false;
  if (Boolean(binding.alt) !== event.altKey) return false;
  return true;
}

/** Whether the current platform is a Mac, which decides how chords are written. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const source = navigator.platform || navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(source);
}

/** How one key reads in a chord label: `p` → `P`, `f2` → `F2`, `[` → `[`. */
function keyLabel(key: string): string {
  return key.toUpperCase();
}

/**
 * The human-readable chord, e.g. `⌘⇧P` on macOS and `Ctrl+Shift+P` elsewhere.
 *
 * `mac` is injectable so tests do not depend on the machine they run on.
 */
export function bindingLabel(
  binding: KeyBinding,
  mac: boolean = isMacPlatform(),
): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) parts.push(mac ? "⌥" : "Alt");
  if (binding.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(keyLabel(binding.key));
  return mac ? parts.join("") : parts.join("+");
}

/**
 * The two navigation chords the shell owns outside the command registry.
 *
 * They live here rather than in the components that use them so the palette
 * toggle and quick open each have exactly one definition, shared by the
 * listener and the hint the UI prints.
 */
export const COMMAND_PALETTE_BINDING: KeyBinding = {
  key: "p",
  mod: true,
  shift: true,
};

/** Quick open: the platform modifier plus `P` (plain, no Shift). */
export const QUICK_OPEN_BINDING: KeyBinding = { key: "p", mod: true };
