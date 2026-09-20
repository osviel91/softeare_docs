/**
 * Tests for the static documentation site generator.
 *
 * The generator's contract is mostly about *structure*: which files appear, what
 * a page links to, and that two runs agree byte for byte. So the assertions here
 * are targeted string checks and, where link routing is the point, a `DOMParser`
 * walk — never a snapshot of a whole document, which would break on any styling
 * tweak while proving nothing about the behaviour under test.
 */
import { describe, expect, it } from "vitest";
import type {
  DiagramDescriptor,
  DocumentDescriptor,
  ProjectDiagnostic,
  ProjectIndex,
  ResourceDescriptor,
} from "../../../../src/domain/project/project-index";
import {
  buildDocumentationSite,
  documentPagePath,
  relativeHref,
  siteSlug,
  SITE_LAYOUT,
  uniqueSlugs,
  type SiteExportInput,
  type SiteFile,
} from "../../../../src/features/export/site/site-model";

/** A diagram renderer that returns a recognisable but minimal SVG. */
function svgFor(id: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" data-diagram="${id}"><title>${id}</title><line x1="0" y1="0" x2="1" y2="1"/></svg>`;
}

/** A markdown document descriptor. */
function doc(
  id: string,
  path: string,
  title: string,
  headings: DocumentDescriptor["headings"] = [],
): DocumentDescriptor {
  return {
    id,
    projectId: "p1",
    path,
    type: "markdown-document",
    title,
    headings,
    words: 12,
  };
}

/** A diagram descriptor. */
function diagram(id: string, path: string, title: string): DiagramDescriptor {
  return {
    id,
    projectId: "p1",
    path,
    type: "sequence-diagram",
    title,
    participants: 2,
    messages: 3,
    titled: true,
  };
}

/** An index assembled from the descriptors under test. */
function indexOf(
  documents: DocumentDescriptor[],
  diagrams: DiagramDescriptor[],
  diagnostics: ProjectDiagnostic[] = [],
): ProjectIndex {
  const resources: ResourceDescriptor[] = [...documents, ...diagrams];
  return {
    projectId: "p1",
    resources,
    diagrams,
    eventFlows: [],
    documents,
    participants: [],
    usages: [],
    references: [],
    diagnostics,
  };
}

/** Build an input from descriptors and contents, with all diagrams rendering. */
function inputOf(options: {
  projectName?: string;
  documents?: DocumentDescriptor[];
  diagrams?: DiagramDescriptor[];
  contents?: Record<string, string>;
  diagnostics?: ProjectDiagnostic[];
  renderDiagram?: (resourceId: string) => string | null;
  theme?: "light" | "dark";
}): SiteExportInput {
  const documents = options.documents ?? [];
  const diagrams = options.diagrams ?? [];
  return {
    projectName: options.projectName ?? "Demo Project",
    index: indexOf(documents, diagrams, options.diagnostics ?? []),
    contents: new Map(Object.entries(options.contents ?? {})),
    renderDiagram: options.renderDiagram ?? svgFor,
    theme: options.theme,
  };
}

/** The generated file at `path`, or a failure naming what was available. */
function fileAt(files: SiteFile[], path: string): SiteFile {
  const file = files.find((entry) => entry.path === path);
  if (!file) {
    throw new Error(
      `expected "${path}" in [${files.map((entry) => entry.path).join(", ")}]`,
    );
  }
  return file;
}

/** The text of one generated file. */
function textAt(files: SiteFile[], path: string): string {
  return new TextDecoder().decode(fileAt(files, path).data);
}

/** A parsed document, for checking link targets rather than markup. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** The href of the first anchor whose text matches `label`. */
function hrefOf(document: Document, label: string): string | null {
  for (const anchor of document.querySelectorAll("a")) {
    if (anchor.textContent?.trim() === label)
      return anchor.getAttribute("href");
  }
  return null;
}

describe("siteSlug", () => {
  it("derives a lowercase, hyphenated name from the title", () => {
    expect(siteSlug("Payment Processing", "payment.seq")).toBe(
      "payment-processing",
    );
  });

  it("falls back to the path when the title has nothing sluggable", () => {
    expect(siteSlug("!!!", "docs/Getting Started.md")).toBe(
      "docs-getting-started",
    );
  });

  it("falls back to the supplied name when neither is usable", () => {
    expect(siteSlug("", "", "diagram-checkout")).toBe("diagram-checkout");
  });
});

describe("uniqueSlugs", () => {
  it("appends a counter on collision and stays stable across runs", () => {
    const slugs = uniqueSlugs(["a", "b", "c"], () => "same");
    expect([...slugs.values()]).toEqual(["same", "same-2", "same-3"]);
  });

  it("shares one namespace through the `taken` set", () => {
    const taken = new Set<string>();
    const documents = uniqueSlugs(["d1"], () => "shared", taken);
    const diagrams = uniqueSlugs(["g1"], () => "shared", taken);
    expect(documents.get("d1")).toBe("shared");
    expect(diagrams.get("g1")).toBe("shared-2");
  });
});

describe("relativeHref", () => {
  it("walks up from a nested page to the site root", () => {
    expect(relativeHref("docs/a.html", "index.html")).toBe("../index.html");
    expect(relativeHref("index.html", "docs/a.html")).toBe("docs/a.html");
    expect(relativeHref("docs/a.html", "diagrams/b.html")).toBe(
      "../diagrams/b.html",
    );
  });

  it("keeps a fragment and links siblings without a prefix", () => {
    expect(relativeHref("docs/a.html", "docs/b.html#top")).toBe("b.html#top");
  });
});

describe("buildDocumentationSite", () => {
  it("generates one page per document and diagram plus the shell files", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [
          doc("d1", "docs/architecture.md", "Architecture"),
          doc("d2", "docs/decisions.md", "Decisions"),
        ],
        diagrams: [diagram("g1", "diagrams/checkout.seq", "Checkout")],
      }),
    );

    expect(files.map((file) => file.path)).toEqual([
      "diagrams/checkout.html",
      "diagrams/checkout.svg",
      "docs/architecture.html",
      "docs/decisions.html",
      "events.html",
      "index.html",
      "styles/site.css",
    ]);
  });

  it("puts the rendered markdown on the document page", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [doc("d1", "architecture.md", "Architecture")],
        contents: {
          d1: "# Architecture\n\nThe **checkout** flow is documented here.",
        },
      }),
    );

    const html = textAt(files, documentPagePath("architecture"));
    expect(html).toContain("<strong>checkout</strong>");
    expect(html).toContain("The ");
  });

  it("puts the SVG on the diagram page and in the raw .svg file", () => {
    const files = buildDocumentationSite(
      inputOf({
        diagrams: [diagram("g1", "checkout.seq", "Checkout")],
      }),
    );

    expect(textAt(files, "diagrams/checkout.html")).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" data-diagram="g1">',
    );
    expect(textAt(files, "diagrams/checkout.svg")).toContain(
      'data-diagram="g1"',
    );
    expect(fileAt(files, "diagrams/checkout.svg").type).toBe("image/svg+xml");
  });

  it("renders a {{diagram:id}} embed as a figure with the SVG", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [doc("d1", "guide.md", "Guide")],
        diagrams: [diagram("g1", "checkout.seq", "Checkout")],
        contents: { d1: "# Guide\n\nHere it is:\n\n{{diagram:g1}}\n\nDone." },
      }),
    );

    const html = textAt(files, documentPagePath("guide"));
    expect(html).toContain('<figure class="embed">');
    expect(html).toContain('data-diagram="g1"');
    expect(html).toContain("<figcaption");
    // The directive itself never leaks into the output.
    expect(html).not.toContain("{{diagram:g1}}");
  });

  it("embeds the SVG inline rather than a link to it", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [doc("d1", "guide.md", "Guide")],
        diagrams: [diagram("g1", "checkout.seq", "Checkout")],
        contents: { d1: "{{diagram:g1}}" },
      }),
    );

    const document = parse(textAt(files, documentPagePath("guide")));
    const figure = document.querySelector("figure.embed");
    expect(figure?.querySelector("svg")).not.toBeNull();
    expect(hrefOf(document, "open diagram page")).toBe(
      "../diagrams/checkout.html",
    );
  });

  it("names a missing embed target instead of leaving a gap", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [doc("d1", "guide.md", "Guide")],
        contents: { d1: "{{diagram:does-not-exist}}" },
      }),
    );

    const html = textAt(files, documentPagePath("guide"));
    expect(html).toContain("embed--missing");
    expect(html).toContain("does-not-exist");
  });

  it("names an unrenderable diagram instead of leaving a gap", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [doc("d1", "guide.md", "Guide")],
        diagrams: [diagram("g1", "checkout.seq", "Checkout")],
        contents: { d1: "{{diagram:g1}}" },
        renderDiagram: () => null,
      }),
    );

    const html = textAt(files, documentPagePath("guide"));
    expect(html).toContain("embed--missing");
    expect(html).toContain("Checkout");
    expect(html).not.toContain("<svg");
  });

  it("rewrites a resource:// link to a relative href of the right page", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [
          doc("d1", "docs/guide.md", "Guide"),
          doc("d2", "docs/spec.md", "Spec"),
        ],
        contents: { d1: "See [the spec](resource://d2)." },
      }),
    );

    const document = parse(textAt(files, documentPagePath("guide")));
    expect(hrefOf(document, "the spec")).toBe("spec.html");
  });

  it("rewrites wiki-links, scheme links and relative links", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [
          doc("d1", "docs/guide.md", "Guide"),
          doc("d2", "docs/spec.md", "Spec"),
        ],
        diagrams: [diagram("g1", "diagrams/checkout.seq", "Checkout")],
        contents: {
          d1: [
            "[[Spec]]",
            "[checkout](diagram://g1)",
            "[spec](../docs/spec.md)",
          ].join("\n\n"),
        },
      }),
    );

    const document = parse(textAt(files, documentPagePath("guide")));
    expect(hrefOf(document, "Spec")).toBe("spec.html");
    expect(hrefOf(document, "checkout")).toBe("../diagrams/checkout.html");
    expect(hrefOf(document, "spec")).toBe("spec.html");
    // The project was re-rooted, so the marker the editor uses for in-app
    // navigation is replaced by a real relative href.
    const marked = [...document.querySelectorAll("a[data-resource-link]")];
    expect(marked.map((anchor) => anchor.getAttribute("href"))).toEqual([
      "../diagrams/checkout.html",
      "spec.html",
    ]);
  });

  it("marks an unresolved link as visibly broken", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [doc("d1", "docs/guide.md", "Guide")],
        contents: {
          d1: [
            "[[Nowhere]]",
            "[gone](resource://missing)",
            "[x](missing.md)",
          ].join("\n\n"),
        },
      }),
    );

    const document = parse(textAt(files, documentPagePath("guide")));
    const broken = [...document.querySelectorAll("a.broken")];
    expect(broken).toHaveLength(3);
    for (const anchor of broken) {
      expect(anchor.getAttribute("href")).toBe("#");
      expect(anchor.getAttribute("title")).toContain("Unresolved link");
    }
    expect(
      broken.some((anchor) =>
        anchor.getAttribute("title")?.includes("Nowhere"),
      ),
    ).toBe(true);
  });

  it("keeps a web link pointing at the web", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [doc("d1", "guide.md", "Guide")],
        contents: { d1: "[docs](https://example.com/x)" },
      }),
    );

    const document = parse(textAt(files, documentPagePath("guide")));
    const anchor = document.querySelector('a[href^="https:"]');
    expect(anchor?.getAttribute("href")).toBe("https://example.com/x");
    expect(anchor?.classList.contains("broken")).toBe(false);
  });

  it("escapes titles and paths that contain markup", () => {
    const hostile = "<script>alert(1)</script>";
    const files = buildDocumentationSite(
      inputOf({
        projectName: hostile,
        documents: [doc("d1", "docs/<b>.md", hostile)],
        diagrams: [diagram("g1", "bad.seq", hostile)],
        contents: { d1: `# ${hostile}\n\nBody.` },
      }),
    );

    for (const file of files) {
      if (!file.type.startsWith("text/")) continue;
      const text = new TextDecoder().decode(file.data);
      expect(text).not.toContain(hostile);
    }
    expect(textAt(files, "index.html")).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("still produces a valid index and stylesheet for an empty project", () => {
    const files = buildDocumentationSite(inputOf({}));

    expect(files.map((file) => file.path)).toEqual([
      "events.html",
      "index.html",
      "styles/site.css",
    ]);
    const index = parse(textAt(files, SITE_LAYOUT.index));
    expect(index.querySelector("h1")?.textContent).toBe("Demo Project");
    // Nothing to list, so the nav says so instead of rendering empty markup.
    expect(
      [...index.querySelectorAll(".nav-empty")].map((item) => item.textContent),
    ).toEqual(["None", "None"]);
    expect(index.querySelector(".empty-state")?.textContent).toContain(
      "no documents yet",
    );
    expect(
      index.querySelector("link[rel=stylesheet]")?.getAttribute("href"),
    ).toBe("styles/site.css");
    expect(textAt(files, SITE_LAYOUT.stylesheet)).toContain(":root");
  });

  it("builds nav links between pages, including from nested pages", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [doc("d1", "docs/guide.md", "Guide")],
        diagrams: [diagram("g1", "checkout.seq", "Checkout")],
      }),
    );

    const document = parse(textAt(files, documentPagePath("guide")));
    expect(hrefOf(document, "Checkout")).toBe("../diagrams/checkout.html");
    expect(hrefOf(document, "Demo Project")).toBe("../index.html");
    expect(document.querySelector(".nav-item--current")?.textContent).toContain(
      "Guide",
    );
  });

  it("keeps an empty group visible instead of a broken nav", () => {
    const files = buildDocumentationSite(
      inputOf({ documents: [doc("d1", "guide.md", "Guide")] }),
    );

    const document = parse(textAt(files, documentPagePath("guide")));
    const groups = [...document.querySelectorAll(".nav-group")].map(
      (group) => ({
        title: group.querySelector(".nav-group__title")?.textContent,
        items: [...group.querySelectorAll(".nav-item")].map((item) => ({
          link: item.querySelector("a")?.textContent?.trim() ?? null,
          detail: item.querySelector(".nav-detail")?.textContent ?? null,
          empty: item.classList.contains("nav-empty"),
        })),
      }),
    );
    expect(groups).toEqual([
      {
        title: "Documents",
        items: [{ link: "Guide", detail: "guide.md", empty: false }],
      },
      {
        title: "Diagrams",
        items: [{ link: null, detail: null, empty: true }],
      },
    ]);
  });

  it("is deterministic and orders files by path", () => {
    const input = () =>
      inputOf({
        documents: [
          doc("d2", "docs/spec.md", "Spec"),
          doc("d1", "docs/guide.md", "Guide"),
        ],
        diagrams: [diagram("g1", "checkout.seq", "Checkout")],
        contents: { d1: "{{diagram:g1}}\n\n[[Spec]]", d2: "# Spec" },
      });

    const first = buildDocumentationSite(input());
    const second = buildDocumentationSite(input());

    expect(first.map((file) => file.path)).toEqual(
      [...first.map((file) => file.path)].sort(),
    );
    expect(first).toHaveLength(second.length);
    first.forEach((file, index) => {
      const other = second[index];
      expect(other.path).toBe(file.path);
      expect(Array.from(other.data)).toEqual(Array.from(file.data));
    });
  });

  it("assigns distinct page slugs to same-titled documents", () => {
    const files = buildDocumentationSite(
      inputOf({
        documents: [
          doc("d1", "a/architecture.md", "Architecture"),
          doc("d2", "b/architecture.md", "Architecture"),
        ],
      }),
    );

    const pages = files
      .filter((file) => file.type === "text/html")
      .map((file) => file.path)
      .filter((path) => path.startsWith("docs/"));
    expect(pages).toEqual([
      "docs/architecture-2.html",
      "docs/architecture.html",
    ]);
  });

  it("themes the pages and honours dark mode", () => {
    const files = buildDocumentationSite(inputOf({ theme: "dark" }));
    expect(textAt(files, SITE_LAYOUT.index)).toContain('data-theme="dark"');
    expect(textAt(files, SITE_LAYOUT.stylesheet)).toContain(
      '[data-theme="dark"]',
    );
  });

  it("makes every internal link on every page resolve to a generated file", () => {
    const files = buildDocumentationSite(
      inputOf({
        projectName: "Link Check",
        documents: [
          doc("d1", "docs/guide.md", "Guide"),
          doc("d2", "spec.md", "Spec"),
        ],
        diagrams: [diagram("g1", "diagrams/checkout.seq", "Checkout")],
        contents: {
          d1: [
            "# Guide",
            "",
            "[[Spec]] and [self](resource://d1) and [up](../spec.md).",
            "",
            "{{diagram:g1}}",
          ].join("\n"),
        },
      }),
    );

    const paths = new Set(files.map((file) => file.path));
    // A browser resolves a relative href against the page's own directory; this
    // does the same for every href the pages carry, and fails on the first one
    // that names no generated file.
    const resolvedPaths: string[] = [];
    for (const file of files) {
      if (file.type !== "text/html") continue;
      const html = new TextDecoder().decode(file.data);
      const directory = file.path.split("/").slice(0, -1);
      for (const match of html.matchAll(/ href="([^"]+)"/g)) {
        const href = match[1];
        if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const segments = [...directory, ...href.split("#")[0].split("/")];
        const parts: string[] = [];
        for (const segment of segments) {
          if (segment === "" || segment === ".") continue;
          if (segment === "..") parts.pop();
          else parts.push(segment);
        }
        resolvedPaths.push(`${file.path} -> ${parts.join("/")}`);
        expect(paths.has(parts.join("/")), `${file.path} links ${href}`).toBe(
          true,
        );
      }
    }
    // Sanity: the walk actually saw links (nav, markdown and the embed caption).
    expect(resolvedPaths.length).toBeGreaterThan(15);
  });
});
