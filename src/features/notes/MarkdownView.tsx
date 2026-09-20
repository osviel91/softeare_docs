/**
 * Rendered markdown document.
 *
 * Renders the HTML produced by the pure markdown module and turns project links
 * into navigation: markup carries `data-diagram-link` (a `[[Name]]` wiki-link) or
 * `data-resource-link` (an ordinary relative link the app can open), and a single
 * delegated click handler on the container reports the target to the shell. That
 * keeps link resolution out of the renderer (which must not know about the
 * workspace) and out of every individual anchor.
 */
import { useMemo, type MouseEvent as ReactMouseEvent } from "react";
import {
  renderMarkdownToHtml,
  type MarkdownOptions,
} from "../../language/markdown/markdown";

export interface MarkdownViewProps {
  /** The markdown to render. */
  markdown: string;
  /** Resolve a wiki-link target to an href, or `null` when it is unresolved. */
  resolveWikiLink?: MarkdownOptions["resolveWikiLink"];
  /** Resolve a project-relative link to an href, or `null` when it is external. */
  resolveResourceLink?: MarkdownOptions["resolveResourceLink"];
  /** Render a `{{kind:target}}` embed, or `null` when it does not resolve. */
  renderEmbed?: MarkdownOptions["renderEmbed"];
  /** Called with a wiki-link target when the user activates the link. */
  onOpenDiagramLink?: (target: string) => void;
  /** Called with a project-relative href when the user activates the link. */
  onOpenResourceLink?: (href: string) => void;
}

/** The value of `attribute` on the closest ancestor that carries it. */
function linkTargetFrom(
  target: EventTarget | null,
  attribute: string,
): string | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest(`[${attribute}]`);
  return link?.getAttribute(attribute) ?? null;
}

export default function MarkdownView({
  markdown,
  resolveWikiLink,
  resolveResourceLink,
  renderEmbed,
  onOpenDiagramLink,
  onOpenResourceLink,
}: MarkdownViewProps) {
  const html = useMemo(
    () =>
      renderMarkdownToHtml(markdown, {
        resolveWikiLink,
        resolveResourceLink,
        renderEmbed,
      }),
    [markdown, resolveWikiLink, resolveResourceLink, renderEmbed],
  );

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // An embedded diagram is a picture of another resource; clicking it opens
    // that resource's source, which is what makes the document navigable.
    const embed = linkTargetFrom(event.target, "data-embed-resource");
    if (embed !== null) {
      if (!onOpenResourceLink) return;
      event.preventDefault();
      onOpenResourceLink(embed);
      return;
    }

    // A project link navigates inside the app; never follow the placeholder href.
    const resource = linkTargetFrom(event.target, "data-resource-link");
    if (resource !== null) {
      if (!onOpenResourceLink) return;
      event.preventDefault();
      onOpenResourceLink(resource);
      return;
    }

    const diagram = linkTargetFrom(event.target, "data-diagram-link");
    if (diagram === null || !onOpenDiagramLink) return;
    event.preventDefault();
    onOpenDiagramLink(diagram);
  };

  return (
    <div className="note-preview" data-testid="note-preview">
      <article
        className="markdown"
        data-testid="markdown-body"
        // The markdown module escapes every piece of user text, so the generated
        // HTML contains only its own tags.
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={onClick}
      />
    </div>
  );
}
