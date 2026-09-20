import { describe, expect, it } from "vitest";
import {
  copyFileName,
  uniqueCopyName,
} from "../../../src/domain/workspace/copy-name";

describe("copy names", () => {
  it("inserts ' copy' before the extension", () => {
    expect(copyFileName("flow.seq")).toBe("flow copy.seq");
    expect(copyFileName("readme.md")).toBe("readme copy.md");
  });

  it("appends to a name that has no extension", () => {
    expect(copyFileName("Untitled")).toBe("Untitled copy");
  });

  it("treats a leading dot as part of the name, not an extension", () => {
    expect(copyFileName(".env")).toBe(".env copy");
  });

  it("keeps the first copy name when it is free", () => {
    expect(uniqueCopyName("flow.seq", [])).toBe("flow copy.seq");
    expect(uniqueCopyName("flow.seq", ["flow.seq"])).toBe("flow copy.seq");
  });

  it("numbers further copies so none collides", () => {
    expect(uniqueCopyName("flow.seq", ["flow copy.seq"])).toBe(
      "flow copy 2.seq",
    );
    expect(
      uniqueCopyName("flow.seq", ["flow copy.seq", "flow copy 2.seq"]),
    ).toBe("flow copy 3.seq");
  });

  it("preserves the extension while numbering", () => {
    expect(uniqueCopyName("readme.md", ["readme copy.md"])).toBe(
      "readme copy 2.md",
    );
  });
});
