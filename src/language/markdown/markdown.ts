/**
 * A small, dependency-free Markdown subset renderer for project notes.
 *
 * The project owns its domain (see the DSL parser and renderer), so notes use an
 * in-house renderer rather than pulling in a Markdown library. It supports the
 * constructs documentation actually needs — headings, paragraphs, emphasis,
 * inline and fenced code, links, lists, blockquotes, and horizontal rules — plus
 * the one project-specific extension: `[[Diagram Name]]` wiki-links that the UI
 * resolves to a diagram in the same project.
 *
 * The output is an HTML string. Every piece of user text is escaped as it is
 * emitted, so a note can never inject markup; only the constructs below produce
 * tags. The renderer is pure and framework-free, which keeps it testable alone.
 */

/** Options for {@link renderMarkdownToHtml}. */
export interface MarkdownOptions {
  /**
   * Resolve a wiki-link target (`[[Name]]`) to the href it should point at.
   * Return `null` when the target does not exist, which marks the link as broken.
   * When omitted, every wiki-link is treated as unresolved but still rendered.
   */
  resolveWikiLink?: (target: string) => string | null;
  /**
   * Resolve a project-relative link (`[Payment flow](../diagrams/pay.seq)`) to
   * an href the app can open. Return `null` when the href is not a project
   * resource, which leaves it as an ordinary external link. A link that resolves
   * carries `data-resource-link`, so the UI can open it in-app.
   */
  resolveResourceLink?: (href: string) => string | null;
  /**
   * Render a `{{kind:target}}` embed into HTML, or `null` when the target does
   * not exist. The returned markup is inserted verbatim, so the resolver is
   * trusted — in this app it is the SVG renderer, whose output contains no user
   * text that was not already escaped by the renderer itself.
   */
  renderEmbed?: (kind: string, target: string) => string | null;
}

/** Escape text for safe inclusion in HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Whether a URL is safe to emit as a link target.
 *
 * Fragments, root-relative and plain relative paths are fine; of the URL schemes
 * only `http`, `https` and `mailto` pass. Everything else — `javascript:` in
 * particular — is refused, so a document can never smuggle in a script URL.
 */
function safeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return /^(https?|mailto):/i.test(trimmed);
  }
  return true;
}

/**
 * Sentinel characters wrapping an extracted inline span while the rest of the
 * line is escaped and emphasized. Private-use code points are used rather than
 * control characters so the pairing regex stays lint-clean and the sentinels are
 * essentially impossible to type into a note.
 */
const TOKEN_OPEN = "\uE000";
const TOKEN_CLOSE = "\uE001";

/** Apply emphasis (bold, italic) to already-escaped inline text. */
function emphasize(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
}

/**
 * Render inline markdown within one line of raw text.
 *
 * Code spans, wiki-links, and standard links are extracted into placeholders on
 * the *raw* text (so their targets and labels are readable by the resolver and
 * escaped exactly once when emitted); the remaining text is escaped, emphasis is
 * applied, and the placeholders are restored last. Extraction order matters:
 * code first, so formatting characters inside a span stay literal.
 */
function inline(text: string, options: MarkdownOptions): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    tokens.push(html);
    return `${TOKEN_OPEN}${tokens.length - 1}${TOKEN_CLOSE}`;
  };

  let out = text;

  // Inline code first: its contents are literal.
  out = out.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );

  // Embeds: `{{diagram:id}}` renders another resource in place. An embed whose
  // target does not resolve leaves a visible marker rather than a blank gap, so
  // a missing diagram is obvious in the rendered document.
  out = out.replace(
    /\{\{\s*([a-zA-Z][\w-]*)\s*:\s*([^}\s]+)\s*\}\}/g,
    (_match, kind: string, target: string) => {
      const html = options.renderEmbed?.(kind, target) ?? null;
      if (html === null) {
        return stash(
          `<span class="markdown__embed markdown__embed--missing" title="Nothing in this project matches ${escapeHtml(
            target,
          )}">{{${escapeHtml(kind)}:${escapeHtml(target)}}}</span>`,
        );
      }
      return stash(
        `<figure class="markdown__embed" data-embed-resource="${escapeHtml(
          target,
        )}">${html}</figure>`,
      );
    },
  );

  // Images, before links: `![alt](src)` must not be read as the link `[alt](src)`.
  out = out.replace(
    /!\[([^\]\n]*)\]\(([^)\s]+)\)/g,
    (_match, alt: string, url: string) => {
      if (!safeUrl(url)) {
        // A refused image leaves its alt text behind rather than breaking out.
        return stash(
          `<span class="markdown__image-alt">${escapeHtml(alt)}</span>`,
        );
      }
      return stash(
        `<img class="markdown__image" src="${escapeHtml(url.trim())}" alt="${escapeHtml(
          alt,
        )}" loading="lazy" />`,
      );
    },
  );

  // Wiki-links: [[Target]] or [[Target|Label]].
  out = out.replace(
    /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g,
    (_match, rawTarget: string, rawLabel: string | undefined) => {
      const target = rawTarget.trim();
      const label = (rawLabel ?? rawTarget).trim();
      const href = options.resolveWikiLink?.(target) ?? null;
      const broken = href === null;
      const className = broken
        ? "markdown__link markdown__link--broken"
        : "markdown__link";
      return stash(
        `<a class="${className}" href="${broken ? "#" : escapeHtml(href)}" data-diagram-link="${escapeHtml(
          target,
        )}">${emphasize(escapeHtml(label))}</a>`,
      );
    },
  );

  // Standard links: [label](url). A project-relative target the app can open is
  // marked so the UI navigates to it in-app instead of following the href.
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      const resource = options.resolveResourceLink?.(url) ?? null;
      if (resource !== null) {
        return stash(
          `<a class="markdown__link markdown__link--resource" href="${escapeHtml(
            resource,
          )}" data-resource-link="${escapeHtml(url)}">${emphasize(
            escapeHtml(label),
          )}</a>`,
        );
      }
      const href = safeUrl(url) ? url : "#";
      return stash(
        `<a class="markdown__link" href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">${emphasize(
          escapeHtml(label),
        )}</a>`,
      );
    },
  );

  out = emphasize(escapeHtml(out));
  const restore = new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_CLOSE}`, "g");
  return out.replace(restore, (_match, index: string) => {
    return tokens[Number(index)] ?? "";
  });
}

/** A regular expression matching an ATX heading, capturing level and text. */
const HEADING = /^(#{1,6})\s+(.*)$/;
/** A fenced code block opener, capturing the optional info string. */
const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
/** An unordered list item. */
const BULLET = /^\s*[-*+]\s+(.*)$/;
/** An ordered list item. */
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
/** A blockquote line. */
const QUOTE = /^\s*>\s?(.*)$/;
/** A horizontal rule. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** A table delimiter cell: `---`, `:--`, `--:` or `:-:`. */
const TABLE_DELIMITER_CELL = /^:?-+:?$/;

/** Split a pipe-table row into trimmed cells, dropping the outer pipes. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

/** Whether a row is a table delimiter row with the expected number of columns. */
function isTableDelimiter(line: string, columns: number): boolean {
  const cells = splitTableRow(line);
  return (
    cells.length === columns &&
    cells.every((cell) => TABLE_DELIMITER_CELL.test(cell))
  );
}

/** Whether a table starts at `start`: a pipe row followed by a delimiter row. */
function isTableStart(lines: string[], start: number): boolean {
  const header = lines[start];
  if (header === undefined || !header.includes("|")) return false;
  const delimiter = lines[start + 1];
  return (
    delimiter !== undefined &&
    isTableDelimiter(delimiter, splitTableRow(header).length)
  );
}

/** The CSS class for a column's alignment, or an empty string when unset. */
function alignmentClass(delimiterCell: string): string {
  const left = delimiterCell.startsWith(":");
  const right = delimiterCell.endsWith(":");
  if (left && right) return "markdown__cell--center";
  if (right) return "markdown__cell--right";
  if (left) return "markdown__cell--left";
  return "";
}

/** Render a pipe table: a header row, the delimiter's alignments, and body rows. */
function renderTable(
  header: string[],
  alignments: string[],
  rows: string[][],
  options: MarkdownOptions,
): string {
  const cell = (tag: "th" | "td", text: string, column: number): string => {
    const className = alignmentClass(alignments[column] ?? "");
    const attribute = className === "" ? "" : ` class="${className}"`;
    return `<${tag}${attribute}>${inline(text, options)}</${tag}>`;
  };
  // A short row is padded and a long one truncated, so a ragged table still
  // renders as a table rather than producing a broken column count.
  const row = (cells: string[], tag: "th" | "td"): string =>
    `<tr>${header
      .map((_unused, column) => cell(tag, cells[column] ?? "", column))
      .join("")}</tr>`;

  return [
    "<table><thead>",
    row(header, "th"),
    "</thead><tbody>",
    rows.map((cells) => row(cells, "td")).join(""),
    "</tbody></table>",
  ].join("");
}

/**
 * Render a markdown document to HTML.
 *
 * Supported: ATX headings, paragraphs, unordered/ordered lists, pipe tables,
 * fenced and inline code, blockquotes, horizontal rules, images, `**bold**`,
 * `*italic*`, links, project-relative links, `[[wiki-links]]`, and
 * `{{kind:target}}` embeds. Everything else is rendered as plain text.
 */
export function renderMarkdownToHtml(
  markdown: string,
  options: MarkdownOptions = {},
): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;

  /** Consume consecutive lines matching `pattern`, returning the captures. */
  const collect = (pattern: RegExp): string[] => {
    const items: string[] = [];
    while (index < lines.length) {
      const match = pattern.exec(lines[index]);
      if (!match) break;
      items.push(match[1]);
      index += 1;
    }
    return items;
  };

  while (index < lines.length) {
    const line = lines[index];

    // Blank line: nothing to emit.
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    // Fenced code block.
    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1];
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      // Skip the closing fence when present.
      if (index < lines.length) index += 1;
      const className = language
        ? ` class="language-${escapeHtml(language)}"`
        : "";
      html.push(
        `<pre><code${className}>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // Heading.
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2].trim(), options)}</h${level}>`);
      index += 1;
      continue;
    }

    // Horizontal rule (checked before lists, which also start with `-`/`*`).
    if (RULE.test(line)) {
      html.push("<hr/>");
      index += 1;
      continue;
    }

    // Pipe table: a header row followed by a delimiter row of the same width.
    // Checked before lists so a delimiter row like `| --- |` is never a bullet.
    if (isTableStart(lines, index)) {
      const header = splitTableRow(line);
      const alignments = splitTableRow(lines[index + 1]);
      index += 2;
      const rows: string[][] = [];
      while (
        index < lines.length &&
        lines[index].trim() !== "" &&
        lines[index].includes("|")
      ) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      html.push(renderTable(header, alignments, rows, options));
      continue;
    }

    // Bullet list.
    if (BULLET.test(line)) {
      const items = collect(BULLET);
      html.push(
        `<ul>${items
          .map((item) => `<li>${inline(item.trim(), options)}</li>`)
          .join("")}</ul>`,
      );
      continue;
    }

    // Ordered list.
    if (NUMBERED.test(line)) {
      const items = collect(NUMBERED);
      html.push(
        `<ol>${items
          .map((item) => `<li>${inline(item.trim(), options)}</li>`)
          .join("")}</ol>`,
      );
      continue;
    }

    // Blockquote.
    if (QUOTE.test(line)) {
      const items = collect(QUOTE);
      html.push(
        `<blockquote>${items
          .map((item) => `<p>${inline(item.trim(), options)}</p>`)
          .join("")}</blockquote>`,
      );
      continue;
    }

    // Paragraph: gather until a blank line or another block starts.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        current.trim() === "" ||
        HEADING.test(current) ||
        FENCE.test(current) ||
        RULE.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current) ||
        QUOTE.test(current) ||
        isTableStart(lines, index)
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    html.push(`<p>${inline(paragraph.join(" "), options)}</p>`);
  }

  return html.join("");
}

/** Every wiki-link target in a markdown document, in source order. */
export function wikiLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const pattern = /\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    targets.push(match[1].trim());
  }
  return targets;
}

/**
 * What a markdown reference points at.
 *
 * - `wiki` — `[[Target]]`, resolved by name against the project's resources.
 * - `link` — `[label](target)`, an ordinary or project-relative link.
 * - `image` — `![alt](target)`; a URL to fetch, never a project reference.
 * - `embed` — `{{diagram:target}}`, a directive to render another resource
 *   inside this document.
 */
export type MarkdownReferenceKind = "wiki" | "link" | "image" | "embed";

/** One reference found in a markdown document. */
export interface MarkdownReference {
  kind: MarkdownReferenceKind;
  /** The raw target as written (a path, a `scheme://id`, or a name). */
  target: string;
  /** The link's visible text, or a directive's kind for an embed. */
  label: string;
  /** 1-based line number the reference appears on. */
  line: number;
  /** 0-based column of the reference within its line. */
  column: number;
}

/** A `{{kind:target}}` embed directive. */
const EMBED = /\{\{\s*([a-zA-Z][\w-]*)\s*:\s*([^}\s]+)\s*\}\}/g;
/** A wiki-link, with or without an explicit label. */
const WIKI = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
/** An image, matched before links so `![a](b)` is not read as a link. */
const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;
/** An ordinary link. */
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Collect every reference a markdown document makes, in source order.
 *
 * Line-by-line scanning keeps the reported positions usable as editor
 * navigation targets, which is what the problems panel and the reference index
 * need. Each line's matches are sorted by column afterwards, so a line holding
 * both an embed and a link reports them in the order written.
 */
export function markdownReferences(markdown: string): MarkdownReference[] {
  const references: MarkdownReference[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");

  lines.forEach((line, index) => {
    const onLine: MarkdownReference[] = [];
    const collect = (
      pattern: RegExp,
      kind: MarkdownReferenceKind,
      targetGroup: number,
      labelGroup: number,
    ): void => {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const target = match[targetGroup].trim();
        if (target === "") continue;
        onLine.push({
          kind,
          target,
          // A wiki-link's label is optional (`[[Target]]`), so a missing group
          // means "no explicit label" rather than a malformed match.
          label: (match[labelGroup] ?? "").trim(),
          line: index + 1,
          column: match.index + 1,
        });
      }
    };

    // Images first, so the link pattern does not also match their `[alt](src)`.
    collect(IMAGE, "image", 2, 1);
    collect(EMBED, "embed", 2, 1);
    collect(WIKI, "wiki", 1, 2);
    collect(LINK, "link", 2, 1);
    onLine.sort((a, b) => a.column - b.column);
    references.push(...onLine);
  });

  return references;
}
