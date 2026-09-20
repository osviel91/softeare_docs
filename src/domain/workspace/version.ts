/**
 * Version history domain model ("Trajectory").
 *
 * Every diagram keeps an append-only timeline of the sources it has been through.
 * A {@link DiagramVersion} is one point on that timeline: a full copy of the DSL
 * source, when it was captured, and a short label explaining why. Because each
 * entry stores the whole source, restoring any point is a pure assignment — no
 * diffs to replay, no merge conflict to resolve.
 *
 * These types are framework-free and store-agnostic, exactly like the rest of
 * `src/domain/workspace`: the version store (see `src/workspace`) decides whether
 * a version lives in IndexedDB or memory.
 *
 * The timeline is intentionally capped ({@link MAX_VERSIONS_PER_DIAGRAM}) and
 * de-duplicated by content: an edit that does not change the source is never
 * recorded, so "type, undo, retype" does not fill the history with noise.
 */

/** One recorded point in a diagram's source history. */
export interface DiagramVersion {
  /** Stable, unique id within the store. */
  id: string;
  /** The diagram this version belongs to. */
  diagramId: string;
  /** The project the diagram belonged to when the version was captured. */
  projectId: string;
  /** The diagram's file name at capture time. */
  name: string;
  /** The complete DSL source at capture time. */
  source: string;
  /** When the version was captured, in milliseconds since the Unix epoch. */
  createdAt: number;
  /** A short, human-readable reason, e.g. "Auto checkpoint". */
  label: string;
}

/** The most versions kept per diagram; the oldest are pruned beyond this. */
export const MAX_VERSIONS_PER_DIAGRAM = 100;

/** How long the source must sit unchanged before an automatic checkpoint. */
export const AUTO_CHECKPOINT_DEBOUNCE_MS = 1200;

/** Label for the version captured the first time a diagram is opened. */
export const INITIAL_VERSION_LABEL = "Initial version";

/** Label for checkpoints captured automatically after edits settle. */
export const AUTO_VERSION_LABEL = "Auto checkpoint";

/** Label for checkpoints the user asks for explicitly. */
export const MANUAL_VERSION_LABEL = "Manual checkpoint";

/** Label applied to a version that was restored into the editor. */
export const RESTORED_VERSION_LABEL = "Restored from history";

/**
 * Whether two sources are the same version content. Trailing whitespace is
 * ignored so a stray newline at the end of a file is not treated as an edit.
 */
export function sameVersionContent(a: string, b: string): boolean {
  return a.replace(/\s+$/, "") === b.replace(/\s+$/, "");
}

/**
 * Format a version timestamp for display, using the browser locale.
 *
 * Returns a compact, sortable string (e.g. "Sep 20, 15:04:22") so a timeline
 * reads naturally in a narrow panel.
 */
export function formatVersionTime(createdAt: number, locale?: string): string {
  try {
    return new Date(createdAt).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return new Date(createdAt).toISOString();
  }
}

/**
 * A one-line summary of a version's source for the history list: the diagram
 * title when it has one, else the first non-empty line, else a placeholder.
 */
export function versionSummary(source: string): string {
  const lines = source.split("\n").map((line) => line.trim());
  const title = lines.find((line) => line.toLowerCase().startsWith("title "));
  const firstContent = lines.find((line) => line.length > 0);
  const summary = title ?? firstContent ?? "";
  if (summary === "") return "(empty diagram)";
  return summary.length > 60 ? `${summary.slice(0, 57)}…` : summary;
}
