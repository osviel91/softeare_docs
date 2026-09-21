/**
 * The command catalog: the single description of every command the app offers.
 *
 * The palette, the shortcut listener, and the documentation page all derive from
 * this list, so a command cannot be added in code and forgotten in the reference
 * — the same "one source of truth" rule the DSL reference follows for the
 * grammar. {@link useCommands} attaches each spec's behaviour; this module owns
 * only the facts a reader needs (label, what it does, its chord, and when it
 * applies).
 *
 * A spec's `binding` is data, not behaviour: the palette prints it, the shortcut
 * listener matches it, and the reference page documents it, all from here.
 */
import { QUICK_OPEN_BINDING, type KeyBinding } from "./shortcuts";

/** The groups the documentation page lists commands under. */
export type CommandCategory = "Create" | "Navigate" | "Project" | "Export";

/** The catalog groups, in the order the reference lists them. */
export const COMMAND_CATEGORIES: CommandCategory[] = [
  "Create",
  "Navigate",
  "Project",
  "Export",
];

/** The parts of the environment that decide whether a command applies. */
export interface CommandEnvironment {
  /** Whether the browser exposes the File System Access API. */
  folderSupported: boolean;
  /** Whether a local folder is currently open. */
  folderOpen: boolean;
}

/** One command as the reference describes it, before behaviour is attached. */
export interface CommandSpec {
  /** Stable identifier, e.g. `"new-diagram"`. */
  id: string;
  /** Human-readable label; also the palette's filter key. */
  label: string;
  /** One sentence on what running the command does. */
  description: string;
  /** Which reference section lists it. */
  category: CommandCategory;
  /** The chord that runs it. Every command has one. */
  binding: KeyBinding;
  /** A note shown in the reference when the command only sometimes applies. */
  condition?: string;
  /** Whether the command applies right now. Defaults to always. */
  enabled?: (environment: CommandEnvironment) => boolean;
}

/** A `mod+alt` chord, the safe space for app shortcuts inside a browser. */
function chord(key: string, shift = false): KeyBinding {
  const binding: KeyBinding = { key, mod: true, alt: true };
  return shift ? { ...binding, shift: true } : binding;
}

/** Every command the app can register, in palette display order. */
export const COMMAND_CATALOG: CommandSpec[] = [
  {
    id: "new-diagram",
    label: "New Diagram",
    description:
      "Create an empty sequence diagram in the selected project and open it.",
    category: "Create",
    binding: chord("n"),
  },
  {
    id: "new-note",
    label: "New Note",
    description: "Create an empty markdown document in the selected project.",
    category: "Create",
    binding: chord("m"),
  },
  {
    id: "new-event-flow",
    label: "New Event Flow",
    description:
      "Create an empty event flow (`*.eventseq`) in the selected project.",
    category: "Create",
    binding: chord("f"),
  },
  {
    id: "close-tab",
    label: "Close Tab",
    description: "Close the active document tab.",
    category: "Project",
    binding: chord("w"),
  },
  {
    id: "search-project",
    label: "Search Project…",
    description:
      "Find text across every diagram and document, with `kind:`, `project:` and `participant:` scopes.",
    category: "Navigate",
    binding: { key: "f", mod: true, shift: true },
  },
  {
    id: "quick-open",
    label: "Quick Open…",
    description:
      "Jump to a file, a declared symbol, or a heading by typing its name.",
    category: "Navigate",
    binding: QUICK_OPEN_BINDING,
  },
  {
    id: "show-outline",
    label: "Toggle Outline",
    description: "Show the statement tree of the open document.",
    category: "Navigate",
    binding: chord("o"),
  },
  {
    id: "show-problems",
    label: "Toggle Problems",
    description: "Show every diagnostic in the project.",
    category: "Navigate",
    binding: chord("p"),
  },
  {
    id: "show-overview",
    label: "Project Overview",
    description: "Show the project's resources, symbols and problem counts.",
    category: "Navigate",
    binding: chord("i"),
  },
  {
    id: "open-docs",
    label: "Documentation",
    description:
      "Open the documentation page: the two diagram languages, every command, and the MCP server.",
    category: "Navigate",
    binding: chord("d"),
  },
  {
    id: "validate-project",
    label: "Validate Project",
    description: "Review the project's diagnostics in the Problems panel.",
    category: "Navigate",
    binding: chord("v"),
  },
  {
    id: "collapse-all-projects",
    label: "Collapse All Projects",
    description: "Fold every project in the explorer to its header row.",
    category: "Project",
    binding: chord("c"),
  },
  {
    id: "expand-all-projects",
    label: "Expand All Projects",
    description: "Expand every project in the explorer back to its files.",
    category: "Project",
    binding: chord("c", true),
  },
  {
    id: "find-references",
    label: "Find References",
    description:
      "List every declaration and use of the symbol under the caret.",
    category: "Navigate",
    binding: chord("r"),
  },
  {
    id: "rename-symbol",
    label: "Rename Symbol…",
    description:
      "Rename a participant or event across the project, rewriting only its real mentions.",
    category: "Navigate",
    binding: { key: "f2" },
  },
  {
    id: "export-diagram",
    label: "Export Diagram…",
    description: "Export the open diagram as SVG, PNG or PDF.",
    category: "Export",
    binding: chord("e"),
  },
  {
    id: "export-site",
    label: "Export Documentation Site",
    description: "Write the project's documentation as a static site archive.",
    category: "Export",
    binding: chord("s", true),
  },
  {
    id: "export-project",
    label: "Export Project",
    description: "Write the selected project to a portable ZIP archive.",
    category: "Export",
    binding: chord("e", true),
  },
  {
    id: "import-project",
    label: "Import Project…",
    description: "Recreate a project from an exported archive.",
    category: "Export",
    binding: chord("i", true),
  },
  {
    id: "open-folder",
    label: "Open Folder…",
    description: "Use a folder on disk as the workspace.",
    category: "Project",
    binding: chord("l"),
    condition:
      "Only when the File System Access API is available and no folder is open.",
    enabled: (environment) =>
      environment.folderSupported && !environment.folderOpen,
  },
  {
    id: "close-folder",
    label: "Close Folder",
    description: "Return to in-browser projects, leaving the folder on disk.",
    category: "Project",
    binding: chord("l"),
    condition: "Only while a local folder is open.",
    enabled: (environment) =>
      environment.folderSupported && environment.folderOpen,
  },
];

/** The catalog entries that apply in the given environment, in catalog order. */
export function availableCommands(
  environment: CommandEnvironment,
): CommandSpec[] {
  return COMMAND_CATALOG.filter((spec) =>
    spec.enabled ? spec.enabled(environment) : true,
  );
}
