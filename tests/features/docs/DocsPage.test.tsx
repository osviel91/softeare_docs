import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  COMMAND_CATALOG,
  COMMAND_CATEGORIES,
} from "../../../src/features/commands/command-catalog";
import { bindingLabel } from "../../../src/features/commands/shortcuts";
import DocsPage from "../../../src/features/docs/DocsPage";

describe("DocsPage", () => {
  it("opens on the diagram languages", () => {
    render(<DocsPage onBack={vi.fn()} />);

    expect(screen.getByTestId("docs-page")).toBeInTheDocument();
    expect(screen.getByTestId("dsl-reference")).toBeInTheDocument();
    expect(screen.queryByTestId("commands-reference")).toBeNull();
    expect(screen.queryByTestId("mcp-reference")).toBeNull();
  });

  it("switches sections from the navigation", () => {
    render(<DocsPage onBack={vi.fn()} />);

    fireEvent.click(screen.getByTestId("docs-nav-commands"));
    expect(screen.getByTestId("commands-reference")).toBeInTheDocument();
    expect(screen.queryByTestId("dsl-reference")).toBeNull();
    expect(screen.getByTestId("docs-nav-commands")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByTestId("docs-nav-mcp"));
    expect(screen.getByTestId("mcp-reference")).toBeInTheDocument();
    expect(screen.queryByTestId("commands-reference")).toBeNull();
    expect(screen.getByTestId("docs-nav-languages")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("documents every catalog command with its shortcut", () => {
    render(<DocsPage onBack={vi.fn()} />);
    fireEvent.click(screen.getByTestId("docs-nav-commands"));

    for (const spec of COMMAND_CATALOG) {
      const entry = screen.getByTestId(`command-${spec.id}`);
      expect(entry).toHaveTextContent(spec.label);
      expect(entry).toHaveTextContent(bindingLabel(spec.binding));
    }
    for (const category of COMMAND_CATEGORIES) {
      expect(
        screen.getByTestId(`commands-group-${category.toLowerCase()}`),
      ).toBeInTheDocument();
    }
  });

  it("describes the MCP server and how to connect a client", () => {
    render(<DocsPage onBack={vi.fn()} />);
    fireEvent.click(screen.getByTestId("docs-nav-mcp"));

    const page = screen.getByTestId("mcp-reference");
    expect(page).toHaveTextContent("npm run mcp:build");
    expect(page).toHaveTextContent("mcpServers");
    expect(page).toHaveTextContent("delete_resource");
  });

  it("leaves the page through the header button", () => {
    const onBack = vi.fn();
    render(<DocsPage onBack={onBack} />);

    fireEvent.click(screen.getByTestId("docs-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
