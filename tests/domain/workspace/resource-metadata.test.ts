import { describe, expect, it } from "vitest";
import {
  normalizeResourceMetadata,
  type ResourceMetadata,
} from "../../../src/domain/workspace/resource-metadata";
import { deriveResourcePresentation } from "../../../src/domain/workspace/resource-presentation";

describe("normalizeResourceMetadata", () => {
  it("normalizes empty metadata to an empty object", () => {
    expect(normalizeResourceMetadata()).toEqual({});
    expect(normalizeResourceMetadata({})).toEqual({});
  });

  it("trims descriptions and omits whitespace-only values", () => {
    expect(
      normalizeResourceMetadata({ description: "  A useful description  " }),
    ).toEqual({ description: "A useful description" });
    expect(normalizeResourceMetadata({ description: " \n\t " })).toEqual({});
  });

  it("preserves meaningful multiline descriptions", () => {
    expect(
      normalizeResourceMetadata({ description: "  First line\nSecond line  " }),
    ).toEqual({ description: "First line\nSecond line" });
  });

  it("trims tags, drops empty tags, and preserves first-occurrence order", () => {
    expect(
      normalizeResourceMetadata({
        tags: ["DDD", " backend ", "ddd", "", "Events"],
      }),
    ).toEqual({ tags: ["DDD", "backend", "Events"] });
  });

  it("does not mutate the input metadata or its tags", () => {
    const input: ResourceMetadata = {
      description: "  text  ",
      tags: ["One", " one ", "Two"],
    };
    const original = {
      description: input.description,
      tags: [...(input.tags ?? [])],
    };

    const normalized = normalizeResourceMetadata(input);

    expect(input).toEqual(original);
    expect(normalized).not.toBe(input);
    expect(normalized.tags).not.toBe(input.tags);
  });
});

describe("deriveResourcePresentation", () => {
  it("uses a content title and records its source", () => {
    expect(deriveResourcePresentation("checkout.seq", "  Checkout  ")).toEqual({
      effectiveTitle: "Checkout",
      titleSource: "content",
    });
  });

  it("falls back to the supplied resource name", () => {
    expect(deriveResourcePresentation("checkout.seq")).toEqual({
      effectiveTitle: "checkout.seq",
      titleSource: "name",
    });
    expect(deriveResourcePresentation("checkout.seq", "  ")).toEqual({
      effectiveTitle: "checkout.seq",
      titleSource: "name",
    });
  });
});
