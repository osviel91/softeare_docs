import { describe, expect, it } from "vitest";
import {
  reconcileMetadata,
  renameResourcePath,
  type ProjectMetadata,
} from "../../../src/domain/workspace/metadata";
import { createProjectIndexer } from "../../../src/domain/project/indexer";
import {
  analyzeResource,
  fingerprintContent,
  inferSymbolRole,
} from "../../../src/domain/project/resource-analysis";
import type { ProjectSourceFile } from "../../../src/domain/project/indexer";
import type { ResourceDescriptor } from "../../../src/domain/project/project-index";
import { ProjectDiagnosticCode } from "../../../src/domain/project/validate";
import { diagramDisplayName } from "../../../src/language/diagram-title";
import { noteDisplayName } from "../../../src/language/markdown/note-title";

const CHECKOUT = [
  "title Checkout",
  "participant CartService",
  "participant PaymentService",
  "participant PaymentDatabase",
  "CartService ->> PaymentService: Authorize",
  "PaymentService ->> PaymentDatabase: Save",
].join("\n");

const ARCHITECTURE = [
  "# Architecture",
  "",
  "See [Checkout](checkout.seq) and [[Checkout]].",
  "",
  "{{diagram:diagram-checkout}}",
  "",
  "A [stable link](diagram://diagram-checkout) and a [broken one](nowhere.seq).",
].join("\n");

const LEGACY = "# Legacy\n\nNothing special.";

/** The resources a test project holds, as the indexer consumes them. */
function sources(): ProjectSourceFile[] {
  const entries: Array<{
    id: string;
    path: string;
    type: ResourceDescriptor["type"];
    content: string;
  }> = [
    {
      id: "diagram-checkout",
      path: "checkout.seq",
      type: "sequence-diagram",
      content: CHECKOUT,
    },
    {
      id: "doc-architecture",
      path: "architecture.md",
      type: "markdown-document",
      content: ARCHITECTURE,
    },
    {
      id: "doc-legacy",
      path: "legacy.md",
      type: "markdown-document",
      content: LEGACY,
    },
  ];
  return entries.map(({ id, path, type, content }) => ({
    descriptor: {
      id,
      projectId: "payments",
      path,
      type,
      title:
        type === "sequence-diagram"
          ? diagramDisplayName(path, content)
          : noteDisplayName(path, content),
    },
    content,
  }));
}

/** The identity record that matches `sources()`. */
function metadata(overrides: ProjectMetadata | null = null): ProjectMetadata {
  if (overrides) return overrides;
  return reconcileMetadata(
    null,
    sources().map((file) => ({
      path: file.descriptor.path,
      type: file.descriptor.type,
      title: file.descriptor.title,
    })),
  ).metadata;
}

/** Build the project view in one shot. */
function index(sourcesOverride = sources(), metadataOverride = metadata()) {
  return createProjectIndexer().update(
    "payments",
    sourcesOverride,
    metadataOverride,
  );
}

describe("analyzeResource", () => {
  it("describes a diagram: title, lifelines, messages", () => {
    const [checkout] = sources();
    const analysis = analyzeResource(checkout.descriptor, checkout.content);
    expect(analysis.descriptor.title).toBe("Checkout");
    expect(analysis.metrics).toEqual({
      participants: 3,
      messages: 2,
      words: 0,
    });
    expect(analysis.symbols.map((symbol) => symbol.name)).toEqual([
      "CartService",
      "PaymentService",
      "PaymentDatabase",
    ]);
    expect(analysis.symbols[0].kind).toBe("participant");
    expect(analysis.symbols[0].sourceRange?.start.line).toBe(1);
  });

  it("infers an architectural role from a lifeline's name", () => {
    const [checkout] = sources();
    const analysis = analyzeResource(checkout.descriptor, checkout.content);
    expect(analysis.symbols.map((symbol) => symbol.role)).toEqual([
      "service",
      "service",
      "database",
    ]);
    expect(inferSymbolRole("EventBus")).toBe("queue");
    expect(inferSymbolRole("User")).toBeUndefined();
  });

  it("describes a document: title, headings, references", () => {
    const [, architecture] = sources();
    const analysis = analyzeResource(
      architecture.descriptor,
      architecture.content,
    );
    expect(analysis.descriptor.title).toBe("Architecture");
    expect(analysis.headings).toEqual([
      { level: 1, text: "Architecture", line: 1 },
    ]);
    expect(analysis.references.map((reference) => reference.kind)).toEqual([
      "resource-link",
      "wiki-link",
      "embed",
      "resource-link",
      "resource-link",
    ]);
    expect(analysis.metrics.words).toBeGreaterThan(5);
  });

  it("marks a declared lifeline nothing refers to", () => {
    const source = "title T\nparticipant A\nparticipant Unused\nA -> A: self";
    const analysis = analyzeResource(
      {
        id: "diagram-t",
        projectId: "p",
        path: "t.seq",
        type: "sequence-diagram",
        title: "T",
      },
      source,
    );
    const unused = analysis.diagnostics.filter(
      (diagnostic) => diagnostic.code === "project.unused-participant",
    );
    expect(unused).toHaveLength(1);
    expect(unused[0].message).toContain("Unused");
    expect(unused[0].severity).toBe("warning");
  });

  it("carries the language layer's own diagnostics", () => {
    const analysis = analyzeResource(
      {
        id: "diagram-bad",
        projectId: "p",
        path: "bad.seq",
        type: "sequence-diagram",
        title: "bad",
      },
      "participant A\nA -> Nowhere: hi",
    );
    expect(
      analysis.diagnostics.some((diagnostic) =>
        diagnostic.code?.includes("unknown-participant"),
      ),
    ).toBe(true);
  });

  it("fingerprints content so an unchanged file is not re-analysed", () => {
    expect(fingerprintContent("abc")).toBe(fingerprintContent("abc"));
    expect(fingerprintContent("abc")).not.toBe(fingerprintContent("abd"));
    expect(fingerprintContent("a".repeat(500))).toContain("1:");
  });
});

describe("project index", () => {
  it("indexes resources, diagrams, documents and symbols", () => {
    const built = index();
    expect(built.resources.map((resource) => resource.id)).toEqual([
      "doc-architecture",
      "diagram-checkout",
      "doc-legacy",
    ]);
    expect(built.diagrams).toHaveLength(1);
    expect(built.documents).toHaveLength(2);
    expect(built.diagrams[0]).toMatchObject({
      id: "diagram-checkout",
      participants: 3,
      messages: 2,
      titled: true,
    });
    // Three lifelines plus one symbol per resource.
    expect(built.participants).toHaveLength(6);
    expect(built.participants.filter((s) => s.kind === "diagram")).toHaveLength(
      1,
    );
    expect(
      built.participants.filter((s) => s.kind === "document"),
    ).toHaveLength(2);
  });

  it("resolves path, wiki, embed and stable references", () => {
    const built = index();
    const fromArchitecture = built.references.filter(
      (reference) => reference.from === "doc-architecture",
    );
    expect(fromArchitecture).toHaveLength(5);
    expect(fromArchitecture.map((reference) => reference.to)).toEqual([
      "diagram-checkout",
      "diagram-checkout",
      "diagram-checkout",
      "diagram-checkout",
      null,
    ]);
  });

  it("reports a broken link with a navigable range", () => {
    const built = index();
    const broken = built.references.find((reference) => reference.to === null);
    expect(broken?.raw).toBe("nowhere.seq");
    expect(broken?.problem?.reason).toBe("missing");
    expect(broken?.sourceRange?.start.line).toBe(6);
  });

  it("keeps a stable reference working after a rename", () => {
    const moved = renameResourcePath(
      metadata(),
      "checkout.seq",
      "payments.seq",
    );
    const built = index(
      sources().map((file) =>
        file.descriptor.id === "diagram-checkout"
          ? {
              ...file,
              descriptor: { ...file.descriptor, path: "payments.seq" },
            }
          : file,
      ),
      moved,
    );
    const stable = built.references.find(
      (reference) => reference.raw === "diagram://diagram-checkout",
    );
    expect(stable?.to).toBe("diagram-checkout");
    // A path-based link to the old name no longer resolves, which is why the
    // stable form is the one documentation should prefer.
    const byPath = built.references.find(
      (reference) => reference.raw === "checkout.seq",
    );
    expect(byPath?.to).toBeNull();
  });

  it("reports a reference to the wrong kind of resource", () => {
    const built = index(
      sources().map((file) =>
        file.descriptor.id === "doc-architecture"
          ? {
              ...file,
              content: "# A\n\n[oops](diagram://doc-legacy)",
            }
          : file,
      ),
    );
    const wrong = built.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === ProjectDiagnosticCode.WrongReferenceKind,
    );
    expect(wrong?.severity).toBe("error");
    expect(wrong?.message).toContain("markdown-document");
  });

  it("reports an unresolvable embed as an error", () => {
    const built = index(
      sources().map((file) =>
        file.descriptor.id === "doc-architecture"
          ? { ...file, content: "# A\n\n{{diagram:missing}}" }
          : file,
      ),
    );
    const broken = built.diagnostics.find(
      (diagnostic) => diagnostic.code === ProjectDiagnosticCode.BrokenEmbed,
    );
    expect(broken?.severity).toBe("error");
  });

  it("never complains about a link to the web", () => {
    const built = index(
      sources().map((file) =>
        file.descriptor.id === "doc-legacy"
          ? { ...file, content: "# L\n\n[docs](https://example.com/x)" }
          : file,
      ),
    );
    expect(
      built.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes("example.com"),
      ),
    ).toEqual([]);
    // The web link still counts as a reference, so find-references can see it.
    expect(
      built.references.find((reference) =>
        reference.raw.includes("example.com"),
      )?.problem?.reason,
    ).toBe("external");
  });

  it("reports duplicate resource ids as errors", () => {
    const duplicated: ProjectMetadata = metadata();
    duplicated.resources[1] = { ...duplicated.resources[1], id: "doc-legacy" };
    const built = index(
      sources().map((file) =>
        file.descriptor.id === "doc-architecture"
          ? {
              ...file,
              descriptor: { ...file.descriptor, id: "doc-legacy" },
            }
          : file,
      ),
      duplicated,
    );
    const duplicates = built.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === ProjectDiagnosticCode.DuplicateResourceId,
    );
    expect(duplicates.length).toBeGreaterThan(0);
    expect(
      duplicates.every((diagnostic) => diagnostic.severity === "error"),
    ).toBe(true);
  });

  it("warns when two resources share a title", () => {
    const built = index(
      sources().map((file) =>
        file.descriptor.id === "doc-legacy"
          ? { ...file, content: "# Architecture" }
          : file,
      ),
    );
    const titles = built.diagnostics.filter(
      (diagnostic) => diagnostic.code === ProjectDiagnosticCode.DuplicateTitle,
    );
    expect(titles).toHaveLength(2);
    expect(titles[0].severity).toBe("warning");
  });

  it("warns about an unresolved wiki-link but not about a broken stable one", () => {
    const built = index(
      sources().map((file) =>
        file.descriptor.id === "doc-legacy"
          ? { ...file, content: "# L\n\nSee [[Nowhere]]." }
          : file,
      ),
    );
    const unresolved = built.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === ProjectDiagnosticCode.UnresolvedLink &&
        diagnostic.message.includes("Nowhere"),
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].severity).toBe("warning");
  });
});

describe("incremental indexer", () => {
  it("re-analyses only the file that changed", () => {
    const indexer = createProjectIndexer();
    const first = sources();
    indexer.update("payments", first, metadata());
    expect(indexer.lastAnalyzedCount()).toBe(3);

    // Nothing changed: every analysis comes from the cache.
    indexer.update("payments", first, metadata());
    expect(indexer.lastAnalyzedCount()).toBe(0);

    // One file edited: exactly one re-parse.
    const edited = first.map((file) =>
      file.descriptor.id === "diagram-checkout"
        ? {
            ...file,
            content: `${file.content}\nPaymentDatabase -->> PaymentService: OK`,
          }
        : file,
    );
    const rebuilt = indexer.update("payments", edited, metadata());
    expect(indexer.lastAnalyzedCount()).toBe(1);
    // The edit is reflected in the project view.
    expect(
      rebuilt.diagrams.find((diagram) => diagram.id === "diagram-checkout")
        ?.messages,
    ).toBe(3);
  });

  it("reuses an analysis across a rename without re-parsing", () => {
    const indexer = createProjectIndexer();
    const first = sources();
    indexer.update("payments", first, metadata());

    const moved = first.map((file) =>
      file.descriptor.id === "diagram-checkout"
        ? { ...file, descriptor: { ...file.descriptor, path: "renamed.seq" } }
        : file,
    );
    const rebuilt = indexer.update("payments", moved, metadata());
    expect(indexer.lastAnalyzedCount()).toBe(0);
    expect(
      rebuilt.resources.find((resource) => resource.id === "diagram-checkout")
        ?.path,
    ).toBe("renamed.seq");
  });

  it("forgets a resource that disappeared", () => {
    const indexer = createProjectIndexer();
    const first = sources();
    indexer.update("payments", first, metadata());
    const withoutLegacy = first.filter(
      (file) => file.descriptor.id !== "doc-legacy",
    );
    const rebuilt = indexer.update("payments", withoutLegacy, metadata());
    expect(rebuilt.resources.map((resource) => resource.id)).not.toContain(
      "doc-legacy",
    );
    expect(
      indexer.cached().map((analysis) => analysis.descriptor.id),
    ).not.toContain("doc-legacy");
  });

  it("produces a deterministic index", () => {
    expect(JSON.stringify(index())).toBe(JSON.stringify(index()));
  });

  it("clears its cache on demand", () => {
    const indexer = createProjectIndexer();
    indexer.update("payments", sources(), metadata());
    indexer.clear();
    expect(indexer.cached()).toEqual([]);
    indexer.update("payments", sources(), metadata());
    expect(indexer.lastAnalyzedCount()).toBe(3);
  });
});
