import { describe, expect, it } from "vitest";
import {
  defaultResourceId,
  isResourceId,
  resourceIdPrefix,
  resourceKindOf,
  resourceTypeOf,
  slugify,
  uniqueResourceId,
} from "../../../src/domain/workspace/resource-id";
import {
  createEmptyMetadata,
  duplicateResourceIds,
  parseProjectMetadata,
  pathForResourceId,
  reconcileMetadata,
  renameResourcePath,
  resourceRecordAt,
  resourceRecordById,
  serializeProjectMetadata,
  setResourceTitle,
  PROJECT_METADATA_FILE_NAME,
  PROJECT_METADATA_FORMAT,
  type ProjectMetadata,
} from "../../../src/domain/workspace/metadata";

describe("resource ids", () => {
  it("maps a stored kind onto a resource type and back", () => {
    expect(resourceTypeOf("diagram")).toBe("sequence-diagram");
    expect(resourceTypeOf("note")).toBe("markdown-document");
    expect(resourceKindOf("sequence-diagram")).toBe("diagram");
    expect(resourceKindOf("markdown-document")).toBe("note");
    expect(resourceIdPrefix("sequence-diagram")).toBe("diagram");
    expect(resourceIdPrefix("markdown-document")).toBe("doc");
  });

  it("slugs human text into an id fragment", () => {
    expect(slugify("Payment Processing")).toBe("payment-processing");
    expect(slugify("Configuración")).toBe("configuracion");
    expect(slugify("  a/b  ")).toBe("a-b");
    expect(slugify("!!!")).toBe("");
  });

  it("derives an id from a file name, dropping the extension", () => {
    expect(defaultResourceId("sequence-diagram", "payment.seq")).toBe(
      "diagram-payment",
    );
    expect(defaultResourceId("markdown-document", "architecture.md")).toBe(
      "doc-architecture",
    );
    // A name with nothing sluggable still yields a usable, prefixed id.
    expect(defaultResourceId("sequence-diagram", "___")).toBe("diagram");
  });

  it("disambiguates a taken id with a numeric suffix", () => {
    expect(uniqueResourceId("diagram-flow", [])).toBe("diagram-flow");
    expect(uniqueResourceId("diagram-flow", ["diagram-flow"])).toBe(
      "diagram-flow-2",
    );
    expect(
      uniqueResourceId("diagram-flow", ["diagram-flow", "diagram-flow-2"]),
    ).toBe("diagram-flow-3");
  });

  it("recognizes the shape of a resource id", () => {
    expect(isResourceId("diagram-payment-processing")).toBe(true);
    expect(isResourceId("docs/architecture.md")).toBe(false);
    expect(isResourceId("9lives")).toBe(false);
  });
});

describe("project metadata", () => {
  const files = [
    {
      path: "checkout.seq",
      type: "sequence-diagram" as const,
      title: "Checkout",
    },
    {
      path: "architecture.md",
      type: "markdown-document" as const,
      title: "Architecture",
    },
  ];

  it("mints deterministic ids for files that have none", () => {
    const result = reconcileMetadata(null, files);
    expect(result.changed).toBe(true);
    expect(result.assigned).toEqual([
      { id: "diagram-checkout", path: "checkout.seq" },
      { id: "doc-architecture", path: "architecture.md" },
    ]);
    expect(result.metadata.resources.map((r) => r.id)).toEqual([
      "diagram-checkout",
      "doc-architecture",
    ]);
    expect(result.metadata.format).toBe(PROJECT_METADATA_FORMAT);
  });

  it("keeps existing ids and reports no change when nothing moved", () => {
    const first = reconcileMetadata(null, files).metadata;
    const again = reconcileMetadata(first, files);
    expect(again.changed).toBe(false);
    expect(again.metadata.resources).toEqual(first.resources);
    expect(again.assigned).toEqual([]);
  });

  it("disambiguates two files that would claim the same id", () => {
    const result = reconcileMetadata(null, [
      { path: "payment processing.seq", type: "sequence-diagram" },
      { path: "payment-processing.seq", type: "sequence-diagram" },
    ]);
    // Both names slug to the same fragment, so the second gets a suffix.
    expect(result.metadata.resources.map((r) => r.id)).toEqual([
      "diagram-payment-processing",
      "diagram-payment-processing-2",
    ]);
  });

  it("updates a stored title in place without reassigning the id", () => {
    const first = reconcileMetadata(null, files).metadata;
    const renamed = reconcileMetadata(first, [
      { ...files[0], title: "Checkout Flow" },
      files[1],
    ]);
    expect(renamed.changed).toBe(true);
    expect(renamed.metadata.resources[0]).toEqual({
      id: "diagram-checkout",
      path: "checkout.seq",
      type: "sequence-diagram",
      title: "Checkout Flow",
    });
  });

  it("drops the record of a file that is gone", () => {
    const first = reconcileMetadata(null, files).metadata;
    const result = reconcileMetadata(first, [files[0]]);
    expect(result.removed).toEqual(["architecture.md"]);
    expect(result.metadata.resources).toHaveLength(1);
  });

  it("preserves tags across a reconciliation", () => {
    const tagged: ProjectMetadata = {
      ...createEmptyMetadata(),
      resources: [
        {
          id: "diagram-checkout",
          path: "checkout.seq",
          type: "sequence-diagram",
          tags: ["payments"],
        },
      ],
    };
    const result = reconcileMetadata(tagged, files);
    expect(result.metadata.resources[0].tags).toEqual(["payments"]);
  });

  it("preserves the id across a rename", () => {
    const first = reconcileMetadata(null, files).metadata;
    const moved = renameResourcePath(first, "checkout.seq", "payments.seq");
    expect(pathForResourceId(moved, "diagram-checkout")).toBe("payments.seq");
    // And a later reconciliation keeps it, because the path now matches.
    const reconciled = reconcileMetadata(moved, [
      { ...files[0], path: "payments.seq" },
      files[1],
    ]);
    expect(reconciled.metadata.resources[0].id).toBe("diagram-checkout");
    expect(reconciled.assigned).toEqual([]);
    expect(reconciled.changed).toBe(false);
  });

  it("ignores a rename of a path it does not know", () => {
    const first = reconcileMetadata(null, files).metadata;
    expect(renameResourcePath(first, "nope.seq", "other.seq")).toBe(first);
  });

  it("sets a title by path", () => {
    const first = reconcileMetadata(null, files).metadata;
    const titled = setResourceTitle(first, "checkout.seq", "Renamed");
    expect(resourceRecordAt(titled, "checkout.seq")?.title).toBe("Renamed");
    expect(resourceRecordById(titled, "diagram-checkout")?.title).toBe(
      "Renamed",
    );
    expect(setResourceTitle(first, "nope.seq", "x")).toBe(first);
  });

  it("detects duplicate ids", () => {
    const duplicated: ProjectMetadata = {
      ...createEmptyMetadata(),
      resources: [
        { id: "diagram-a", path: "a.seq", type: "sequence-diagram" },
        { id: "diagram-a", path: "b.seq", type: "sequence-diagram" },
        { id: "doc-c", path: "c.md", type: "markdown-document" },
      ],
    };
    expect(duplicateResourceIds(duplicated)).toEqual(["diagram-a"]);
    expect(duplicateResourceIds(createEmptyMetadata())).toEqual([]);
  });

  it("mints a fresh id for a file whose stored record duplicated another", () => {
    const duplicated: ProjectMetadata = {
      ...createEmptyMetadata(),
      resources: [
        { id: "diagram-a", path: "a.seq", type: "sequence-diagram" },
        { id: "diagram-a", path: "b.seq", type: "sequence-diagram" },
      ],
    };
    const result = reconcileMetadata(duplicated, [
      { path: "a.seq", type: "sequence-diagram" },
      { path: "b.seq", type: "sequence-diagram" },
    ]);
    expect(new Set(result.metadata.resources.map((r) => r.id)).size).toBe(2);
  });

  it("round-trips through JSON", () => {
    const metadata = reconcileMetadata(null, files).metadata;
    const text = serializeProjectMetadata(metadata);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseProjectMetadata(JSON.parse(text))).toEqual(metadata);
  });

  /**
   * Regression: an event flow is a resource type, so a project that contains one
   * must still parse. Excluding it made `parseProjectMetadata` reject the whole
   * document, so every load re-minted ids for *all* of the project's files and
   * no link or history entry could rely on a stable id.
   */
  it("round-trips an event flow without losing its record", () => {
    const metadata = reconcileMetadata(null, [
      { path: "orders.eventseq", type: "event-flow" },
      { path: "checkout.seq", type: "sequence-diagram" },
    ]).metadata;
    const parsed = parseProjectMetadata(
      JSON.parse(serializeProjectMetadata(metadata)),
    );
    expect(parsed).toEqual(metadata);
    expect(parsed?.resources[0]).toMatchObject({
      path: "orders.eventseq",
      type: "event-flow",
    });
  });

  it("rejects a document that is not ours", () => {
    expect(parseProjectMetadata(null)).toBeNull();
    expect(parseProjectMetadata({})).toBeNull();
    expect(parseProjectMetadata({ format: "other", version: 1 })).toBeNull();
    expect(
      parseProjectMetadata({ format: PROJECT_METADATA_FORMAT, version: 99 }),
    ).toBeNull();
    expect(
      parseProjectMetadata({
        format: PROJECT_METADATA_FORMAT,
        version: 1,
        resources: [{ id: "a", path: "a.seq", type: "nonsense" }],
      }),
    ).toBeNull();
    expect(
      parseProjectMetadata({
        format: PROJECT_METADATA_FORMAT,
        version: 1,
        resources: [{ id: "", path: "a.seq", type: "sequence-diagram" }],
      }),
    ).toBeNull();
  });

  it("names the file it lives in", () => {
    expect(PROJECT_METADATA_FILE_NAME).toBe("project.json");
  });
});
