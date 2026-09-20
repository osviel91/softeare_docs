/**
 * Static documentation site generation.
 *
 * A project is a folder of markdown documents and sequence diagrams that only
 * this application can read. Exporting it as a *site* turns the project into
 * something a reader can open without the app, without a server, and without a
 * network: a folder of HTML with ordinary relative links between its pages.
 *
 * The whole generator is one pure function — data in, a list of files out. It
 * never touches the DOM, `fetch`, or the filesystem, so the same input always
 * produces byte-identical output (no timestamps, no random ids) and the shell
 * that owns the save dialog (a ZIP download, a folder picker) stays the only
 * place that performs I/O.
 *
 * Layers, from the bottom up:
 *
 * - **Slugs and hrefs** — {@link siteSlug}, {@link uniqueSlugs} and
 *   {@link relativeHref} turn resource identity and location into stable file
 *   names and the links between them. They are exported so the naming rules can
 *   be tested without generating a whole site.
 * - **Navigation** — {@link buildSiteNav} derives the sidebar from the project
 *   structure (documents grouped by their directory, then diagrams), never from
 *   a hand-written list, so a new document appears in the export automatically,
 *   and a project with no documents or no diagrams produces no empty heading.
 * - **Pages** — {@link buildDocumentationSite} renders the overview, one page per
 *   document, one per diagram, the shared stylesheet, and optionally a problems
 *   report.
 *
 * A document's markdown is rendered by the project's own renderer, with link
 * resolution rewritten to point at the generated pages. `{{diagram:id}}` embeds
 * are the one construct the markdown module does not know about, so they are
 * folded into that render (see {@link renderDocumentBody}) and substituted with
 * the current SVG afterwards. Every string that comes from the project — titles,
 * paths, captions, diagnostics — is escaped on the way into a template; the only
 * unescaped HTML in the output is markup this module produced itself, which is
 * why the diagram SVG is normalised through {@link normalizeSvg} first.
 */
import type {
  DiagramDescriptor,
  DocumentDescriptor,
  MarkdownHeading,
  ProjectDiagnostic,
  ProjectIndex,
} from "../../../domain/project/project-index";
import { slugify } from "../../../domain/workspace/resource-id";
import {
  escapeHtml,
  renderMarkdownToHtml,
} from "../../../language/markdown/markdown";

/** One output file of the generated site. */
export interface SiteFile {
  /** `/`-separated path relative to the site root, e.g. "docs/architecture.html". */
  path: string;
  /** UTF-8 text or binary content. */
  data: Uint8Array;
  /** Rough content type, for a caller that writes to a real filesystem. */
  type: string;
}

/**
 * One page the site generates, in navigation terms.
 *
 * The nav is built before the pages so every page can carry the same sidebar and
 * mark the current page. Keeping it as data rather than as per-page markup is
 * what makes the "no documents" and "no diagrams" cases fall out of the grouping
 * instead of needing special-cased HTML.
 */
export interface SiteNavItem {
  /** The resource's stable id, or a reserved page's key (e.g. `problems`). */
  id: string;
  /** The display title, escaped on the way into markup. */
  title: string;
  /** The generated page's path relative to the site root. */
  path: string;
  /** A secondary line under the title, when there is one (usually the path). */
  detail?: string;
}

/** A titled section of the sidebar. */
export interface SiteNavGroup {
  title: string;
  items: SiteNavItem[];
}

/** Everything the generator needs; nothing it must fetch. */
export interface SiteExportInput {
  projectName: string;
  index: ProjectIndex;
  /** The text of every resource, keyed by stable resource id. */
  contents: Map<string, string>;
  /** The current SVG for a resource id, or null when it does not render. */
  renderDiagram: (resourceId: string) => string | null;
  /** Colour scheme of the generated pages. Defaults to "light". */
  theme?: "light" | "dark";
  /**
   * Whether to generate `problems.html` from `index.diagnostics`.
   *
   * Part of the input rather than of the caller's options because the nav has to
   * know about the page in order to link it from every other page; the
   * shell-facing option lives on `exportDocumentationSite`.
   */
  includeProblems?: boolean;
}

/** Where the generated files live, relative to the site root. */
export const SITE_LAYOUT = {
  index: "index.html",
  events: "events.html",
  problems: "problems.html",
  stylesheet: "styles/site.css",
  documents: "docs",
  diagrams: "diagrams",
} as const;

/** The CSS classes the generator's own markup uses, kept in one place. */
const CLASS = {
  site: "site",
  sidebar: "site__sidebar",
  brand: "site__brand",
  content: "site__content",
  footer: "site__footer",
  nav: "nav",
  navGroup: "nav-group",
  navGroupTitle: "nav-group__title",
  navList: "nav-list",
  navItem: "nav-item",
  navItemCurrent: "nav-item--current",
  navLink: "nav-link",
  navDetail: "nav-detail",
  navEmpty: "nav-empty",
  pageTitle: "page-title",
  pageMeta: "page-meta",
  section: "section",
  sectionTitle: "section-title",
  cardGrid: "card-grid",
  card: "card",
  cardLink: "card__link",
  cardDetail: "card__detail",
  empty: "empty-state",
  markdown: "markdown",
  embed: "embed",
  embedCaption: "embed__caption",
  embedMissing: "embed--missing",
  broken: "broken",
  problemList: "problem-list",
  severity: "severity",
  severityError: "severity--error",
  severityWarning: "severity--warning",
  severityInfo: "severity--info",
} as const;

/** The `<html>` font stack, shared by the stylesheet the site ships. */
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
/** The monospace stack, for code and paths. */
const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/**
 * A name for a generated page, derived from a resource title and then its path.
 *
 * Everything ends up in a file name and an href, so the only characters allowed
 * through are lowercase letters, digits and `-`. The path fallback drops the
 * file extension but keeps its directories (`docs/Getting Started.md` →
 * `docs-getting-started`), so two same-named files in different folders still
 * slug differently. A title and a path that both slug to nothing (punctuation
 * only, or a script the slugifier cannot transliterate) fall back to `fallback`,
 * so a page always gets *some* name and never a bare `.html`.
 */
export function siteSlug(
  title: string,
  path: string,
  fallback = "resource",
): string {
  const withoutExtension = path.replace(/\.[^./\\]+$/, "");
  return (
    slugify(title) ||
    slugify(withoutExtension) ||
    slugify(fallback) ||
    "resource"
  );
}

/**
 * Assign each id a page slug that is unique among `taken`.
 *
 * A collision appends `-2`, `-3`, … to the base slug, mirroring how the
 * workspace mints unique resource ids. Collisions are silent but visible: two
 * documents titled "Architecture" become `architecture.html` and
 * `architecture-2.html`, and links to them stay distinct.
 *
 * `taken` is mutated as slugs are assigned, so callers generating documents and
 * diagrams in sequence share one namespace — which is what keeps a document and
 * a diagram with the same title from fighting over the same href once both are
 * placed under the site root.
 */
export function uniqueSlugs(
  ids: string[],
  baseSlug: (id: string) => string,
  taken: Set<string> = new Set<string>(),
): Map<string, string> {
  const slugs = new Map<string, string>();
  for (const id of ids) {
    const base = baseSlug(id) || "resource";
    let candidate = base;
    let index = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    taken.add(candidate);
    slugs.set(id, candidate);
  }
  return slugs;
}

/** Split a `/`-separated path into its non-empty segments. */
function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/** Split `path#fragment` into its parts. */
function splitFragment(target: string): [string, string] {
  const index = target.indexOf("#");
  if (index === -1) return [target, ""];
  return [target.slice(0, index), target.slice(index + 1)];
}

/**
 * The href that reaches `target` from the page at `from`.
 *
 * Links are relative rather than root-absolute because the whole point of the
 * export is that `file:///…/index.html` works: a leading `/` would resolve to
 * the filesystem root instead of the site folder. A `#fragment` is preserved.
 */
export function relativeHref(from: string, target: string): string {
  const [targetPath, fragment] = splitFragment(target);
  const targetSegments = pathSegments(targetPath);
  const fromDirectory = pathSegments(from).slice(0, -1);

  let shared = 0;
  while (
    shared < fromDirectory.length &&
    shared < targetSegments.length &&
    fromDirectory[shared] === targetSegments[shared]
  ) {
    shared += 1;
  }

  const up = fromDirectory.length - shared;
  const down = targetSegments.slice(shared).join("/");
  const href = up === 0 ? down : `${"../".repeat(up)}${down}`;
  if (href === "") return fragment === "" ? "." : `#${fragment}`;
  return fragment === "" ? href : `${href}#${fragment}`;
}

/** The site-root path of a document page. */
export function documentPagePath(slug: string): string {
  return `${SITE_LAYOUT.documents}/${slug}.html`;
}

/** The site-root path of a diagram page. */
export function diagramPagePath(slug: string): string {
  return `${SITE_LAYOUT.diagrams}/${slug}.html`;
}

/** The site-root path of a diagram's raw SVG file. */
export function diagramSvgPath(slug: string): string {
  return `${SITE_LAYOUT.diagrams}/${slug}.svg`;
}

/** Sort a copy of `items` by `key`, so output never depends on input order. */
function sortedBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * The page slug a resource in `resources` should take, before disambiguation.
 *
 * A helper rather than an inline lookup because {@link uniqueSlugs} asks for a
 * base slug by *id*, and the title/path pair it needs lives on the descriptor.
 */
function siteSlugOf(
  resources: ReadonlyArray<{ id: string; title: string; path: string }>,
  id: string,
): string {
  const resource = resources.find((entry) => entry.id === id);
  return siteSlug(resource?.title ?? "", resource?.path ?? "", id);
}

/** The first path segment of a resource, used to group documents in the nav. */
function groupTitleOf(path: string): string {
  const segments = pathSegments(path);
  return segments.length > 1 ? segments[0] : "Documents";
}

/**
 * Derive the site's sidebar from the project structure.
 *
 * Documents are grouped by their top-level directory and listed in path order,
 * because a project's folders are already an outline a reader recognises; a flat
 * project lands in a single "Documents" group. Diagrams follow as one group.
 * Nothing here is hand-written, so adding a document to the project is enough for
 * it to appear in the export.
 *
 * A kind with no resources keeps its group and says "None" inside it: the nav is
 * a map of what the project *is*, so "no diagrams yet" is information a reader
 * wants, and a project with no resources at all still gets a sidebar with no
 * links in it rather than an empty string where navigation should be.
 *
 * @param documents - The document descriptors, in any order.
 * @param diagrams - The diagram descriptors, in any order.
 * @param docSlugs - Document id to page slug.
 * @param diagramSlugs - Diagram id to page slug.
 * @param extras - Reserved pages (the problems report) to append as their group.
 */
export function buildSiteNav(
  documents: DocumentDescriptor[],
  diagrams: DiagramDescriptor[],
  docSlugs: Map<string, string>,
  diagramSlugs: Map<string, string>,
  extras: SiteNavItem[] = [],
): SiteNavGroup[] {
  const groups: SiteNavGroup[] = [];

  const byGroup = new Map<string, DocumentDescriptor[]>();
  for (const document of sortedBy(documents, (entry) => entry.path)) {
    const title = groupTitleOf(document.path);
    const bucket = byGroup.get(title);
    if (bucket) bucket.push(document);
    else byGroup.set(title, [document]);
  }
  if (byGroup.size === 0) byGroup.set("Documents", []);

  for (const [title, entries] of [...byGroup.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    groups.push({
      title,
      items: entries.map((document) => ({
        id: document.id,
        title: document.title,
        path: documentPagePath(docSlugs.get(document.id) ?? "resource"),
        detail: document.path,
      })),
    });
  }

  groups.push({
    title: "Diagrams",
    items: sortedBy(diagrams, (entry) => entry.path).map((diagram) => ({
      id: diagram.id,
      title: diagram.title,
      path: diagramPagePath(diagramSlugs.get(diagram.id) ?? "resource"),
      detail: diagram.path,
    })),
  });

  if (extras.length > 0) groups.push({ title: "Project", items: extras });
  return groups;
}

/**
 * Render the shared sidebar.
 *
 * Every page carries the same nav — that is what makes the export browsable
 * offline from any single page the reader opens — with the current page marked by
 * a class (for the stylesheet) and `aria-current` (for a screen reader). Items
 * are matched by resource id, so the caller can ask whether the *resource* is
 * current even when a reserved page's key is not a resource id.
 */
function renderNav(
  groups: SiteNavGroup[],
  current: string,
  from: string,
): string {
  const body = groups
    .map((group) => {
      const items =
        group.items.length === 0
          ? `<li class="${CLASS.navItem} ${CLASS.navEmpty}">None</li>`
          : group.items
              .map((item) => {
                const isCurrent = item.id === current;
                const className = isCurrent
                  ? `${CLASS.navItem} ${CLASS.navItemCurrent}`
                  : CLASS.navItem;
                const currentAttribute = isCurrent
                  ? ' aria-current="page"'
                  : "";
                const detail =
                  item.detail === undefined
                    ? ""
                    : `\n            <span class="${CLASS.navDetail}">${escapeHtml(
                        item.detail,
                      )}</span>`;
                return `<li class="${className}">
            <a class="${CLASS.navLink}" href="${escapeHtml(
              relativeHref(from, item.path),
            )}"${currentAttribute}>${escapeHtml(item.title)}</a>${detail}
          </li>`;
              })
              .join("\n          ");
      return `<section class="${CLASS.navGroup}">
        <h2 class="${CLASS.navGroupTitle}">${escapeHtml(group.title)}</h2>
        <ul class="${CLASS.navList}">
          ${items}
        </ul>
      </section>`;
    })
    .join("\n      ");

  return `<nav class="${CLASS.nav}" aria-label="Project navigation">
      ${body}
    </nav>`;
}

/** A complete HTML page: head, nav sidebar, main content, footer. */
function page(options: {
  title: string;
  description: string;
  projectName: string;
  from: string;
  current: string;
  nav: SiteNavGroup[];
  theme: "light" | "dark";
  main: string;
}): string {
  const fullTitle = `${options.title} — ${options.projectName}`;
  return `<!DOCTYPE html>
<html lang="en" data-theme="${options.theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="generator" content="SequenceDiagrams documentation export" />
    <title>${escapeHtml(fullTitle)}</title>
    <meta name="description" content="${escapeHtml(options.description)}" />
    <link rel="stylesheet" href="${escapeHtml(
      relativeHref(options.from, SITE_LAYOUT.stylesheet),
    )}" />
  </head>
  <body>
    <div class="${CLASS.site}">
      <aside class="${CLASS.sidebar}">
        <p class="${CLASS.brand}">
          <a class="${CLASS.navLink}" href="${escapeHtml(
            relativeHref(options.from, SITE_LAYOUT.index),
          )}">${escapeHtml(options.projectName)}</a>
        </p>
        ${renderNav(options.nav, options.current, options.from)}
      </aside>
      <main class="${CLASS.content}">
${options.main}
      </main>
      <footer class="${CLASS.footer}">
        <p>${escapeHtml(
          options.projectName,
        )} — static documentation export. No server required.</p>
      </footer>
    </div>
  </body>
</html>
`;
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove the tags from a fragment of rendered HTML, for heading matching. */
function textOfHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

/** The ids a document's headings take, unique within the document. */
function headingIds(headings: MarkdownHeading[]): string[] {
  const taken = new Set<string>();
  return headings.map((heading) => {
    const base = slugify(heading.text) || "section";
    let candidate = base;
    let index = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    taken.add(candidate);
    return candidate;
  });
}

/**
 * Give every rendered heading the id its table-of-contents entry links to.
 *
 * The markdown renderer does not emit heading ids and is not ours to change, so
 * the ids are assigned here from the descriptor's headings — matching each `<hN>`
 * in order against the heading the index recorded, and leaving any heading the
 * index does not know about untouched rather than guessing.
 */
function annotateHeadings(html: string, headings: MarkdownHeading[]): string {
  const ids = headingIds(headings);
  const used = new Set<number>();

  return html.replace(
    /<h([1-6])>([\s\S]*?)<\/h\1>/g,
    (match, level: string, inner: string) => {
      const wanted = textOfHtml(inner);
      const index = headings.findIndex(
        (heading, position) =>
          !used.has(position) &&
          heading.level === Number(level) &&
          heading.text.trim() === wanted,
      );
      if (index === -1) return match;
      used.add(index);
      return `<h${level} id="${escapeHtml(
        ids[index] ?? "section",
      )}">${inner}</h${level}>`;
    },
  );
}

/**
 * Normalize whatever the renderer returned into an SVG document fragment.
 *
 * Returns `null` for anything that is not an `<svg>` element — a renderer that
 * reports failure as an empty string or an error message should produce the
 * visible "could not render" placeholder, not a page with garbage in it.
 */
function normalizeSvg(svg: string | null): string | null {
  if (svg === null) return null;
  const trimmed = svg.trim();
  return trimmed.startsWith("<svg") ? trimmed : null;
}

/** Remove a single surrounding `<p>` from `html`, leaving other blocks alone. */
function unwrapSingleParagraph(html: string): string {
  const trimmed = html.trim();
  if (!trimmed.startsWith("<p>") || !trimmed.endsWith("</p>")) return html;
  const inner = trimmed.slice(3, -4);
  return inner.includes("</p>") ? html : inner;
} /** The `<figure>` an embedded diagram renders as. */
function renderFigure(
  diagram: DiagramDescriptor,
  svg: string,
  href: string,
): string {
  return `<figure class="${CLASS.embed}">
        ${svg}
        <figcaption class="${CLASS.embedCaption}">${escapeHtml(
          diagram.title,
        )} — <a href="${escapeHtml(href)}">open diagram page</a></figcaption>
      </figure>`;
}

/**
 * The placeholder an embed leaves behind when nothing can be rendered.
 *
 * Naming the target is the point: a reader opening the exported site offline has
 * no other way to learn what was supposed to be here, so a miss is never a blank
 * gap and never silently dropped.
 */
function renderMissingEmbed(message: string): string {
  return `<figure class="${CLASS.embed} ${CLASS.embedMissing}">
        <p><strong>Embed unavailable:</strong> ${escapeHtml(message)}</p>
      </figure>`;
}

/** The placeholder href an embed directive is rendered as before substitution. */
function embedPlaceholder(index: number): string {
  return `embed-placeholder-${index}`;
}

/** A `{{kind:target}}` embed directive, matching the markdown module's grammar. */
const EMBED_DIRECTIVE = /\{\{\s*([a-zA-Z][\w-]*)\s*:\s*([^}\s]+)\s*\}\}/g;

/** The resource type an embed label names; unknown labels are left as text. */
function isDiagramLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return normalized === "diagram" || normalized === "sequence";
}

/** Split a `scheme://id` target, or `null` when the target carries no scheme. */
function schemeTarget(target: string): { scheme: string; id: string } | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(target.trim());
  if (!match) return null;
  let id = match[2].trim();
  try {
    id = decodeURIComponent(id);
  } catch {
    /* a malformed escape is used verbatim, as the project index does */
  }
  return { scheme: match[1].toLowerCase(), id: splitFragment(id)[0] };
}

/** The href prefix that marks a link whose target did not resolve. */
const BROKEN_HREF_PREFIX = "#dsh-broken-target:";

/**
 * The href handed to the markdown renderer for a link that must look broken.
 *
 * It has to survive the renderer unchanged (so the resolver cannot simply return
 * `null`, which would leave an ordinary-looking external link for a relative
 * target) and carry the raw target so {@link markBrokenLinks} can name it. `#`
 * is ignored by browsers, so the raw render is already harmless even before the
 * pass that labels it.
 */
function brokenTargetHref(target: string): string {
  return `${BROKEN_HREF_PREFIX}${encodeURIComponent(target)}`;
}

/** The schemes that name a project resource rather than a place on the web. */
const PROJECT_SCHEMES: ReadonlySet<string> = new Set([
  "resource",
  "diagram",
  "doc",
]);

/** Whether a target carries one of the project's own stable schemes. */
function isProjectSchemeTarget(target: string): boolean {
  const scheme = schemeTarget(target);
  return scheme !== null && PROJECT_SCHEMES.has(scheme.scheme);
}

/** Whether an href is a web, mail or protocol link that must stay untouched. */
function isWebHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/** Collapse `.` and `..` segments in a `/`-separated path. */
function normalizedPath(path: string): string {
  const segments: string[] = [];
  for (const segment of pathSegments(path)) {
    if (segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Resolve `target` against a directory, dropping a `..` that leaves the root. */
function resolveRelativePath(directory: string, target: string): string {
  const joined = directory === "" ? target : `${directory}/${target}`;
  return normalizedPath(joined);
}

/**
 * Everything one document's render pass needs to know about the whole site.
 *
 * Built once per export and passed by value into the pure renderers, so a page
 * never reaches back into the input for anything — which is what makes the
 * renderers testable on their own and the output independent of call order.
 */
export interface PageContext {
  projectName: string;
  theme: "light" | "dark";
  index: ProjectIndex;
  contents: Map<string, string>;
  /**
   * The current SVG per diagram id, normalized once at export time.
   *
   * Shared rather than re-derived per page so an embedded diagram and its own
   * page can never disagree about what the renderer produced, and so a diagram
   * embedded in ten documents is only rendered once.
   */
  renders: Map<string, string | null>;
  nav: SiteNavGroup[];
  docSlugs: Map<string, string>;
  diagramSlugs: Map<string, string>;
}

/** The site-root page path a resource lives at, or `null` when it has none. */
function pagePathOf(context: PageContext, resourceId: string): string | null {
  const diagram = context.diagramSlugs.get(resourceId);
  if (diagram !== undefined) return diagramPagePath(diagram);
  const document = context.docSlugs.get(resourceId);
  if (document !== undefined) return documentPagePath(document);
  return null;
}

/**
 * Resolve any target the project can name to a resource id.
 *
 * Tried in the order the project index resolves references: a stable
 * `scheme://id`, then an id or display title written bare (which is how an embed
 * and a wiki-link usually read), then a path relative to `fromPath`.
 */
function resolveTarget(
  context: PageContext,
  target: string,
  fromPath: string | null,
): string | null {
  const trimmed = target.trim();
  if (trimmed === "") return null;

  const scheme = schemeTarget(trimmed);
  if (scheme !== null) {
    // A project scheme names a resource by id. Any other scheme is somebody
    // else's URL, and an id lookup would only mis-read it.
    if (!PROJECT_SCHEMES.has(scheme.scheme)) return null;
    const byId = context.index.resources.find(
      (resource) => resource.id === scheme.id,
    );
    return byId ? byId.id : null;
  }
  // A web, mail or any other URL written without `//` is not ours to resolve.
  if (isWebHref(trimmed)) return null;

  const wanted = trimmed.toLowerCase();
  const ordered = sortedBy(context.index.resources, (entry) => entry.path);
  const byId = ordered.find((resource) => resource.id.toLowerCase() === wanted);
  if (byId) return byId.id;
  const byTitle = ordered.find(
    (resource) => resource.title.toLowerCase() === wanted,
  );
  if (byTitle) return byTitle.id;

  if (fromPath !== null) {
    const resolved = resolveRelativePath(
      fromPath.split("/").slice(0, -1).join("/"),
      trimmed,
    );
    const byPath = ordered.find(
      (resource) => normalizedPath(resource.path) === resolved,
    );
    if (byPath) return byPath.id;
  }

  const byName = ordered.find(
    (resource) =>
      resource.path.toLowerCase() === wanted ||
      (resource.path.split("/").pop() ?? resource.path).toLowerCase() ===
        wanted,
  );
  return byName ? byName.id : null;
}

/**
 * Mark every project link whose target did not resolve.
 *
 * Two kinds of anchor point nowhere after the render:
 *
 * - a wiki-link or a `scheme://` resource link, which the resolver reported as
 *   unresolved, so the renderer emitted the sentinel `href` (never a real one —
 *   a resolved target always gets a real href);
 * - an ordinary relative link that names no project file, which the renderer
 *   would otherwise emit as an ordinary external-looking link.
 *
 * Both become `class="broken"` with a `title` naming the raw target, and lose
 * `target="_blank"`: opening a dead offline link in a new tab is not helpful. The
 * anchor stays an anchor, so a reader can see exactly what is missing instead of
 * finding a normal-looking dead end.
 */
function markBrokenLinks(html: string): string {
  const anchor = /<a\b[^>]*?href="(#|#dsh-broken-target:[^"]*)"[^>]*?>/g;
  return html.replace(anchor, (match: string, href: string) => {
    // A broken wiki-link carries the target it was written with; a broken
    // relative or scheme link carries it in the sentinel href.
    if (match.includes('data-diagram-link="')) return match;
    const label =
      href === "#"
        ? ""
        : decodeHtmlAttribute(href.slice("#dsh-broken-target:".length));
    const title =
      label === ""
        ? "Unresolved link"
        : `Unresolved link: ${escapeHtml(label)}`;
    // Keep the renderer's own classes and add ours, so the link still looks like
    // a link (the stylesheet shows it as one, in the error colour).
    const existing = /class="([^"]*)"/.exec(match)?.[1];
    const className =
      existing === undefined || existing === ""
        ? CLASS.broken
        : `${existing} ${CLASS.broken}`;
    const rebuilt = match.replace(/\sclass="[^"]*"/, "");
    return rebuilt.replace(
      /href="[^"]*"/,
      `class="${className}" href="#" title="${title}"`,
    );
  });
}

/** Decode the small set of entities the markdown renderer emits in an href. */
function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Render one embedded diagram, resolved through the site's own rules. */
function renderEmbed(
  context: PageContext,
  target: string,
  fromPage: string,
): string {
  const id = resolveTarget(context, target, null);
  if (id === null) {
    return renderMissingEmbed(`nothing in the project matches "${target}"`);
  }
  const diagram = context.index.diagrams.find((entry) => entry.id === id);
  if (diagram === undefined) {
    return renderMissingEmbed(`"${target}" is not a diagram`);
  }
  const svg = context.renders.get(id) ?? null;
  if (svg === null) {
    return renderMissingEmbed(`diagram "${diagram.title}" did not render`);
  }
  const slug = context.diagramSlugs.get(id) ?? "resource";
  return renderFigure(
    diagram,
    svg,
    relativeHref(fromPage, diagramPagePath(slug)),
  );
}

/**
 * Replace one `{{diagram:id}}` placeholder anchor with its rendered figure.
 *
 * A directive on its own line was wrapped in a paragraph by the renderer; the
 * figure that replaces it is a block of its own, so the paragraph is dropped
 * (nesting block content in `<p>` is invalid). An inline directive inside a
 * sentence keeps its paragraph.
 */
function substituteEmbed(
  html: string,
  placeholder: string,
  figure: string,
): string {
  const anchor = new RegExp(
    `<p>(\\s*)<a\\b[^>]*href="#${escapeRegExp(placeholder)}"[^>]*>[\\s\\S]*?</a>(\\s*)</p>`,
  );
  if (anchor.test(html)) return html.replace(anchor, () => figure);
  const inline = new RegExp(
    `<a\\b[^>]*href="#${escapeRegExp(placeholder)}"[^>]*>[\\s\\S]*?</a>`,
  );
  return html.replace(inline, () => unwrapSingleParagraph(figure));
}

/**
 * Render one markdown document to page content.
 *
 * The project's markdown renderer does the escaping and the block structure; this
 * function only decides *where* a link goes:
 *
 * - `[[Name]]` becomes a link to the generated page of the resource with that
 *   title, or a visibly broken link when nothing matches.
 * - `[label](resource://id)` (and `diagram://` / `doc://`) becomes a link to the
 *   generated page of that resource.
 * - `[label](../other.md)` is resolved against this document's project path, so
 *   relative links survive being re-rooted under `docs/`.
 * - a web or mail link is left to the renderer.
 *
 * `{{diagram:id}}` is folded in first: the directive becomes a placeholder link
 * the renderer carries through untouched, and the placeholder is swapped for the
 * current SVG afterwards — which is what lets an embed share the document's
 * markdown pass without the markdown module needing to know about embeds.
 */
export function renderDocumentBody(
  descriptor: DocumentDescriptor,
  markdown: string,
  context: PageContext,
  fromPage: string,
): string {
  const embeds: string[] = [];
  const withEmbeds = markdown.replace(
    EMBED_DIRECTIVE,
    (match, label: string, target: string) => {
      if (!isDiagramLabel(label)) return match;
      const index = embeds.length;
      embeds.push(target.trim());
      return `[${match}](#${embedPlaceholder(index)})`;
    },
  );

  const hrefFor = (resourceId: string): string | null => {
    const path = pagePathOf(context, resourceId);
    return path === null ? null : relativeHref(fromPage, path);
  };

  const html = renderMarkdownToHtml(withEmbeds, {
    resolveWikiLink: (target) => {
      const id = resolveTarget(context, target, descriptor.path);
      return id === null ? null : hrefFor(id);
    },
    resolveResourceLink: (href) => {
      // A link the project does not own — the web, mail, or an unrelated
      // scheme — is left to the renderer, which turns it into an ordinary
      // external link. The project's own schemes carry a colon too, so they are
      // claimed first.
      if (isProjectSchemeTarget(href)) {
        const id = resolveTarget(context, href, null);
        const resolved = id === null ? null : hrefFor(id);
        if (resolved === null) return brokenTargetHref(href);
        // `schemeTarget` drops the fragment, so carry it over from the href.
        const [, fragment] = splitFragment(href);
        return fragment === "" ? resolved : `${resolved}#${fragment}`;
      }
      if (isWebHref(href)) return null;
      const [path, fragment] = splitFragment(href);
      const id = resolveTarget(context, path, descriptor.path);
      const resolved = id === null ? null : hrefFor(id);
      if (resolved === null) return brokenTargetHref(href);
      return fragment === "" ? resolved : `${resolved}#${fragment}`;
    },
  });

  let output = rewriteBrokenWikiLinks(markBrokenLinks(html));
  embeds.forEach((target, index) => {
    output = substituteEmbed(
      output,
      embedPlaceholder(index),
      renderEmbed(context, target, fromPage),
    );
  });
  return annotateHeadings(output, descriptor.headings);
}

/**
 * Finish the broken wiki-links the markdown renderer produced.
 *
 * The renderer reports an unresolved wiki-link by pointing it at `#` while
 * keeping the written target in `data-diagram-link`; that attribute is exactly
 * what a reader needs to see, so it is folded into the link's title and the
 * anchor is relabelled rather than left as a link that looks fine and does
 * nothing. Anchors are rewritten back to front so an earlier edit cannot shift
 * the offsets of a later one.
 */
function rewriteBrokenWikiLinks(html: string): string {
  const tags = [...html.matchAll(/<a\b[^>]*>/g)];
  let output = html;
  for (const match of tags.reverse()) {
    const tag = match[0];
    if (!tag.includes('data-diagram-link="') || !/href="#"/.test(tag)) continue;
    const target = decodeHtmlAttribute(
      /data-diagram-link="([^"]*)"/.exec(tag)?.[1] ?? "",
    );
    const start = match.index ?? 0;
    const close = output.indexOf("</a>", start);
    if (close === -1) continue;
    const label = output.slice(start + tag.length, close);
    const replacement = `<a class="${CLASS.broken}" href="#" title="Unresolved link: ${escapeHtml(
      target,
    )}">${label}`;
    output = `${output.slice(0, start)}${replacement}${output.slice(close)}`;
  }
  return output;
}

/** The site-root path of one generated document page. */
function renderDocumentPage(
  descriptor: DocumentDescriptor,
  context: PageContext,
): SiteFile {
  const slug = context.docSlugs.get(descriptor.id) ?? "resource";
  const pagePath = documentPagePath(slug);
  const markdown = context.contents.get(descriptor.id) ?? "";
  const body = renderDocumentBody(descriptor, markdown, context, pagePath);
  const section = renderOutline(descriptor);
  const meta = `${escapeHtml(descriptor.path)} · ${descriptor.words} words`;
  const main = `        <article class="${CLASS.markdown}">
          <h1 class="${CLASS.pageTitle}">${escapeHtml(descriptor.title)}</h1>
          <p class="${CLASS.pageMeta}">${meta}</p>
${section}
          ${body}
        </article>`;

  return textFile(
    pagePath,
    page({
      title: descriptor.title,
      description: `${descriptor.title} — a document in the ${context.projectName} project.`,
      projectName: context.projectName,
      from: pagePath,
      current: descriptor.id,
      nav: context.nav,
      theme: context.theme,
      main,
    }),
    "text/html",
  );
}

/** The "on this page" list a document page shows above its body. */
function renderOutline(descriptor: DocumentDescriptor): string {
  if (descriptor.headings.length === 0) return "";
  const ids = headingIds(descriptor.headings);
  const items = descriptor.headings
    .map(
      (heading, index) =>
        `            <li class="toc__item toc__item--level-${heading.level}"><a href="#${escapeHtml(
          ids[index] ?? "section",
        )}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join("\n");
  return `          <section class="${CLASS.section}" aria-label="On this page">
            <h2 class="${CLASS.sectionTitle}">On this page</h2>
            <ul class="toc">
${items}
            </ul>
          </section>`;
}

/** One diagram's own page: the SVG, its metadata, and a link to the raw file. */
function renderDiagramPage(
  descriptor: DiagramDescriptor,
  context: PageContext,
  renders: Map<string, string | null>,
): SiteFile {
  const slug = context.diagramSlugs.get(descriptor.id) ?? "resource";
  const pagePath = diagramPagePath(slug);
  const svgPath = diagramSvgPath(slug);
  const svg = renders.get(descriptor.id) ?? null;
  const body =
    svg === null
      ? `          <p class="${CLASS.embedMissing}"><strong>This diagram did not render.</strong> Its source is at <code>${escapeHtml(
          descriptor.path,
        )}</code>.</p>`
      : `          <figure class="${CLASS.embed}">
${svg}
          </figure>
          <p><a href="${escapeHtml(
            relativeHref(pagePath, svgPath),
          )}">Download the raw SVG</a></p>`;

  const meta = [
    `path: ${escapeHtml(descriptor.path)}`,
    `${descriptor.participants} participants`,
    `${descriptor.messages} messages`,
    descriptor.titled ? "titled" : "untitled",
  ].join(" · ");

  const main = `        <article class="${CLASS.markdown}">
          <h1 class="${CLASS.pageTitle}">${escapeHtml(descriptor.title)}</h1>
          <p class="${CLASS.pageMeta}">${meta}</p>
${body}
        </article>`;

  return textFile(
    pagePath,
    page({
      title: descriptor.title,
      description: `${descriptor.title} — a diagram in the ${context.projectName} project.`,
      projectName: context.projectName,
      from: pagePath,
      current: descriptor.id,
      nav: context.nav,
      theme: context.theme,
      main,
    }),
    "text/html",
  );
}

/** The overview page: counts, the nav in full, and a card per resource. */
function renderIndexPage(context: PageContext): SiteFile {
  const pagePath = SITE_LAYOUT.index;
  const { documents, diagrams } = context.index;
  const counts = `${documents.length} ${
    documents.length === 1 ? "document" : "documents"
  }, ${diagrams.length} ${diagrams.length === 1 ? "diagram" : "diagrams"}${
    context.index.diagnostics.length > 0
      ? `, ${context.index.diagnostics.length} ${
          context.index.diagnostics.length === 1 ? "problem" : "problems"
        }`
      : ""
  }`;

  const card = (
    item: SiteNavItem,
  ): string => `            <li class="${CLASS.card}">
              <a class="${CLASS.cardLink}" href="${escapeHtml(
                relativeHref(pagePath, item.path),
              )}">${escapeHtml(item.title)}</a>
              <span class="${CLASS.cardDetail}">${escapeHtml(
                item.detail ?? "",
              )}</span>
            </li>`;

  const documentCards = sortedBy(documents, (entry) => entry.path).map(
    (document) =>
      card({
        id: document.id,
        title: document.title,
        path: documentPagePath(context.docSlugs.get(document.id) ?? "resource"),
        detail: `${document.path} · ${document.words} words`,
      }),
  );
  const diagramCards = sortedBy(diagrams, (entry) => entry.path).map(
    (diagram) =>
      card({
        id: diagram.id,
        title: diagram.title,
        path: diagramPagePath(
          context.diagramSlugs.get(diagram.id) ?? "resource",
        ),
        detail: `${diagram.path} · ${diagram.participants} participants · ${diagram.messages} messages`,
      }),
  );

  const list = (title: string, items: string[], empty: string): string =>
    `          <section class="${CLASS.section}">
            <h2 class="${CLASS.sectionTitle}">${escapeHtml(title)}</h2>
            ${
              items.length === 0
                ? `<p class="${CLASS.empty}">${escapeHtml(empty)}</p>`
                : `<ul class="${CLASS.cardGrid}">\n${items.join("\n")}\n            </ul>`
            }
          </section>`;

  const main = `        <article>
          <h1 class="${CLASS.pageTitle}">${escapeHtml(context.projectName)}</h1>
          <p class="${CLASS.pageMeta}">${counts}</p>
${list("Documents", documentCards, "This project has no documents yet.")}
${list("Diagrams", diagramCards, "This project has no diagrams yet.")}
        </article>`;

  return textFile(
    pagePath,
    page({
      title: "Overview",
      description: `Documentation for ${context.projectName}.`,
      projectName: context.projectName,
      from: pagePath,
      current: "index",
      nav: context.nav,
      theme: context.theme,
      main,
    }),
    "text/html",
  );
}

/** The reserved events page: a placeholder that invents nothing. */
function renderEventsPage(context: PageContext): SiteFile {
  const pagePath = SITE_LAYOUT.events;
  const main = `        <article>
          <h1 class="${CLASS.pageTitle}">Events</h1>
          <p class="${CLASS.pageMeta}">Reserved page</p>
          <p class="${CLASS.empty}">This project has no events yet. When it does, this page will list them.</p>
        </article>`;

  return textFile(
    pagePath,
    page({
      title: "Events",
      description: "Event flows in this project.",
      projectName: context.projectName,
      from: pagePath,
      current: "events",
      nav: context.nav,
      theme: context.theme,
      main,
    }),
    "text/html",
  );
}

/** The severity order problems are grouped in, most serious first. */
const SEVERITIES: ReadonlyArray<ProjectDiagnostic["severity"]> = [
  "error",
  "warning",
  "info",
];

/** The class that colours one severity. */
function severityClass(severity: ProjectDiagnostic["severity"]): string {
  switch (severity) {
    case "error":
      return CLASS.severityError;
    case "warning":
      return CLASS.severityWarning;
    default:
      return CLASS.severityInfo;
  }
}

/**
 * The problems report: every diagnostic, grouped by severity.
 *
 * A diagnostic names a resource and often a 1-based line, so each row shows the
 * resource's title (falling back to its id when the resource is gone) and the
 * line, which is what a reader needs to fix it in the project.
 */
function renderProblemsPage(context: PageContext): SiteFile {
  const pagePath = SITE_LAYOUT.problems;
  const diagnostics = context.index.diagnostics;
  const titleOf = (resourceId: string): string => {
    const resource = context.index.resources.find(
      (entry) => entry.id === resourceId,
    );
    return resource?.title ?? resourceId;
  };

  const groups = SEVERITIES.map((severity) => {
    const entries = diagnostics.filter(
      (diagnostic) => diagnostic.severity === severity,
    );
    const rows = entries
      .map((diagnostic) => {
        const line =
          diagnostic.sourceRange === undefined
            ? ""
            : ` <span class="${CLASS.pageMeta}">line ${
                diagnostic.sourceRange.start.line + 1
              }</span>`;
        const code =
          diagnostic.code === undefined
            ? ""
            : ` <code>${escapeHtml(diagnostic.code)}</code>`;
        return `              <li class="${CLASS.severity} ${severityClass(
          severity,
        )}">${escapeHtml(diagnostic.message)} <span class="${CLASS.pageMeta}">in ${escapeHtml(
          titleOf(diagnostic.resourceId),
        )}</span>${line}${code}</li>`;
      })
      .join("\n");
    return `          <section class="${CLASS.section}">
            <h2 class="${CLASS.sectionTitle}">${severity} (${entries.length})</h2>
            ${
              entries.length === 0
                ? `<p class="${CLASS.empty}">None.</p>`
                : `<ul class="${CLASS.problemList}">\n${rows}\n            </ul>`
            }
          </section>`;
  }).join("\n");

  const main = `        <article>
          <h1 class="${CLASS.pageTitle}">Problems</h1>
          <p class="${CLASS.pageMeta}">${diagnostics.length} ${
            diagnostics.length === 1 ? "diagnostic" : "diagnostics"
          } reported by the project index.</p>
${groups}
        </article>`;

  return textFile(
    pagePath,
    page({
      title: "Problems",
      description: "Problems reported by the project index.",
      projectName: context.projectName,
      from: pagePath,
      current: "problems",
      nav: context.nav,
      theme: context.theme,
      main,
    }),
    "text/html",
  );
}

/** UTF-8 encode text into a {@link SiteFile}. */
function textFile(path: string, text: string, type = "text/plain"): SiteFile {
  return { path, data: new TextEncoder().encode(text), type };
}

/**
 * The site's stylesheet.
 *
 * One file, no imports and no external fonts, so the export stays offline. The
 * two colour schemes are custom properties under `[data-theme]`, which is why
 * the pages carry that attribute rather than a class.
 */
export function buildSiteCss(): string {
  return `/* Generated by the SequenceDiagrams documentation export. */
:root {
  color-scheme: light;
  --bg: #ffffff;
  --panel: #f5f6f8;
  --text: #1c1f24;
  --muted: #5b6472;
  --border: #dfe3e8;
  --accent: #1f5fbf;
  --accent-soft: #e7effb;
  --error: #b3261e;
  --warning: #8a5a00;
  --info: #245c8f;
}

[data-theme="dark"] {
  color-scheme: dark;
  --bg: #14171c;
  --panel: #1b1f26;
  --text: #e7eaf0;
  --muted: #9aa4b2;
  --border: #2b313a;
  --accent: #7aa7f0;
  --accent-soft: #1e2a3d;
  --error: #f2857c;
  --warning: #e0b055;
  --info: #8fc0f0;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: ${FONT_STACK};
  font-size: 16px;
  line-height: 1.6;
}

a {
  color: var(--accent);
}

code,
pre {
  font-family: ${MONO_STACK};
  font-size: 0.9em;
}

.site {
  display: grid;
  grid-template-columns: 18rem minmax(0, 1fr);
  grid-template-rows: 1fr auto;
  grid-template-areas: "sidebar content" "sidebar footer";
  min-height: 100vh;
}

.site__sidebar {
  grid-area: sidebar;
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 1.25rem 1rem 2rem;
  overflow-y: auto;
  max-height: 100vh;
  position: sticky;
  top: 0;
}

.site__brand {
  margin: 0 0 1rem;
  font-weight: 600;
  font-size: 1.05rem;
}

.site__content {
  grid-area: content;
  padding: 2rem clamp(1rem, 4vw, 3rem);
  max-width: 60rem;
}

.site__footer {
  grid-area: footer;
  padding: 1rem clamp(1rem, 4vw, 3rem) 2rem;
  color: var(--muted);
  font-size: 0.85rem;
}

.nav-group {
  margin-bottom: 1.25rem;
}

.nav-group__title {
  margin: 0 0 0.35rem;
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

.nav-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.nav-item {
  margin: 0 0 0.15rem;
}

.nav-item--current > .nav-link {
  font-weight: 600;
  color: var(--text);
}

.nav-item--current {
  background: var(--accent-soft);
  border-radius: 6px;
  padding: 0.15rem 0.4rem;
}

.nav-link {
  text-decoration: none;
}

.nav-link:hover {
  text-decoration: underline;
}

.nav-detail {
  display: block;
  color: var(--muted);
  font-size: 0.75rem;
  word-break: break-all;
}

.nav-empty {
  color: var(--muted);
  font-size: 0.85rem;
}

.page-title {
  margin: 0 0 0.25rem;
  font-size: 1.9rem;
}

.page-meta {
  color: var(--muted);
  font-size: 0.85rem;
  margin: 0 0 1.5rem;
}

.section {
  margin: 2rem 0;
}

.section-title {
  font-size: 1.1rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3rem;
}

.card-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 0.75rem;
}

.card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.card__link {
  font-weight: 600;
  text-decoration: none;
}

.card__detail {
  color: var(--muted);
  font-size: 0.8rem;
  word-break: break-all;
}

.empty-state {
  color: var(--muted);
}

.toc {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
}

.toc__item {
  margin: 0.1rem 0;
}

.toc__item--level-2 { padding-left: 0.75rem; }
.toc__item--level-3 { padding-left: 1.5rem; }
.toc__item--level-4 { padding-left: 2.25rem; }
.toc__item--level-5 { padding-left: 3rem; }
.toc__item--level-6 { padding-left: 3.75rem; }

.markdown table {
  border-collapse: collapse;
  width: 100%;
}

.markdown th,
.markdown td {
  border: 1px solid var(--border);
  padding: 0.35rem 0.6rem;
  text-align: left;
}

.markdown blockquote {
  margin: 1rem 0;
  padding: 0.25rem 1rem;
  border-left: 3px solid var(--border);
  color: var(--muted);
}

.markdown pre {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  overflow-x: auto;
}

.markdown img {
  max-width: 100%;
}

.embed {
  margin: 1.5rem 0;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  overflow-x: auto;
}

.embed svg {
  max-width: 100%;
  height: auto;
}

.embed__caption {
  margin-top: 0.6rem;
  color: var(--muted);
  font-size: 0.85rem;
}

.embed--missing {
  border-style: dashed;
  border-color: var(--error);
  color: var(--error);
}

.broken {
  color: var(--error);
  text-decoration: underline wavy var(--error);
}

.problem-list {
  margin: 0;
  padding-left: 1.25rem;
}

.severity--error { color: var(--error); }
.severity--warning { color: var(--warning); }
.severity--info { color: var(--info); }

@media (max-width: 48rem) {
  .site {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "sidebar" "content" "footer";
  }

  .site__sidebar {
    position: static;
    max-height: none;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}
`;
}

/**
 * Build the whole site.
 *
 * Output order is fixed: documents in path order, then diagrams in path order,
 * then the reserved pages, the overview, and the stylesheet — so the list is
 * stable and identical between runs. Page paths are derived once here (slugs are
 * unique across documents and diagrams together) and threaded into every
 * template as data.
 */
export function buildDocumentationSite(input: SiteExportInput): SiteFile[] {
  const theme = input.theme ?? "light";
  const { index } = input;

  const documents = sortedBy(index.documents, (entry) => entry.path);
  const diagrams = sortedBy(index.diagrams, (entry) => entry.path);

  // The renderer is called once per diagram and the result reused for the page
  // and the raw .svg file; it may be as expensive as a full layout, so the
  // export must not pay for it twice.
  const renders = new Map<string, string | null>(
    diagrams.map((diagram) => [
      diagram.id,
      normalizeSvg(input.renderDiagram(diagram.id)),
    ]),
  );

  // Slugs share one namespace across both kinds, so two resources with the same
  // title never produce the same href once both sit under the site root.
  const taken = new Set<string>();
  const docSlugs = uniqueSlugs(
    documents.map((document) => document.id),
    (id) => siteSlugOf(documents, id),
    taken,
  );
  const diagramSlugs = uniqueSlugs(
    diagrams.map((diagram) => diagram.id),
    (id) => siteSlugOf(diagrams, id),
    taken,
  );

  const extras: SiteNavItem[] = [];
  if (input.includeProblems) {
    extras.push({
      id: "problems",
      title: "Problems",
      path: SITE_LAYOUT.problems,
      detail: `${index.diagnostics.length} reported`,
    });
  }

  const nav = buildSiteNav(documents, diagrams, docSlugs, diagramSlugs, extras);

  const context: PageContext = {
    projectName: input.projectName,
    theme,
    index,
    contents: input.contents,
    renders,
    nav,
    docSlugs,
    diagramSlugs,
  };

  const files: SiteFile[] = [
    ...documents.map((document) => renderDocumentPage(document, context)),
    ...diagrams.map((diagram) => renderDiagramPage(diagram, context, renders)),
  ];
  diagrams.forEach((diagram) => {
    const svg = renders.get(diagram.id);
    if (svg === null || svg === undefined) return;
    const slug = diagramSlugs.get(diagram.id) ?? "resource";
    files.push(textFile(diagramSvgPath(slug), `${svg}\n`, "image/svg+xml"));
  });
  if (input.includeProblems) files.push(renderProblemsPage(context));
  files.push(renderEventsPage(context));
  files.push(renderIndexPage(context));
  files.push(textFile(SITE_LAYOUT.stylesheet, buildSiteCss(), "text/css"));

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
