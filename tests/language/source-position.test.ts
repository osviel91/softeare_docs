import { describe, expect, it } from "vitest";
import type { SourceRange } from "../../src/domain/diagram/ast";
import {
  offsetToPosition,
  positionToOffset,
  rangeContainsPosition,
  rangeToOffsets,
} from "../../src/language/source-position";

/** A range from `start` to `end`, for the containment assertions. */
function range(
  start: [line: number, column: number],
  end: [line: number, column: number],
): SourceRange {
  return {
    start: { line: start[0], column: start[1] },
    end: { line: end[0], column: end[1] },
  };
}

describe("offsetToPosition", () => {
  it("maps the start of the text to the origin", () => {
    expect(offsetToPosition("abc", 0)).toEqual({ line: 0, column: 0 });
  });

  it("counts columns within a line", () => {
    expect(offsetToPosition("abc", 2)).toEqual({ line: 0, column: 2 });
  });

  it("counts lines across newlines", () => {
    // "abc\ndef": the newline is at offset 3, so offset 5 is the "e".
    expect(offsetToPosition("abc\ndef", 5)).toEqual({ line: 1, column: 1 });
  });

  it("maps the end of the text to the last position", () => {
    expect(offsetToPosition("abc\ndef", 7)).toEqual({ line: 1, column: 3 });
  });

  it("clamps an offset before the start and after the end", () => {
    expect(offsetToPosition("abc", -5)).toEqual({ line: 0, column: 0 });
    expect(offsetToPosition("abc", 99)).toEqual({ line: 0, column: 3 });
    expect(offsetToPosition("", 4)).toEqual({ line: 0, column: 0 });
  });

  it("treats a CRLF pair as a single line break", () => {
    // "a\r\nb": offsets 0..3 are 'a', '\r', '\n', 'b'.
    expect(offsetToPosition("a\r\nb", 0)).toEqual({ line: 0, column: 0 });
    expect(offsetToPosition("a\r\nb", 1)).toEqual({ line: 0, column: 1 });
    expect(offsetToPosition("a\r\nb", 3)).toEqual({ line: 1, column: 0 });
    expect(offsetToPosition("a\r\nb", 4)).toEqual({ line: 1, column: 1 });
  });

  it("treats a lone carriage return as a line break", () => {
    expect(offsetToPosition("a\rb", 2)).toEqual({ line: 1, column: 0 });
    expect(offsetToPosition("a\rb", 3)).toEqual({ line: 1, column: 1 });
  });
});

describe("positionToOffset", () => {
  it("is the inverse of offsetToPosition at every offset (LF text)", () => {
    const text = "title A\nparticipant B\nB -> B: hi\n";
    for (let offset = 0; offset <= text.length; offset += 1) {
      expect(positionToOffset(text, offsetToPosition(text, offset))).toBe(
        offset,
      );
    }
  });

  it("is the inverse of offsetToPosition at every offset (CRLF text)", () => {
    const text = "title A\r\nparticipant B\r\nB -> B: hi\r\n";
    // Offsets that land inside a CRLF pair are ambiguous, so step over them:
    // both characters normalize to one line break.
    for (let offset = 0; offset <= text.length; offset += 1) {
      if (text[offset - 1] === "\r") continue;
      expect(positionToOffset(text, offsetToPosition(text, offset))).toBe(
        offset,
      );
    }
  });

  it("clamps a negative position to the document start", () => {
    expect(positionToOffset("abc", { line: -3, column: -3 })).toBe(0);
  });

  it("clamps a column past the end of its line to the line end", () => {
    expect(positionToOffset("ab\ncd", { line: 0, column: 99 })).toBe(2);
  });

  it("clamps a line past the end of the document to the text end", () => {
    expect(positionToOffset("ab\ncd", { line: 99, column: 0 })).toBe(5);
  });

  it("resolves the first column of a CRLF line past the pair", () => {
    expect(positionToOffset("a\r\nb", { line: 1, column: 0 })).toBe(3);
  });
});

describe("rangeToOffsets", () => {
  it("converts both endpoints of a same-line range", () => {
    expect(rangeToOffsets("hello world", range([0, 6], [0, 11]))).toEqual({
      start: 6,
      end: 11,
    });
  });

  it("converts both endpoints of a multi-line range", () => {
    expect(rangeToOffsets("ab\ncd\nef", range([0, 1], [2, 1]))).toEqual({
      start: 1,
      end: 7,
    });
  });

  it("accounts for CRLF when converting a range", () => {
    expect(rangeToOffsets("a\r\nb", range([0, 0], [1, 1]))).toEqual({
      start: 0,
      end: 4,
    });
  });
});

describe("rangeContainsPosition", () => {
  it("includes the start and excludes the end (half-open)", () => {
    const span = range([0, 0], [0, 3]);
    expect(rangeContainsPosition(span, { line: 0, column: 0 })).toBe(true);
    expect(rangeContainsPosition(span, { line: 0, column: 2 })).toBe(true);
    expect(rangeContainsPosition(span, { line: 0, column: 3 })).toBe(false);
  });

  it("rejects positions before the start", () => {
    expect(
      rangeContainsPosition(range([1, 2], [1, 5]), { line: 1, column: 1 }),
    ).toBe(false);
    expect(
      rangeContainsPosition(range([1, 2], [1, 5]), { line: 0, column: 9 }),
    ).toBe(false);
  });

  it("spans lines", () => {
    const span = range([0, 2], [2, 1]);
    expect(rangeContainsPosition(span, { line: 1, column: 0 })).toBe(true);
    expect(rangeContainsPosition(span, { line: 2, column: 0 })).toBe(true);
    expect(rangeContainsPosition(span, { line: 2, column: 1 })).toBe(false);
    expect(rangeContainsPosition(span, { line: 0, column: 1 })).toBe(false);
  });

  it("makes a zero-width range contain its own start", () => {
    const point = range([1, 2], [1, 2]);
    expect(rangeContainsPosition(point, { line: 1, column: 2 })).toBe(true);
    expect(rangeContainsPosition(point, { line: 1, column: 1 })).toBe(false);
    expect(rangeContainsPosition(point, { line: 1, column: 3 })).toBe(false);
  });
});
