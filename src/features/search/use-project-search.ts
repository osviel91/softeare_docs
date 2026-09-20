/**
 * Project search controller.
 *
 * Owns the search overlay's open state and query, and derives the matches. The
 * document set is built lazily: `buildDocuments` is only called while the overlay
 * is open, so editing a diagram never pays for indexing the whole workspace.
 *
 * The global shortcut is Ctrl/Cmd+Shift+F (the familiar "find in files"), and
 * Esc closes the overlay.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  runSearch,
  type SearchDocument,
  type SearchMatch,
} from "../../domain/search/project-search";

/** The state and actions the App needs to render the search overlay. */
export interface ProjectSearchController {
  /** Whether the search overlay is shown. */
  isOpen: boolean;
  /** The raw query typed into the overlay. */
  query: string;
  /** The matches for the current query, in source order. */
  matches: SearchMatch[];
  /** Show the overlay (also bound to Ctrl/Cmd+Shift+F). */
  open: () => void;
  /** Hide the overlay. */
  close: () => void;
  /** Replace the query. */
  setQuery: (value: string) => void;
}

/**
 * Manage the project search overlay.
 *
 * @param buildDocuments - Builds the searchable set. Called only while the
 *   overlay is open; the caller should keep its identity stable so the set is
 *   rebuilt only when the workspace itself changes.
 */
export function useProjectSearch(
  buildDocuments: () => SearchDocument[],
): ProjectSearchController {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        setIsOpen(true);
        return;
      }
      if (event.key === "Escape") setIsOpen(false);
    }

    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, []);

  // Index only while the panel is visible. The query is not a dependency, so
  // typing re-scans the same documents instead of rebuilding them.
  const documents = useMemo(
    () => (isOpen ? buildDocuments() : []),
    [isOpen, buildDocuments],
  );

  const matches = useMemo(
    () => runSearch(documents, query),
    [documents, query],
  );

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return { isOpen, query, matches, open, close, setQuery };
}
