/**
 * Command palette model.
 *
 * A {@link Command} is a single, self-contained action the user can invoke from
 * the command palette — for example "New diagram" or "Close tab". A
 * {@link CommandRegistry} is an immutable list of commands plus two pure helpers:
 * filtering by label and running a command by id. Keeping these as plain values
 * (no React, no repository) makes the palette logic unit-testable in isolation
 * and lets App compose commands from its current workspace/tab state.
 *
 * A command may carry a {@link KeyBinding}. The binding is data, not behavior:
 * the palette prints its label and the shell's shortcut listener runs the command
 * when the chord is pressed, so the shortcut and the menu entry cannot drift
 * apart.
 */
import type { KeyBinding } from "./shortcuts";

/** A single action the user can invoke from the command palette. */
export interface Command {
  /** Stable identifier, e.g. "new-diagram". */
  id: string;
  /** Human-readable label shown in the palette; also the filter key. */
  label: string;
  /** The chord that runs this command, when it has one. */
  binding?: KeyBinding;
  /** Run the command. */
  execute: () => void;
}

/** A registry of commands the palette can filter and run. */
export interface CommandRegistry {
  /** Every registered command, in display order. */
  commands: Command[];
  /** Filter the commands whose label contains `query` (case-insensitive). */
  filter(query: string): Command[];
  /** Run the command with the given id. Returns true when a command ran. */
  run(id: string): boolean;
}

/** Build a {@link CommandRegistry} from a fixed list of commands. */
export function createCommandRegistry(commands: Command[]): CommandRegistry {
  const byId = new Map(commands.map((command) => [command.id, command]));

  return {
    commands,
    filter(query) {
      const normalized = query.trim().toLowerCase();
      if (normalized === "") return commands;
      return commands.filter((command) =>
        command.label.toLowerCase().includes(normalized),
      );
    },
    run(id) {
      const command = byId.get(id);
      if (!command) return false;
      command.execute();
      return true;
    },
  };
}
