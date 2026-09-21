/**
 * App command registry (Phase 6).
 *
 * The catalog of commands — their labels, descriptions, chords and categories —
 * lives in `command-catalog.ts`. This hook attaches the behaviour to each spec
 * by closing over the current workspace and tab state, so the palette, the
 * shortcut listener, and the documentation page all read one list.
 *
 * The list is memoized on the state it depends on, so the palette re-renders
 * only when behavior changes (for example when a folder is opened or closed).
 * Every command declares the {@link KeyBinding} that runs it, so the palette can
 * print the shortcut and the shell's listener can honour it without a second
 * registry.
 */
import { useCallback, useMemo } from "react";
import type { DiagramFile, NoteFile } from "../../domain/workspace/types";
import {
  createCommandRegistry,
  type Command,
  type CommandRegistry,
} from "./command";
import { availableCommands } from "./command-catalog";

/** The app state the command registry is built from. */
export interface CommandContext {
  /** Create an empty diagram in a project; resolves to the file or `null`. */
  createEmptyDiagram: (projectId: string) => Promise<DiagramFile | null>;
  /** Create an empty markdown note in a project; resolves to the file or `null`. */
  createEmptyNote: (projectId: string) => Promise<NoteFile | null>;
  /** The currently selected project id, or `null` when none is selected. */
  selectedProjectId: string | null;
  /** Open (or activate) a tab for a diagram and show its source. */
  openDiagram: (diagram: DiagramFile) => void;
  /** Create an empty event flow in the selected project and open it. */
  createEventFlow: (projectId: string) => Promise<DiagramFile | null>;
  /** Close the active tab (no-op when there is no active tab). */
  closeActiveTab: () => void;
  /** Show the project-wide search overlay. */
  openSearch: () => void;
  /** Show the quick-open overlay (also bound to Ctrl/Cmd+P). */
  openQuickOpen: () => void;
  /**
   * Switch the middle pane to one of its panels, returning to the workspace
   * when the documentation page is open.
   */
  showView: (
    view: "code" | "outline" | "problems" | "overview" | "history",
  ) => void;
  /** Open the documentation page. */
  openDocs: () => void;
  /** List every use of the symbol under the caret. */
  findReferences: () => void;
  /** Rename the symbol under the caret across the project. */
  renameSymbol: () => void;
  /** Open the diagram export dialog for the active document. */
  exportDiagram: () => void;
  /** Write the project's documentation as a static site archive. */
  exportSite: () => void;
  /** Write the selected project to a portable ZIP archive. */
  exportProject: () => void;
  /** Pick a project archive and import it. */
  importProject: () => void;
  /** Toggle the local-folder workspace open and closed. */
  openFolder: () => void;
  /** Whether a folder is currently open (drives Open vs Close label). */
  folderOpen: boolean;
  /** Whether the File System Access API is available in this browser. */
  folderSupported: boolean;
  /** Collapse every project in the explorer to a header row. */
  collapseAllProjects: () => void;
  /** Expand every project in the explorer back to its file list. */
  expandAllProjects: () => void;
}

/** Build the app's command registry from its current state. */
export function useCommands({
  createEmptyDiagram,
  createEmptyNote,
  selectedProjectId,
  openDiagram,
  createEventFlow,
  closeActiveTab,
  openSearch,
  openQuickOpen,
  showView,
  openDocs,
  findReferences,
  renameSymbol,
  exportDiagram,
  exportSite,
  exportProject,
  importProject,
  openFolder,
  folderOpen,
  folderSupported,
  collapseAllProjects,
  expandAllProjects,
}: CommandContext): CommandRegistry {
  const newDiagram = useCallback(() => {
    // Nothing to create a diagram in until a project is selected. The command
    // is a no-op rather than an error so the palette stays predictable.
    if (!selectedProjectId) return;
    void createEmptyDiagram(selectedProjectId).then((diagram) => {
      if (diagram) openDiagram(diagram);
    });
  }, [createEmptyDiagram, selectedProjectId, openDiagram]);

  const newEventFlow = useCallback(() => {
    if (!selectedProjectId) return;
    void createEventFlow(selectedProjectId);
  }, [createEventFlow, selectedProjectId]);

  const newNote = useCallback(() => {
    // Creating a note selects it in the workspace, which swaps the editor to the
    // note buffer; there is no tab to open.
    if (!selectedProjectId) return;
    void createEmptyNote(selectedProjectId);
  }, [createEmptyNote, selectedProjectId]);

  const commands = useMemo<Command[]>(() => {
    // One executor per catalog id. A spec with no executor is a programming
    // error, so it throws rather than registering a command that does nothing.
    const executors: Record<string, () => void> = {
      "new-diagram": newDiagram,
      "new-note": newNote,
      "new-event-flow": newEventFlow,
      "close-tab": closeActiveTab,
      "search-project": openSearch,
      "quick-open": openQuickOpen,
      "show-outline": () => showView("outline"),
      "show-problems": () => showView("problems"),
      "show-overview": () => showView("overview"),
      "open-docs": openDocs,
      "validate-project": () => showView("problems"),
      "collapse-all-projects": collapseAllProjects,
      "expand-all-projects": expandAllProjects,
      "find-references": findReferences,
      "rename-symbol": renameSymbol,
      "export-diagram": exportDiagram,
      "export-site": exportSite,
      "export-project": exportProject,
      "import-project": importProject,
      "open-folder": openFolder,
      "close-folder": openFolder,
    };

    return availableCommands({ folderSupported, folderOpen }).map((spec) => {
      const execute = executors[spec.id];
      if (!execute) {
        throw new Error(`No executor registered for command "${spec.id}"`);
      }
      return {
        id: spec.id,
        label: spec.label,
        binding: spec.binding,
        execute,
      };
    });
  }, [
    newDiagram,
    newNote,
    newEventFlow,
    closeActiveTab,
    openSearch,
    openQuickOpen,
    showView,
    openDocs,
    collapseAllProjects,
    expandAllProjects,
    findReferences,
    renameSymbol,
    exportDiagram,
    exportSite,
    exportProject,
    importProject,
    openFolder,
    folderOpen,
    folderSupported,
  ]);

  return createCommandRegistry(commands);
}
