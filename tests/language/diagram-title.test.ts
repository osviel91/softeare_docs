import { describe, expect, it } from "vitest";
import {
  diagramDisplayName,
  diagramTitle,
  withDiagramTitle,
} from "../../src/language/diagram-title";

describe("diagramTitle", () => {
  it("reads the title declared in the source", () => {
    expect(diagramTitle("title Login\nparticipant A")).toBe("Login");
  });

  it("reads a title declared later in the source", () => {
    expect(diagramTitle("participant A\nA -> A: hi\ntitle Added")).toBe(
      "Added",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(diagramTitle('title "  Spaced Out  "')).toBe("Spaced Out");
  });

  it("has no title when the source declares none", () => {
    expect(diagramTitle("participant A\nA -> A: hi")).toBeUndefined();
  });

  it("has no title for empty source or a bare title keyword", () => {
    expect(diagramTitle("")).toBeUndefined();
    expect(diagramTitle("title")).toBeUndefined();
  });

  it("falls back to nothing when the source is malformed", () => {
    // Parsing is best-effort and never throws, so a broken diagram still yields
    // whatever title it managed to read.
    expect(diagramTitle("@@@")).toBeUndefined();
    expect(diagramTitle("title Kept\ntitle Second")).toBe("Kept");
  });
});

describe("diagramDisplayName", () => {
  it("prefers the title over the stored file name", () => {
    expect(diagramDisplayName("report.seq", "title Report")).toBe("Report");
  });

  it("falls back to the file name when there is no title", () => {
    expect(diagramDisplayName("report.seq", "participant A")).toBe(
      "report.seq",
    );
    expect(diagramDisplayName("Untitled", "")).toBe("Untitled");
  });
});

describe("withDiagramTitle", () => {
  it("replaces an existing title line in place", () => {
    expect(withDiagramTitle("title Old\nparticipant A", "New")).toBe(
      "title New\nparticipant A",
    );
  });

  it("prepends a title when the source has none", () => {
    expect(withDiagramTitle("participant A", "New")).toBe(
      "title New\n\nparticipant A",
    );
  });

  it("removes the title line and its blank line when cleared", () => {
    expect(withDiagramTitle("title Old\n\nparticipant A", "  ")).toBe(
      "participant A",
    );
  });

  it("leaves the source alone when clearing a title it does not have", () => {
    expect(withDiagramTitle("participant A", "")).toBe("participant A");
  });

  it("keeps the source parseable after the edit", () => {
    const next = withDiagramTitle("", "Fresh");
    expect(diagramTitle(next)).toBe("Fresh");
  });
});
