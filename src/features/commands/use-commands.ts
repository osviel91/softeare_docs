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
import type { DiagramFile } from "../../domain/workspace/types";
import { createCommandRegistry, type Command, type CommandRegistry } from "./command";

/** The app state the command registry is built from. */
export interface CommandContext {
  /** Create an empty diagram in a project; resolves to the file or `null`. */
  createEmptyDiagram: (projectId: string) => Promise<DiagramFile | null>;
  /** The currently selected project id, or `null` when none is selected. */
  selectedProjectId: string | null;
  /** Open (or activate) a tab for a diagram and show its source. */
  openDiagram: (diagram: DiagramFile) => void;
  /** Close the active tab (no-op when there is no active tab). */
  closeActiveTab: () => void;
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
  selectedProjectId,
  openDiagram,
  closeActiveTab,
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

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: "new-diagram", label: "New Diagram", execute: newDiagram },
      { id: "close-tab", label: "Close Tab", execute: closeActiveTab },
    ];

    // A folder command only makes sense when the API is available. Folder open
    // implies support, so guard both branches on it. When a folder is open,
    // offer to close it; otherwise offer to open one.
    if (folderSupported && !folderOpen) {
      list.push({ id: "open-folder", label: "Open Folder…", execute: openFolder });
    }
    if (folderSupported && folderOpen) {
      list.push({ id: "close-folder", label: "Close Folder", execute: openFolder });
    }

    return list;
  }, [newDiagram, closeActiveTab, openFolder, folderOpen, folderSupported]);

  return createCommandRegistry(commands);
}
