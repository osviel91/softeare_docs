import { describe, expect, it } from "vitest";
import {
  formatVersionTime,
  sameVersionContent,
  versionSummary,
} from "../../../src/domain/workspace/version";

describe("sameVersionContent", () => {
  it("treats identical sources as the same version", () => {
    expect(sameVersionContent("a -> b: hi", "a -> b: hi")).toBe(true);
  });

  it("ignores trailing whitespace and newlines", () => {
    // A stray newline at the end of a file is not an edit worth checkpointing.
    expect(sameVersionContent("a -> b: hi\n\n", "a -> b: hi")).toBe(true);
  });

  it("sees a real edit as a different version", () => {
    expect(sameVersionContent("a -> b: hi", "a -> b: bye")).toBe(false);
  });

  it("does not ignore interior whitespace changes", () => {
    expect(sameVersionContent("a ->  b", "a -> b")).toBe(false);
  });
});

describe("versionSummary", () => {
  it("prefers the diagram title", () => {
    expect(versionSummary("participant A\ntitle Login\nA -> A: x")).toBe(
      "title Login",
    );
  });

  it("falls back to the first non-empty line", () => {
    expect(versionSummary("\n\nparticipant A\nA -> A: x")).toBe(
      "participant A",
    );
  });

  it("names an empty diagram", () => {
    expect(versionSummary("   \n\n")).toBe("(empty diagram)");
  });

  it("truncates a long summary", () => {
    const summary = versionSummary("x".repeat(200));
    expect(summary.length).toBeLessThanOrEqual(60);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("formatVersionTime", () => {
  it("formats a timestamp for display", () => {
    const text = formatVersionTime(Date.UTC(2026, 8, 20, 15, 4, 22), "en-US");
    // The exact string is locale-dependent; assert the month abbreviation and
    // that a real formatted value came back.
    expect(text).toContain("Sep");
    expect(text.length).toBeGreaterThan(0);
  });
});
