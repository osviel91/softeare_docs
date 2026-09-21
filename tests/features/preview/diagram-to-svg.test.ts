import { describe, expect, it } from "vitest";
import {
  diagramToSvg,
  renderDiagram,
} from "../../../src/renderer/pipeline/diagram-to-svg";
import { analyze } from "../../../src/language/analyze";

const VALID = `title Login

participant User
participant API

User ->> API: Login
API --> User: Token
`;

const DUPLICATES = `participant A
participant A
A -> A: self
`;

describe("diagramToSvg — valid source", () => {
  it("emits a well-formed svg containing the participant and message labels", () => {
    const svg = diagramToSvg(VALID);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain(">User<");
    expect(svg).toContain("Login");
    // A sync message gets a filled head.
    expect(svg).toContain("<polygon");
  });

  it("numbers each call and response in source order", () => {
    // The sample has one call and one response, so it should read 1 then 2.
    const doc = new DOMParser().parseFromString(
      diagramToSvg(VALID),
      "image/svg+xml",
    );
    const badges = Array.from(
      doc.querySelectorAll("[data-sequence-number]"),
    ).map((badge) => badge.textContent);
    expect(badges).toEqual(["1", "2"]);
  });
});

describe("diagramToSvg — invalid source", () => {
  it("returns an empty canvas rather than throwing on duplicate participants", () => {
    const svg = diagramToSvg(DUPLICATES);
    expect(svg.startsWith("<svg ")).toBe(true);
    // Empty canvas: no participant boxes, no message arrows/heads.
    expect(svg).not.toContain(">A<");
    expect(svg).not.toContain("<polygon");
  });

  it("returns an empty canvas when syntax is too broken to build an AST", () => {
    const svg = diagramToSvg("@@@ not parseable at all ###");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toContain("<polygon");
  });
});

describe("renderDiagram — from an AST", () => {
  it("renders a valid AST", () => {
    const { ast } = analyze(VALID);
    const svg = renderDiagram(ast);
    expect(svg).toContain(">User<");
  });

  it("renders null as an empty canvas", () => {
    const svg = renderDiagram(null);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toContain("<polygon");
  });

  it("renders an invalid AST as an empty canvas", () => {
    const { ast } = analyze(DUPLICATES);
    const svg = renderDiagram(ast);
    expect(svg).not.toContain("<polygon");
  });
});
