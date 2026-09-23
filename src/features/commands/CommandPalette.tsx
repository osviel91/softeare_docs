/**
 * Command palette.
 *
 * A modal dialog over a {@link CommandRegistry}: an input filters the commands by
 * label and the user runs one with Enter, arrow keys, or a click. The palette is
 * a pure function of its props — it owns only the transient UI state (the current
 * query and the highlighted row) and delegates running/closing to `onRun`/
 * `onClose`. This keeps the component free of workspace knowledge so it can be
 * unit-tested against any registry.
 */
import { useEffect, useRef, useState } from "react";
import type { Command, CommandRegistry } from "./command";
import { bindingLabel } from "./shortcuts";

export interface CommandPaletteProps {
  /** The commands to filter and run. */
  registry: CommandRegistry;
  /** Run the chosen command and dismiss the palette. */
  onRun: (command: Command) => void;
  /** Dismiss the palette without running a command. */
  onClose: () => void;
  /**
   * The chord that opens the palette. Shown in the footer so the shortcut is
   * discoverable from inside the thing it opens.
   */
  openShortcut?: string;
}

/** The command palette modal: a filter input over a registry of commands. */
export default function CommandPalette({
  registry,
  onRun,
  onClose,
  openShortcut,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = registry.filter(query);

  // Keep the selection clamped to the current filtered list as it changes.
  useEffect(() => {
    setSelectedIndex((index) =>
      Math.max(0, Math.min(index, Math.max(0, commands.length - 1))),
    );
  }, [commands]);

  // Focus the input on mount and refocus whenever the query clears.
  useEffect(() => {
    inputRef.current?.focus();
  }, [query]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setSelectedIndex((index) => (index + 1) % Math.max(1, commands.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setSelectedIndex(
          (index) =>
            (index - 1 + commands.length) % Math.max(1, commands.length),
        );
        break;
      case "Enter":
        event.preventDefault();
        {
          const chosen = commands[selectedIndex];
          if (chosen) onRun(chosen);
        }
        break;
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      case "Tab":
        // Move focus out of the palette (e.g. back to the editor) and close.
        event.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div
      className="palette-overlay"
      data-testid="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(event) => {
        // Clicking the backdrop (not the panel) closes the palette.
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          data-testid="palette-input"
          type="text"
          placeholder="Type a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          autoFocus
        />
        <ul className="palette__list" role="listbox" aria-label="Commands">
          {commands.length === 0 ? (
            <li
              className="palette__empty"
              data-testid="palette-empty"
              role="option"
            >
              No commands match.
            </li>
          ) : (
            commands.map((command, index) => (
              <li
                key={command.id}
                role="option"
                aria-selected={index === selectedIndex}
                data-testid="palette-item"
              >
                <button
                  type="button"
                  className={`palette__item${
                    index === selectedIndex ? " palette__item--active" : ""
                  }`}
                  data-testid="palette-item-button"
                  aria-label={command.label}
                  onClick={() => onRun(command)}
                >
                  <span className="palette__item-label">{command.label}</span>
                  {command.binding && (
                    <kbd
                      className="palette__shortcut"
                      data-testid="palette-shortcut"
                    >
                      {bindingLabel(command.binding)}
                    </kbd>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="palette__footer">
          <span className="palette__hint">
            ↑↓ navigate · Enter run · Esc close
          </span>
          {openShortcut && (
            <span
              className="palette__hint palette__open-hint"
              data-testid="palette-open-hint"
            >
              Open with <kbd className="palette__shortcut">{openShortcut}</kbd>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
