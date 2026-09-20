/**
 * A name written in a document, with the exact span it occupies.
 *
 * Both documentation languages name things and refer to them elsewhere — a
 * sequence diagram its participants, an event flow its events, brokers, channels
 * and services. The editor treats those the same way: it bolds the spans, and it
 * rewrites them when the declaration's identifier is retyped. This is the shape
 * they share.
 */
import type { SourceRange } from "./diagram/ast";

export interface SourceMention {
  /** The name as written. */
  name: string;
  /** The exact span the name occupies, so a highlight or a rewrite is precise. */
  range: SourceRange;
  /**
   * What writes the name here. Each language defines its own set; the one value
   * every language shares is `"declaration"`, which marks the span a live rename
   * edits and the name it replaces everywhere else.
   */
  context: string;
}
