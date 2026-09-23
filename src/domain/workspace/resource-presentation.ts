/** Information derived for presenting a resource, never stored as metadata. */
export interface ResourcePresentation {
  /** The title shown to a user or consumer. */
  effectiveTitle: string;
  /** Whether the title came from resource content or its name. */
  titleSource: "content" | "name";
}

/**
 * Choose a resource's effective title from an existing content title or name.
 *
 * Callers supply the current language-specific fallback so this abstraction
 * does not change title behavior for diagrams, event flows, or Markdown.
 */
export function deriveResourcePresentation(
  nameFallback: string,
  contentTitle?: string,
): ResourcePresentation {
  const title = contentTitle?.trim();
  return title
    ? { effectiveTitle: title, titleSource: "content" }
    : { effectiveTitle: nameFallback, titleSource: "name" };
}
