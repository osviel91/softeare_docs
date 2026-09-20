import { describe, expect, it } from "vitest";
import { reconcileMetadata } from "../../../src/domain/workspace/metadata";
import { createProjectIndexer } from "../../../src/domain/project/indexer";
import type { ProjectSourceFile } from "../../../src/domain/project/indexer";
import {
  findSymbolReferences,
  isValidSymbolName,
  planSymbolRename,
} from "../../../src/domain/project/references";
import { diagramDisplayName } from "../../../src/language/diagram-title";
import type { ProjectIndex } from "../../../src/domain/project/project-index";

const CHECKOUT = [
  "title Checkout",
  "participant CartService",
  "participant PaymentService",
  // An alias must be declared before the first message, so it sits with the
  // declarations rather than at the end.
  "alias Pay = PaymentService",
  "",
  "CartService ->> PaymentService: Authorize",
  "PaymentService ->> PaymentService: Retry",
  "activate PaymentService",
  "deactivate PaymentService",
  "note right of PaymentService: retries",
  "Pay ->> CartService: Settled",
].join("\n");

const SETTLEMENT = [
  "title Settlement",
  "participant PaymentService",
  "",
  "PaymentService ->> PaymentService: Batch",
].join("\n");

/** Two diagrams that both declare and use PaymentService. */
function sources(): ProjectSourceFile[] {
  const entries = [
    { id: "diagram-checkout", path: "checkout.seq", content: CHECKOUT },
    { id: "diagram-settlement", path: "settlement.seq", content: SETTLEMENT },
    {
      id: "doc-architecture",
      path: "architecture.md",
      content: "# A\n\nPaymentService is documented here.",
    },
  ];
  return entries.map(({ id, path, content }) => {
    const type = path.endsWith(".md")
      ? ("markdown-document" as const)
      : ("sequence-diagram" as const);
    return {
      descriptor: {
        id,
        projectId: "payments",
        path,
        type,
        title:
          type === "sequence-diagram" ? diagramDisplayName(path, content) : "A",
      },
      content,
    };
  });
}

/** The index and the raw contents it was built from. */
function fixture(): { index: ProjectIndex; contents: Map<string, string> } {
  const files = sources();
  const metadata = reconcileMetadata(
    null,
    files.map((file) => ({
      path: file.descriptor.path,
      type: file.descriptor.type,
    })),
  ).metadata;
  const index = createProjectIndexer().update("payments", files, metadata);
  return {
    index,
    contents: new Map(files.map((f) => [f.descriptor.id, f.content])),
  };
}

describe("findSymbolReferences", () => {
  it("finds declarations and usages across resources", () => {
    const { index } = fixture();
    const result = findSymbolReferences(index, "PaymentService");
    expect(result.declaredIn).toEqual([
      "diagram-checkout",
      "diagram-settlement",
    ]);
    const declarations = result.sites.filter((s) => s.role === "declaration");
    const usages = result.sites.filter((s) => s.role === "usage");
    expect(declarations).toHaveLength(2);
    // message from/to, self-message (twice), activate, deactivate, note, alias
    // target, alias sender — plus the settlement self-message.
    expect(usages.length).toBeGreaterThanOrEqual(8);
    expect(result.sites[0]).toMatchObject({
      resourceId: "diagram-checkout",
      role: "declaration",
      line: 3,
      column: 13,
      context: "participant",
    });
  });

  it("reports 1-based positions and the resource's path and title", () => {
    const { index } = fixture();
    const result = findSymbolReferences(index, "CartService");
    const declaration = result.sites[0];
    expect(declaration).toMatchObject({
      line: 2,
      column: 13,
      resourcePath: "checkout.seq",
      resourceTitle: "Checkout",
    });
  });

  it("does not match a longer identifier that contains the name", () => {
    const { index } = fixture();
    const result = findSymbolReferences(index, "Payment");
    expect(result.sites).toEqual([]);
  });

  it("does not count a mention inside a message label", () => {
    const files = sources();
    const withLabel = files.map((file) =>
      file.descriptor.id === "diagram-checkout"
        ? {
            ...file,
            content: file.content.replace(
              "CartService ->> PaymentService: Authorize",
              "CartService ->> PaymentService: ask PaymentService",
            ),
          }
        : file,
    );
    const metadata = reconcileMetadata(
      null,
      withLabel.map((file) => ({
        path: file.descriptor.path,
        type: file.descriptor.type,
      })),
    ).metadata;
    const index = createProjectIndexer().update(
      "payments",
      withLabel,
      metadata,
    );
    const usages = findSymbolReferences(index, "PaymentService").sites.filter(
      (site) => site.role === "usage",
    );
    // The label's mention is not an endpoint, so it is not a rename site.
    expect(usages.some((site) => site.line === 6 && site.column > 30)).toBe(
      false,
    );
  });

  it("returns nothing for an unknown name", () => {
    const { index } = fixture();
    expect(findSymbolReferences(index, "Nope").sites).toEqual([]);
  });
});

describe("planSymbolRename", () => {
  it("rewrites every declaration and usage across the project", () => {
    const { index, contents } = fixture();
    const plan = planSymbolRename(
      index,
      contents,
      "PaymentService",
      "PaymentAPI",
    );
    expect(plan.projectWide).toBe(true);
    expect(plan.edits.map((edit) => edit.resourceId).sort()).toEqual([
      "diagram-checkout",
      "diagram-settlement",
    ]);

    const checkout = plan.edits.find(
      (edit) => edit.resourceId === "diagram-checkout",
    );
    expect(checkout?.content).toContain("participant PaymentAPI");
    expect(checkout?.content).toContain(
      "CartService ->> PaymentAPI: Authorize",
    );
    expect(checkout?.content).toContain("alias Pay = PaymentAPI");
    expect(checkout?.content).toContain("note right of PaymentAPI: retries");
    // Nothing else in the document changed.
    expect(checkout?.content).not.toContain("PaymentService");
    expect(checkout?.content.split("\n")).toHaveLength(
      CHECKOUT.split("\n").length,
    );
  });

  it("leaves prose in a markdown document alone", () => {
    const { index, contents } = fixture();
    const plan = planSymbolRename(
      index,
      contents,
      "PaymentService",
      "PaymentAPI",
    );
    expect(
      plan.edits.some((edit) => edit.resourceId === "doc-architecture"),
    ).toBe(false);
    expect(contents.get("doc-architecture")).toContain(
      "PaymentService is documented",
    );
  });

  it("keeps the document's shape: only the name spans change", () => {
    const { index, contents } = fixture();
    const plan = planSymbolRename(index, contents, "PaymentService", "P");
    const edit = plan.edits.find((e) => e.resourceId === "diagram-settlement");
    expect(edit?.content).toBe(
      ["title Settlement", "participant P", "", "P ->> P: Batch"].join("\n"),
    );
    expect(edit?.replaced).toBe(3);
  });

  it("counts every replaced span", () => {
    const { index, contents } = fixture();
    const plan = planSymbolRename(
      index,
      contents,
      "PaymentService",
      "PaymentAPI",
    );
    expect(plan.replaced).toBe(
      plan.edits.reduce((total, edit) => total + edit.replaced, 0),
    );
    expect(plan.replaced).toBeGreaterThan(8);
  });

  it("plans nothing for a name that is not in the project", () => {
    const { index, contents } = fixture();
    const plan = planSymbolRename(index, contents, "Ghost", "Real");
    expect(plan.edits).toEqual([]);
    expect(plan.replaced).toBe(0);
    expect(plan.projectWide).toBe(false);
  });

  it("skips a resource whose content the caller did not supply", () => {
    const { index, contents } = fixture();
    const partial = new Map(contents);
    partial.delete("diagram-settlement");
    const plan = planSymbolRename(
      index,
      partial,
      "PaymentService",
      "PaymentAPI",
    );
    expect(plan.edits.map((edit) => edit.resourceId)).toEqual([
      "diagram-checkout",
    ]);
  });

  it("is idempotent when renamed to the same name", () => {
    const { index, contents } = fixture();
    const plan = planSymbolRename(
      index,
      contents,
      "PaymentService",
      "PaymentService",
    );
    for (const edit of plan.edits) {
      expect(edit.content).toBe(contents.get(edit.resourceId));
    }
  });
});

describe("isValidSymbolName", () => {
  it("accepts identifiers and rejects the rest", () => {
    expect(isValidSymbolName("PaymentService")).toBe(true);
    expect(isValidSymbolName("_internal")).toBe(true);
    expect(isValidSymbolName("with.dot")).toBe(true);
    expect(isValidSymbolName("9lives")).toBe(false);
    expect(isValidSymbolName("has space")).toBe(false);
    expect(isValidSymbolName("")).toBe(false);
  });
});
