/**
 * The documentation page.
 *
 * The reference used to be one option in the editor pane's segmented control,
 * which put it between "Overview" and "History" — a panel you glance at while
 * editing. It is not that: it is reference material about the tools themselves
 * (the two diagram languages, every command, and the MCP server), and it keeps
 * growing. So it is a page of its own, with room for sections, reachable from
 * the toolbar, the command palette, or `mod+alt+D`.
 *
 * Only the active section is mounted, which keeps the page cheap and makes each
 * section a component that can grow on its own.
 */
import { useState } from "react";
import CommandsReference from "./CommandsReference";
import DslReference from "./DslReference";
import McpReference from "./McpReference";

/** The id of one documentation section. */
export type DocsSectionId = "languages" | "commands" | "mcp";

/** One entry in the page's section navigation. */
interface DocsSection {
  id: DocsSectionId;
  label: string;
  hint: string;
}

/** The sections, in reading order. */
const SECTIONS: DocsSection[] = [
  {
    id: "languages",
    label: "Diagram languages",
    hint: "The sequence and event-flow constructs",
  },
  {
    id: "commands",
    label: "Commands",
    hint: "Every action and its shortcut",
  },
  {
    id: "mcp",
    label: "MCP server",
    hint: "Let a coding agent document your project",
  },
];

/** Props for {@link DocsPage}. */
export interface DocsPageProps {
  /** Leave the page and return to the workspace. */
  onBack: () => void;
}

export default function DocsPage({ onBack }: DocsPageProps) {
  const [section, setSection] = useState<DocsSectionId>("languages");

  return (
    <main
      className="docspage"
      data-testid="docs-page"
      aria-label="Documentation"
    >
      <header className="docspage__header">
        <div className="docspage__heading">
          <p className="docspage__eyebrow">Documentation</p>
          <h1 className="docspage__title">Languages, commands and agents</h1>
          <p className="docspage__lead">
            Everything the editor can do: the two diagram languages it parses
            and draws, every command and the chord that runs it, and the MCP
            server that lets a coding agent write this documentation with you.
          </p>
        </div>
        <button
          type="button"
          className="button docspage__back"
          data-testid="docs-back"
          onClick={onBack}
        >
          ← Back to workspace
        </button>
      </header>

      <div className="docspage__body">
        <nav
          className="docspage__nav"
          role="tablist"
          aria-label="Documentation sections"
        >
          {SECTIONS.map((entry) => {
            const active = section === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`docs-tab-${entry.id}`}
                aria-selected={active}
                className={`docspage__nav-item${
                  active ? " docspage__nav-item--active" : ""
                }`}
                data-testid={`docs-nav-${entry.id}`}
                onClick={() => setSection(entry.id)}
              >
                <span className="docspage__nav-label">{entry.label}</span>
                <span className="docspage__nav-hint">{entry.hint}</span>
              </button>
            );
          })}
        </nav>

        <article
          className="docspage__content"
          role="tabpanel"
          aria-labelledby={`docs-tab-${section}`}
          data-testid={`docs-content-${section}`}
        >
          {section === "languages" ? <DslReference /> : null}
          {section === "commands" ? <CommandsReference /> : null}
          {section === "mcp" ? <McpReference /> : null}
        </article>
      </div>
    </main>
  );
}
