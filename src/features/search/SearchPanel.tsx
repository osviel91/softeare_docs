/**
 * Project search overlay.
 *
 * A modal find-in-files panel over the workspace's documents: an input takes the
 * query and the result list shows each hit with its project, document, line and
 * the matching line of text. The component owns none of that state — the query
 * and the matches come from {@link useProjectSearch} and opening a hit is
 * reported to the App, which loads the document and puts the caret on the match.
 *
 * It is a pure function of its props, so it can be unit-tested against a fixed
 * list of matches without a workspace.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SearchMatch } from "../../domain/search/project-search";

export interface SearchPanelProps {
  /** The raw query typed by the user. */
  query: string;
  /** Called with the new query on every keystroke. */
  onQueryChange: (value: string) => void;
  /** The matches for the current query, in source order. */
  matches: SearchMatch[];
  /** Open the document a match belongs to and reveal the match. */
  onOpenMatch: (match: SearchMatch) => void;
  /** Dismiss the overlay. */
  onClose: () => void;
}

/** The glyph shown before a result, naming its document kind. */
function kindGlyph(match: SearchMatch): string {
  return match.kind === "note" ? "¶" : "▦";
}

export default function SearchPanel({
  query,
  onQueryChange,
  matches,
  onOpenMatch,
  onClose,
}: SearchPanelProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the highlighted row inside the current result list as it shrinks.
  useEffect(() => {
    setSelectedIndex((index) =>
      Math.max(0, Math.min(index, Math.max(0, matches.length - 1))),
    );
  }, [matches]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [query]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setSelectedIndex((index) => (index + 1) % Math.max(1, matches.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setSelectedIndex(
          (index) => (index - 1 + matches.length) % Math.max(1, matches.length),
        );
        break;
      case "Enter": {
        event.preventDefault();
        const chosen = matches[selectedIndex];
        if (chosen) onOpenMatch(chosen);
        break;
      }
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      default:
        break;
    }
  };

  const trimmed = query.trim();

  return (
    <div
      className="palette-overlay"
      data-testid="search-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Search project"
      onMouseDown={(event) => {
        // Clicking the backdrop (not the panel) dismisses the overlay.
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        className="palette search"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          data-testid="search-input"
          type="search"
          placeholder="Search project… (tag:payments, type:diagram, project:name)"
          aria-label="Search project"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setSelectedIndex(0);
          }}
          autoFocus
        />

        <ul
          className="palette__list"
          role="listbox"
          aria-label="Search results"
        >
          {trimmed === "" ? (
            <li className="palette__empty" data-testid="search-hint">
              Type to search every diagram and document in the workspace.
            </li>
          ) : matches.length === 0 ? (
            <li className="palette__empty" data-testid="search-empty">
              No matches for “{trimmed}”.
            </li>
          ) : (
            matches.map((match, index) => (
              <li
                key={`${match.kind}:${match.id}:${match.offset}`}
                role="option"
                aria-selected={index === selectedIndex}
                data-testid="search-result"
              >
                <button
                  type="button"
                  className={`palette__item search__result${
                    index === selectedIndex ? " palette__item--active" : ""
                  }`}
                  data-testid="search-result-button"
                  aria-label={`${match.title} line ${match.line}`}
                  onClick={() => onOpenMatch(match)}
                >
                  <span className="search__result-head">
                    <span className="search__result-icon" aria-hidden="true">
                      {kindGlyph(match)}
                    </span>
                    <span className="search__result-title">{match.title}</span>
                    <span className="search__result-where">
                      {match.projectName} · {match.name}:{match.line}
                    </span>
                  </span>
                  <span className="search__result-excerpt">
                    {match.excerpt}
                  </span>
                  {match.metadata?.tags &&
                    match.metadata.tags.length > 0 &&
                    match.matchedFields.includes("tags") && (
                      <span className="search__result-excerpt">
                        Tags: {match.metadata.tags.join(", ")}
                      </span>
                    )}
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="palette__footer">
          <span className="palette__hint" data-testid="search-count">
            {trimmed === ""
              ? "↑↓ navigate · Enter open · Esc close"
              : `${matches.length} match${matches.length === 1 ? "" : "es"}`}
          </span>
        </div>
      </div>
    </div>
  );
}
