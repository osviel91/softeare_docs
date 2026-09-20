import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  renderMarkdownToHtml,
  wikiLinkTargets,
} from "../../../src/language/markdown/markdown";

describe("escapeHtml", () => {
  it("escapes the HTML-significant characters", () => {
    expect(escapeHtml(`a&b<c>d"e`)).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });
});

describe("renderMarkdownToHtml — blocks", () => {
  it("renders ATX headings at every level", () => {
    expect(renderMarkdownToHtml("# One")).toBe("<h1>One</h1>");
    expect(renderMarkdownToHtml("### Three")).toBe("<h3>Three</h3>");
    expect(renderMarkdownToHtml("###### Six")).toBe("<h6>Six</h6>");
  });

  it("joins consecutive lines into one paragraph", () => {
    expect(renderMarkdownToHtml("one\ntwo")).toBe("<p>one two</p>");
  });

  it("separates paragraphs at blank lines", () => {
    expect(renderMarkdownToHtml("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });

  it("renders unordered lists", () => {
    expect(renderMarkdownToHtml("- a\n- b")).toBe(
      "<ul><li>a</li><li>b</li></ul>",
    );
  });

  it("renders ordered lists", () => {
    expect(renderMarkdownToHtml("1. a\n2. b")).toBe(
      "<ol><li>a</li><li>b</li></ol>",
    );
  });

  it("renders blockquotes", () => {
    expect(renderMarkdownToHtml("> quoted")).toBe(
      "<blockquote><p>quoted</p></blockquote>",
    );
  });

  it("renders horizontal rules", () => {
    expect(renderMarkdownToHtml("---")).toBe("<hr/>");
  });

  it("renders fenced code with its language and escapes its contents", () => {
    const html = renderMarkdownToHtml("```ts\nconst a = 1 < 2;\n```");
    expect(html).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    );
  });
});

describe("renderMarkdownToHtml — inline", () => {
  it("renders inline code literally", () => {
    expect(renderMarkdownToHtml("a `x -> y` b")).toBe(
      "<p>a <code>x -&gt; y</code> b</p>",
    );
  });

  it("leaves formatting characters inside code alone", () => {
    expect(renderMarkdownToHtml("`**not bold**`")).toBe(
      "<p><code>**not bold**</code></p>",
    );
  });

  it("renders bold and italic", () => {
    expect(renderMarkdownToHtml("**bold** and *italic*")).toBe(
      "<p><strong>bold</strong> and <em>italic</em></p>",
    );
  });

  it("renders standard links", () => {
    const html = renderMarkdownToHtml("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">docs</a>");
  });

  it("neutralizes dangerous link targets", () => {
    const html = renderMarkdownToHtml("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  it("escapes raw HTML instead of rendering it", () => {
    const html = renderMarkdownToHtml("hello <script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderMarkdownToHtml — wiki links", () => {
  it("marks an unresolved link as broken", () => {
    const html = renderMarkdownToHtml("see [[Missing]]");
    expect(html).toContain(
      'class="markdown__link markdown__link--broken" href="#" data-diagram-link="Missing"',
    );
    expect(html).toContain(">Missing</a>");
  });

  it("points a resolved link at the href the resolver returns", () => {
    const html = renderMarkdownToHtml("see [[Welcome]]", {
      resolveWikiLink: (target) => `#diagram/${target}`,
    });
    expect(html).toContain('class="markdown__link" href="#diagram/Welcome"');
    expect(html).not.toContain("--broken");
  });

  it("supports an explicit label", () => {
    const html = renderMarkdownToHtml("[[Welcome|Start here]]", {
      resolveWikiLink: () => "#diagram/1",
    });
    expect(html).toContain('data-diagram-link="Welcome"');
    expect(html).toContain(">Start here</a>");
  });

  it("escapes a target before putting it in an attribute", () => {
    const html = renderMarkdownToHtml('[[A "quoted" name]]');
    expect(html).toContain('data-diagram-link="A &quot;quoted&quot; name"');
  });

  it("lists every wiki-link target in source order", () => {
    expect(wikiLinkTargets("[[A]] then [[B|bee]] and [[A]]")).toEqual([
      "A",
      "B",
      "A",
    ]);
  });
});

describe("renderMarkdownToHtml — tables", () => {
  it("renders a pipe table with a header and body rows", () => {
    const html = renderMarkdownToHtml(
      [
        "| Event | Producer |",
        "| --- | --- |",
        "| OrderCreated | Order |",
      ].join("\n"),
    );
    expect(html).toBe(
      "<table><thead><tr><th>Event</th><th>Producer</th></tr></thead>" +
        "<tbody><tr><td>OrderCreated</td><td>Order</td></tr></tbody></table>",
    );
  });

  it("applies the delimiter row's column alignment", () => {
    const html = renderMarkdownToHtml(
      ["| L | C | R |", "| :-- | :-: | --: |", "| a | b | c |"].join("\n"),
    );
    expect(html).toContain('<th class="markdown__cell--left">L</th>');
    expect(html).toContain('<th class="markdown__cell--center">C</th>');
    expect(html).toContain('<th class="markdown__cell--right">R</th>');
  });

  it("renders inline markdown inside cells", () => {
    const html = renderMarkdownToHtml(
      ["| A | B |", "| --- | --- |", "| **bold** | `code` |"].join("\n"),
    );
    expect(html).toContain("<td><strong>bold</strong></td>");
    expect(html).toContain("<td><code>code</code></td>");
  });

  it("pads a short row so the column count stays fixed", () => {
    const html = renderMarkdownToHtml(
      ["| A | B |", "| --- | --- |", "| only |"].join("\n"),
    );
    expect(html).toContain("<tr><td>only</td><td></td></tr>");
  });

  it("accepts rows without outer pipes", () => {
    const html = renderMarkdownToHtml(
      ["A | B", "--- | ---", "1 | 2"].join("\n"),
    );
    expect(html).toContain("<th>A</th><th>B</th>");
    expect(html).toContain("<td>1</td><td>2</td>");
  });

  it("escapes cell text like any other content", () => {
    const html = renderMarkdownToHtml(
      ["| A |", "| --- |", "| <script> |"].join("\n"),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("leaves a pipe row that is not a table as a paragraph", () => {
    expect(renderMarkdownToHtml("a | b")).toBe("<p>a | b</p>");
  });

  it("resumes a paragraph after a table", () => {
    const html = renderMarkdownToHtml(
      ["| A |", "| --- |", "| 1 |", "", "after"].join("\n"),
    );
    expect(html).toContain("</table><p>after</p>");
  });
});

describe("renderMarkdownToHtml — images", () => {
  it("renders an image with its alt text and source", () => {
    expect(renderMarkdownToHtml("![Architecture](../assets/arch.png)")).toBe(
      '<p><img class="markdown__image" src="../assets/arch.png" alt="Architecture" loading="lazy" /></p>',
    );
  });

  it("accepts remote images", () => {
    const html = renderMarkdownToHtml("![](https://example.com/a.png)");
    expect(html).toContain('src="https://example.com/a.png"');
  });

  it("refuses a script-scheme image and keeps the alt text", () => {
    const html = renderMarkdownToHtml("![x](javascript:alert)");
    expect(html).not.toContain("javascript:");
    expect(html).toBe('<p><span class="markdown__image-alt">x</span></p>');
  });

  it("does not read an image as a link", () => {
    const html = renderMarkdownToHtml("![a](b.png)");
    expect(html).not.toContain("<a ");
  });
});

describe("renderMarkdownToHtml — project links", () => {
  it("marks a resolved project link for in-app navigation", () => {
    const html = renderMarkdownToHtml("[Payment flow](../diagrams/pay.seq)", {
      resolveResourceLink: () => "#resource/diagram/pay",
    });
    expect(html).toContain('class="markdown__link markdown__link--resource"');
    expect(html).toContain('href="#resource/diagram/pay"');
    expect(html).toContain('data-resource-link="../diagrams/pay.seq"');
    expect(html).toContain(">Payment flow</a>");
  });

  it("leaves an unresolved relative link as an ordinary link", () => {
    const html = renderMarkdownToHtml("[x](../nothing.seq)", {
      resolveResourceLink: () => null,
    });
    expect(html).not.toContain("data-resource-link");
    expect(html).toContain('href="../nothing.seq"');
  });

  it("keeps the wiki-link marker distinct from the resource marker", () => {
    const html = renderMarkdownToHtml("[[Flow]] and [Flow](flow.seq)", {
      resolveWikiLink: () => "#diagram/flow",
      resolveResourceLink: () => "#resource/diagram/flow",
    });
    expect(html).toContain("data-diagram-link");
    expect(html).toContain("data-resource-link");
  });
});
