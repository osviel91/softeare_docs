/**
 * A small project shared by the site export tests.
 *
 * Kept as a plain module (not a `.test.ts`) so both test files can build the
 * same project without either owning it. It deliberately contains one markdown
 * document, one diagram, a relative link, an embed, a wiki-link to a missing
 * resource and two diagnostics — enough structure for the generator's link
 * routing, nav grouping and problems report to be exercised for real.
 */
import type {
  DiagramDescriptor,
  DocumentDescriptor,
  ProjectDiagnostic,
  ProjectIndex,
  ResourceDescriptor,
} from "../../../../src/domain/project/project-index";
import type { SiteExportInput } from "../../../../src/features/export/site/site-model";

/** The document the fixture's markdown lives in. */
export const fixtureDocument: DocumentDescriptor = {
  id: "doc-guide",
  projectId: "p1",
  path: "docs/guide.md",
  type: "markdown-document",
  title: "Guide",
  headings: [{ level: 2, text: "Getting started", line: 3 }],
  words: 42,
};

/** The fixture's diagram. */
export const fixtureDiagram: DiagramDescriptor = {
  id: "diagram-checkout",
  projectId: "p1",
  path: "diagrams/checkout.seq",
  type: "sequence-diagram",
  title: "Checkout",
  participants: 3,
  messages: 4,
  titled: true,
};

/** A deterministic SVG stand-in for the real renderer. */
export const FIXTURE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" data-diagram="checkout"><title>Checkout</title></svg>';

/** The markdown the fixture document holds. */
export const FIXTURE_MARKDOWN = [
  "# Guide",
  "",
  "## Getting started",
  "",
  "Read [the spec](resource://doc-guide) or [[Checkout]].",
  "",
  "{{diagram:diagram-checkout}}",
].join("\n");

/** Two diagnostics, one of each reported severity. */
export const FIXTURE_DIAGNOSTICS: ProjectDiagnostic[] = [
  {
    severity: "error",
    code: "project.broken-reference",
    message: 'Broken reference "resource://missing" does not resolve',
    resourceId: "doc-guide",
    sourceRange: {
      start: { line: 3, column: 1 },
      end: { line: 3, column: 10 },
    },
  },
  {
    severity: "warning",
    code: "project.unresolved-link",
    message: 'Link "missing.md" does not match any project resource',
    resourceId: "diagram-checkout",
  },
];

/** The fixture project's index. */
export function fixtureIndex(): ProjectIndex {
  const resources: ResourceDescriptor[] = [fixtureDocument, fixtureDiagram];
  return {
    projectId: "p1",
    resources,
    diagrams: [fixtureDiagram],
    documents: [fixtureDocument],
    participants: [],
    usages: [],
    references: [],
    diagnostics: FIXTURE_DIAGNOSTICS,
  };
}

/** The generator input for the fixture project. */
export function fixtureInput(): SiteExportInput {
  return {
    projectName: "Fixture Project",
    index: fixtureIndex(),
    contents: new Map([[fixtureDocument.id, FIXTURE_MARKDOWN]]),
    renderDiagram: (resourceId) =>
      resourceId.startsWith("diagram-") ? FIXTURE_SVG : null,
  };
}

/** Parse generated HTML, for checking links rather than markup. */
export function parseSite(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}
