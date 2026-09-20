/**
 * App command registry (Phase 6).
 *
 * Composes the concrete {@link Command}s the palette exposes, each closing over
 * the current workspace and tab state. "New diagram" creates an empty file in
 * the selected project and opens its tab; "Close tab" closes the active tab;
 * "Open/Close folder" toggles the local-folder workspace. The list is memoized
 * on the state it depends on, so the palette re-renders only when behavior
 * changes (for example when a folder is opened or closed).
 */
import { useCallback, useMemo } from "react";
import type { DiagramFile, NoteFile } from "../../domain/workspace/types";
import {
  createCommandRegistry,
  type Command,
  type CommandRegistry,
} from "./command";

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
  /** Close the active tab (no-op when there is no active tab). */
  closeActiveTab: () => void;
  /** Show the project-wide search overlay. */
  openSearch: () => void;
  /** Show the quick-open overlay (also bound to Ctrl/Cmd+P). */
  openQuickOpen: () => void;
  /** Switch the middle pane to one of its panels. */
  showView: (
    view: "code" | "outline" | "problems" | "overview" | "docs" | "history",
  ) => void;
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
}

/** Build the app's command registry from its current state. */
export function useCommands({
  createEmptyDiagram,
  createEmptyNote,
  selectedProjectId,
  openDiagram,
  closeActiveTab,
  openSearch,
  openQuickOpen,
  showView,
  findReferences,
  renameSymbol,
  exportDiagram,
  exportSite,
  exportProject,
  importProject,
  openFolder,
  folderOpen,
  folderSupported,
}: CommandContext): CommandRegistry {
  const newDiagram = useCallback(() => {
    // Nothing to create a diagram in until a project is selected. The command
    // is a no-op rather than an error so the palette stays predictable.
    if (!selectedProjectId) return;
    void createEmptyDiagram(selectedProjectId).then((diagram) => {
      if (diagram) openDiagram(diagram);
    });
  }, [createEmptyDiagram, selectedProjectId, openDiagram]);

  const newNote = useCallback(() => {
    // Creating a note selects it in the workspace, which swaps the editor to the
    // note buffer; there is no tab to open.
    if (!selectedProjectId) return;
    void createEmptyNote(selectedProjectId);
  }, [createEmptyNote, selectedProjectId]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: "new-diagram", label: "New Diagram", execute: newDiagram },
      { id: "new-note", label: "New Note", execute: newNote },
      { id: "close-tab", label: "Close Tab", execute: closeActiveTab },
      { id: "search-project", label: "Search Project…", execute: openSearch },
      { id: "quick-open", label: "Quick Open…", execute: openQuickOpen },
      {
        id: "show-outline",
        label: "Toggle Outline",
        execute: () => showView("outline"),
      },
      {
        id: "show-problems",
        label: "Toggle Problems",
        execute: () => showView("problems"),
      },
      {
        id: "show-overview",
        label: "Project Overview",
        execute: () => showView("overview"),
      },
      {
        id: "validate-project",
        label: "Validate Project",
        execute: () => showView("problems"),
      },
      {
        id: "find-references",
        label: "Find References",
        execute: findReferences,
      },
      { id: "rename-symbol", label: "Rename Symbol…", execute: renameSymbol },
      {
        id: "export-diagram",
        label: "Export Diagram…",
        execute: exportDiagram,
      },
      {
        id: "export-site",
        label: "Export Documentation Site",
        execute: exportSite,
      },
      { id: "export-project", label: "Export Project", execute: exportProject },
      {
        id: "import-project",
        label: "Import Project…",
        execute: importProject,
      },
    ];

    // A folder command only makes sense when the API is available. Folder open
    // implies support, so guard both branches on it. When a folder is open,
    // offer to close it; otherwise offer to open one.
    if (folderSupported && !folderOpen) {
      list.push({
        id: "open-folder",
        label: "Open Folder…",
        execute: openFolder,
      });
    }
    if (folderSupported && folderOpen) {
      list.push({
        id: "close-folder",
        label: "Close Folder",
        execute: openFolder,
      });
    }

    return list;
  }, [
    newDiagram,
    newNote,
    closeActiveTab,
    openSearch,
    openQuickOpen,
    showView,
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
