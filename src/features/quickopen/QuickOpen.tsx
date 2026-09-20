/**
 * Quick Open overlay (Cmd/Ctrl+P).
 *
 * A modal sibling of {@link CommandPalette} and {@link SearchPanel}: an input
 * ranks a flat list of {@link QuickOpenItem}s by fuzzy match and the user opens
 * one with Enter, the arrow keys, or a click. The component is a pure function
 * of its props — it owns only the transient query and the highlighted row — so
 * it can be unit-tested against any item list, with no workspace and no
 * repository. Picking reports the item to the shell, which opens the resource it
 * names and dismisses the overlay.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { rankItems, type QuickOpenItem } from "./quick-open-model";

export interface QuickOpenProps {
  /** The items to rank: resources, symbols and headings, in browse order. */
  items: QuickOpenItem[];
  /** Called with the chosen item; the shell opens the resource it names. */
  onPick: (item: QuickOpenItem) => void;
  /** Dismiss the overlay without picking anything. */
  onClose: () => void;
}

/**
 * Render `label` with the matched characters wrapped in `<mark>`.
 *
 * `positions` index the item's `search` string, which begins with `label`, so
 * positions at or past `label.length` belong to `detail` and are dropped: only
 * characters actually shown in the label are highlighted.
 */
function highlightLabel(label: string, positions: number[]): ReactNode {
  const marked = new Set(
    positions.filter((position) => position >= 0 && position < label.length),
  );
  if (marked.size === 0) return label;

  const nodes: ReactNode[] = [];
  let plain = "";
  for (let index = 0; index < label.length; index += 1) {
    if (!marked.has(index)) {
      plain += label[index];
      continue;
    }
    if (plain !== "") {
      nodes.push(plain);
      plain = "";
    }
    // Coalesce a run of matched characters into one <mark> so the highlight
    // reads as a word rather than a string of single letters.
    let run = label[index];
    while (index + 1 < label.length && marked.has(index + 1)) {
      index += 1;
      run += label[index];
    }
    nodes.push(<mark key={index}>{run}</mark>);
  }
  if (plain !== "") nodes.push(plain);
  return nodes;
}

export default function QuickOpen({ items, onPick, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = rankItems(items, query);

  // Keep the selection clamped to the current result list as it shrinks.
  useEffect(() => {
    setSelectedIndex((index) =>
      Math.max(0, Math.min(index, Math.max(0, results.length - 1))),
    );
  }, [results]);

  // Focus the input on mount and refocus whenever the query clears.
  useEffect(() => {
    inputRef.current?.focus();
  }, [query]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setSelectedIndex((index) => (index + 1) % Math.max(1, results.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        setSelectedIndex(
          (index) => (index - 1 + results.length) % Math.max(1, results.length),
        );
        break;
      case "Enter":
        event.preventDefault();
        {
          // With no results `results[0]` is undefined, so Enter is a no-op.
          const chosen = results[selectedIndex];
          if (chosen) onPick(chosen.item);
        }
        break;
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      case "Tab":
        // Move focus out of the overlay (e.g. back to the editor) and close.
        event.preventDefault();
        onClose();
        break;
    }
  };

  const trimmed = query.trim();

  return (
    <div
      className="palette-overlay"
      data-testid="quick-open"
      role="dialog"
      aria-modal="true"
      aria-label="Quick open"
      onMouseDown={(event) => {
        // Clicking the backdrop (not the panel) dismisses the overlay.
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          data-testid="quick-open-input"
          type="text"
          placeholder="Go to diagram, document, symbol or heading…"
          aria-label="Quick open"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          autoFocus
        />
        <ul
          className="palette__list"
          role="listbox"
          aria-label="Quick open results"
        >
          {results.length === 0 ? (
            <li
              className="palette__empty"
              data-testid="quick-open-empty"
              role="option"
            >
              {trimmed === ""
                ? "Nothing to open."
                : `No matches for “${trimmed}”.`}
            </li>
          ) : (
            results.map(({ item, positions }, index) => (
              <li
                key={item.id}
                role="option"
                aria-selected={index === selectedIndex}
              >
                <button
                  type="button"
                  className={`palette__item${
                    index === selectedIndex ? " palette__item--active" : ""
                  }`}
                  data-testid="quick-open-item"
                  aria-label={
                    item.detail ? `${item.label} ${item.detail}` : item.label
                  }
                  onClick={() => onPick(item)}
                >
                  <span className="quick-open__group">{item.group}</span>
                  <span
                    className="quick-open__label"
                    data-testid="quick-open-item-label"
                  >
                    {highlightLabel(item.label, positions)}
                  </span>
                  {item.detail ? (
                    <span className="quick-open__detail">{item.detail}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="palette__footer">
          <span className="palette__hint">
            ↑↓ navigate · Enter open · Esc close
          </span>
          <span className="palette__hint" data-testid="quick-open-count">
            {results.length} {results.length === 1 ? "result" : "results"}
          </span>
        </div>
      </div>
    </div>
  );
}
