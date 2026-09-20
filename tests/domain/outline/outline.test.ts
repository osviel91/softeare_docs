import { describe, expect, it } from "vitest";
import {
  markdownOutline,
  sequenceOutline,
  type OutlineNode,
} from "../../../src/domain/outline/outline";
import { parse } from "../../../src/language/parser/parser";
import {
  walkStatements,
  type SequenceDiagram,
} from "../../../src/domain/diagram/ast";

/**
 * Render a tree as one indented `kind label @line` line per node.
 *
 * Asserting on this rendering checks the shape, the kinds, the labels and the
 * 1-based lines in a single readable comparison, instead of a dozen separate
 * lookups that would pass even if the nesting were wrong.
 */
function render(nodes: OutlineNode[]): string {
  return lines(nodes).join("\n");
}

/** The individual lines {@link render} joins. */
function lines(nodes: OutlineNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${node.kind} ${node.label} @${node.line}`,
    ...lines(node.children, depth + 1),
  ]);
}

/** The first node anywhere in the tree with `id`, or `undefined`. */
function findNode(nodes: OutlineNode[], id: string): OutlineNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return undefined;
}

/** Like {@link findNode}, but fails loudly when the id is missing. */
function nodeById(nodes: OutlineNode[], id: string): OutlineNode {
  const found = findNode(nodes, id);
  if (!found) throw new Error(`no outline node with id "${id}"`);
  return found;
}

/** Parse a diagram the test expects to be well-formed, without a null check. */
function diagram(source: string): SequenceDiagram {
  const { ast, diagnostics } = parse(source);
  if (!ast) throw new Error(`parse failed: ${JSON.stringify(diagnostics)}`);
  return ast;
}

const SOURCE = [
  "title Authentication Flow",
  "participant User",
  'participant API as "Backend API"',
  "actor Admin",
  "alias A = API",
  "",
  "User ->> API: Login request",
  "activate API",
  "alt Valid user",
  "  API ->> API: Load user",
  "else Invalid",
  "  API -->> User: Unauthorized",
  "end",
  "loop retry up to 3 times",
  "  User ->> API: Ping",
  "end",
  "note over API: cached",
  "deactivate API",
  "API -->> User",
].join("\n");

describe("sequenceOutline", () => {
  it("outlines the title, declarations and flow with 1-based lines", () => {
    const { ast } = parse(SOURCE);
    expect(render(sequenceOutline(ast))).toEqual(
      [
        "title Title @1",
        "participant Participants @2",
        "  participant User @2",
        "  participant Backend API @3",
        "  actor Admin @4",
        "  alias alias A = API @5",
        "message Flow @7",
        "  message Login request @7",
        "  activation act: API @8",
        "  alt alt Valid user @9",
        "    message Load user @10",
        "    branch else Invalid @11",
        "      message Unauthorized @12",
        "  loop loop retry up to 3 times @14",
        "    message Ping @15",
        "  note note over API: cached @17",
        "  activation deact: API @18",
        "  message API → User @19",
      ].join("\n"),
    );
  });

  it("numbers nodes by their position, so siblings keep stable path ids", () => {
    const { ast } = parse(SOURCE);
    const outline = sequenceOutline(ast);

    expect(outline.map((node) => node.id)).toEqual(["0", "1", "2"]);
    const flow = outline[2];
    expect(flow.children.map((node) => node.id)).toEqual([
      "2.0",
      "2.1",
      "2.2",
      "2.3",
      "2.4",
      "2.5",
      "2.6",
    ]);
    // The note takes the index between the loop and the `deactivate` statement,
    // which is exactly where it sits in the source.
    expect(nodeById(outline, "2.4").label).toBe("note over API: cached");
    expect(nodeById(outline, "2.2.1").label).toBe("else Invalid");
    expect(nodeById(outline, "2.2.1.0").label).toBe("Unauthorized");
  });

  it("keeps each node's source range so a caller can select the statement", () => {
    const ast = diagram(SOURCE);
    const outline = sequenceOutline(ast);
    const login = nodeById(outline, "2.0");
    const messages = [...walkStatements(ast.statements)].filter(
      (statement) => statement.type === "message",
    );
    expect(login.range).toEqual(messages[0].range);
    expect(nodeById(outline, "2.2").range).toEqual(ast.statements[2].range);
  });

  it("falls back to `from → to` for a message with no text", () => {
    const { ast } = parse("participant A\nparticipant B\nA -->> B");
    const flow = sequenceOutline(ast)[1];
    expect(flow.children[0].label).toBe("A → B");
  });

  it("shows an empty fragment, and labels every branch kind", () => {
    const { ast } = parse(
      [
        "participant A",
        "participant B",
        "alt",
        "end",
        "par One",
        "  A ->> B: a",
        "and Two",
        "  A ->> B: b",
        "end",
        "critical Pay",
        "  A ->> B: c",
        "option Rollback",
        "  A ->> B: d",
        "end",
      ].join("\n"),
    );
    expect(render(sequenceOutline(ast)[1].children)).toEqual(
      [
        "alt alt @3",
        "par par One @5",
        "  message a @6",
        "  branch and Two @7",
        "    message b @8",
        "critical critical Pay @10",
        "  message c @11",
        "  branch option Rollback @12",
        "    message d @13",
      ].join("\n"),
    );
  });

  it("places a note inside the fragment that contains it", () => {
    const { ast } = parse(
      [
        "participant A",
        "participant B",
        "loop retry",
        "  A ->> B: Ping",
        "  note over A: retrying",
        "end",
        "alt ok",
        "  note over B: before the first statement",
        "  B ->> A: Done",
        "else bad",
        "  note over A: failed",
        "  A ->> B: Again",
        "end",
      ].join("\n"),
    );

    expect(render(sequenceOutline(ast)[1].children)).toEqual(
      [
        "loop loop retry @3",
        "  message Ping @4",
        "  note note over A: retrying @5",
        "alt alt ok @7",
        "  note note over B: before the first statement @8",
        "  message Done @9",
        "  branch else bad @10",
        "    note note over A: failed @11",
        "    message Again @12",
      ].join("\n"),
    );
  });

  it("truncates a long note's text to a single sensible row", () => {
    const long = "x".repeat(200);
    const { ast } = parse(`note right of A: ${long}`);
    const label = sequenceOutline(ast)[0].children[0].label;
    expect(label.startsWith("note right A: ")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThan(80);
  });

  it("keeps notes when they are the only statements in a fragment", () => {
    const { ast } = parse("participant A\nloop\nnote over A: alone\nend");
    expect(render(sequenceOutline(ast)[1].children)).toEqual(
      ["loop loop @2", "  note note over A: alone @3"].join("\n"),
    );
  });

  it("returns an empty outline for a null AST", () => {
    expect(sequenceOutline(null)).toEqual([]);
  });

  it("emits only the sections a document actually declares", () => {
    expect(sequenceOutline(parse("").ast)).toEqual([]);
    expect(sequenceOutline(parse("title Only a title").ast)).toHaveLength(1);
    expect(sequenceOutline(parse("title Only a title").ast)[0].kind).toBe(
      "title",
    );
    expect(
      sequenceOutline(parse("participant A\nactor B").ast).map(
        (node) => node.label,
      ),
    ).toEqual(["Participants"]);
    expect(
      sequenceOutline(parse("A ->> B: hello").ast).map((node) => node.label),
    ).toEqual(["Flow"]);
  });
});

describe("markdownOutline", () => {
  it("nests headings by level and numbers their 1-based lines", () => {
    const markdown = [
      "# Architecture", // 1
      "intro", // 2
      "## Data", // 3
      "### Tables", // 4
      "## Services", // 5
      "# Operations", // 6
    ].join("\n");
    expect(render(markdownOutline(markdown))).toEqual(
      [
        "heading Architecture @1",
        "  heading Data @3",
        "    heading Tables @4",
        "  heading Services @5",
        "heading Operations @6",
      ].join("\n"),
    );
  });

  it("nests a level jump under the nearest shallower heading", () => {
    const markdown = ["## A", "#### Deep", "## B"].join("\n");
    expect(render(markdownOutline(markdown))).toEqual(
      ["heading A @1", "  heading Deep @2", "heading B @3"].join("\n"),
    );
  });

  it("starts at the top level when the first heading is not an h1", () => {
    const markdown = ["## A", "### B", "## C"].join("\n");
    const outline = markdownOutline(markdown);
    expect(outline.map((node) => node.id)).toEqual(["0", "1"]);
    expect(outline.map((node) => node.label)).toEqual(["A", "C"]);
    expect(outline[0].children.map((node) => node.id)).toEqual(["0.0"]);
  });

  it("ignores heading-looking lines inside fenced code blocks", () => {
    const markdown = [
      "# Real", // 1
      "```md", // 2
      "# Not a heading", // 3
      "## Also not", // 4
      "```", // 5
      "## After", // 6
      "~~~", // 7
      "# Still code", // 8
      "~~~", // 9
      "### Last", // 10
    ].join("\n");
    expect(render(markdownOutline(markdown))).toEqual(
      ["heading Real @1", "  heading After @6", "    heading Last @10"].join(
        "\n",
      ),
    );
  });

  it("does not open a fence for inline code containing backticks", () => {
    const markdown = ["# Real", "``` `x` ```", "## After"].join("\n");
    expect(render(markdownOutline(markdown))).toEqual(
      ["heading Real @1", "  heading After @3"].join("\n"),
    );
  });

  it("keeps a heading that follows a closed fence even with no blank line", () => {
    const markdown = ["```", "# code", "```", "# Real"].join("\n");
    expect(render(markdownOutline(markdown))).toEqual(
      ["heading Real @4"].join("\n"),
    );
  });

  it("strips a closing hash sequence and surrounding spaces", () => {
    expect(markdownOutline("##  Spaced  ##").map((node) => node.label)).toEqual(
      ["Spaced"],
    );
  });

  it("returns an empty outline for empty or heading-free input", () => {
    expect(markdownOutline("")).toEqual([]);
    expect(markdownOutline("just prose\nand more")).toEqual([]);
  });

  it("builds heading rows without a source range but with an id and a line", () => {
    const outline = markdownOutline("# A\n## B");
    expect(outline[0].id).toBe("0");
    expect(outline[0].line).toBe(1);
    expect(outline[0].range).toBeUndefined();
    expect(outline[0].children[0].id).toBe("0.0");
    expect(outline[0].children[0].range).toBeUndefined();
  });
});
