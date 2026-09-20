/**
 * Tests for the shell-facing documentation-site export.
 *
 * The wrapper's contract is narrow: it must pass the caller's options through to
 * the generator, describe what was written without disagreeing with the file
 * list, and hand back bytes a ZIP writer can consume as-is. These tests check
 * exactly that, using the shared fixtures in `site-fixtures.ts` so the wrapper
 * and the generator are exercised against the same project.
 */
import { describe, expect, it } from "vitest";
import {
  exportDocumentationSite,
  type SiteExportOptions,
} from "../../../../src/features/export/site/site-export";
import { SITE_LAYOUT } from "../../../../src/features/export/site/site-model";
import { createZip } from "../../../../src/workspace/transfer/zip";
import { fixtureInput, parseSite } from "./site-fixtures";

/** The generated HTML at `path`, parsed. */
function page(path: string, options?: SiteExportOptions): Document {
  const { files } = exportDocumentationSite(fixtureInput(), options);
  const file = files.find((entry) => entry.path === path);
  if (!file) throw new Error(`no file at ${path}`);
  return parseSite(new TextDecoder().decode(file.data));
}

describe("exportDocumentationSite", () => {
  it("counts the pages, SVGs and stylesheet it wrote", () => {
    const { files, summary } = exportDocumentationSite(fixtureInput());

    const html = files.filter((file) => file.type === "text/html");
    const svg = files.filter((file) => file.type === "image/svg+xml");
    expect(summary).toContain(`${html.length} pages`);
    expect(summary).toContain(`${svg.length} SVG`);
    expect(summary).toContain("1 stylesheet");
    // Four pages: the index, the events placeholder, the document and the
    // diagram; one SVG; one stylesheet.
    expect(summary).toBe("4 pages, 1 SVG, 1 stylesheet");
  });

  it("says `page` and `SVG` in the singular for a one-page kind", () => {
    const { summary, files } = exportDocumentationSite(fixtureInput());
    expect(files).toHaveLength(6);
    expect(summary).not.toContain("1 pages");
    expect(summary).not.toContain("1 SVGs");
  });

  it("pluralizes more than one page or SVG", () => {
    const input = fixtureInput();
    input.index = {
      ...input.index,
      diagrams: [
        ...input.index.diagrams,
        {
          ...input.index.diagrams[0],
          id: "diagram-refund",
          path: "diagrams/refund.seq",
          title: "Refund",
        },
      ],
    };
    const { summary } = exportDocumentationSite(input);
    // Five pages: index, events, the document and two diagrams.
    expect(summary).toBe("5 pages, 2 SVGs, 1 stylesheet");
  });

  it("omits the problems report by default", () => {
    const { files, summary } = exportDocumentationSite(fixtureInput());
    expect(files.map((file) => file.path)).not.toContain("problems.html");
    expect(summary).not.toContain("problems");
  });

  it("adds and links problems.html when asked", () => {
    const { files, summary } = exportDocumentationSite(fixtureInput(), {
      includeProblems: true,
    });

    expect(files.map((file) => file.path)).toContain("problems.html");
    expect(summary).toContain("problems report");

    // Every page links it from the nav, including the nested document page.
    const index = page("index.html", { includeProblems: true });
    const fromIndex = index.querySelector(
      `.nav a[href="${SITE_LAYOUT.problems}"]`,
    );
    expect(fromIndex?.textContent).toBe("Problems");

    const guide = page("docs/guide.html", { includeProblems: true });
    const fromGuide = guide.querySelector('.nav a[href="../problems.html"]');
    expect(fromGuide?.textContent).toBe("Problems");
  });

  it("lists diagnostics with their resource title and 1-based line", () => {
    const problems = page("problems.html", { includeProblems: true });
    expect(problems.body.textContent).toContain("Broken reference");
    expect(problems.body.textContent).toContain("Guide");
    // The diagnostic points at line 4 (source line 3, 0-based).
    expect(problems.body.textContent).toContain("line 4");
    expect(problems.querySelectorAll(".severity--error")).toHaveLength(1);
    expect(problems.querySelectorAll(".severity--warning")).toHaveLength(1);
  });

  it("passes the theme option through to every page", () => {
    const { files } = exportDocumentationSite(fixtureInput(), {
      theme: "dark",
    });
    for (const file of files) {
      if (file.type !== "text/html") continue;
      expect(new TextDecoder().decode(file.data)).toContain(
        'data-theme="dark"',
      );
    }
  });

  it("returns entries a ZIP writer can consume unchanged", () => {
    const { files } = exportDocumentationSite(fixtureInput());
    const zip = createZip(
      files.map((file) => ({ path: file.path, data: file.data })),
    );
    expect(zip.length).toBeGreaterThan(0);
    // Relative, `/`-separated paths and no directory entries: the shape the
    // transfer layer expects.
    for (const file of files) {
      expect(file.path.startsWith("/")).toBe(false);
      expect(file.path).not.toContain("\\");
      expect(file.data.byteLength).toBeGreaterThan(0);
    }
  });

  it("is deterministic across runs", () => {
    const first = exportDocumentationSite(fixtureInput());
    const second = exportDocumentationSite(fixtureInput());
    expect(first.files.map((file) => file.path)).toEqual(
      second.files.map((file) => file.path),
    );
    expect(first.summary).toBe(second.summary);
  });
});
