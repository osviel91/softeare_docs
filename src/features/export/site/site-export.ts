/**
 * Shell-facing entry point for the static documentation export.
 *
 * `site-model.ts` already knows how to turn a project into files; this module is
 * the thin, stable seam a menu command calls. It exists for three reasons:
 *
 * - the caller's options are named for what the user asked for (`includeProblems`)
 *   rather than for how the generator is wired, so the generator's input can grow
 *   without changing the command;
 * - it returns a summary line beside the files, because the UI has to tell the
 *   user what was written without inspecting a ZIP;
 * - it keeps every browser-facing concern (a download, a folder picker) out of
 *   the generator, so the same command can write to a real filesystem later.
 *
 * Nothing here performs I/O: the caller feeds in the already-read contents and
 * renderer and decides where the returned bytes go (typically
 * `createZip` + `downloadBytes`).
 */
import {
  buildDocumentationSite,
  SITE_LAYOUT,
  type SiteExportInput,
  type SiteFile,
} from "./site-model";

/** Options for {@link exportDocumentationSite}. */
export interface SiteExportOptions {
  theme?: "light" | "dark";
  /** Extra pages to include, e.g. a problems report. */
  includeProblems?: boolean;
}

/** The site's files plus a short human-readable summary of what was written. */
export interface SiteExportResult {
  files: SiteFile[];
  /** e.g. "12 pages, 4 diagrams, 1 stylesheet". */
  summary: string;
}

/** The plural-aware noun for a count, e.g. `2 documents`. */
function count(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Describe what was written, for a status message.
 *
 * Counted from the generated file list rather than from the input, so the summary
 * can never disagree with what the user actually received. HTML pages and raw
 * SVGs are counted separately: "pages" is what a reader browses, the SVGs are
 * extras they can link or reuse.
 */
function summarize(files: SiteFile[]): string {
  const pages = files.filter((file) => file.type === "text/html").length;
  const diagrams = files.filter((file) => file.type === "image/svg+xml").length;
  const styles = files.filter((file) => file.type === "text/css").length;
  const parts = [count("page", pages)];
  if (diagrams > 0) parts.push(count("SVG", diagrams));
  if (styles > 0) parts.push(count("stylesheet", styles));
  const problems = files.some((file) => file.path === SITE_LAYOUT.problems);
  if (problems) parts.push("problems report");
  return parts.join(", ");
}

/**
 * Build the documentation site.
 *
 * @param input - The project data, contents and diagram renderer.
 * @param options - Colour scheme and extra pages.
 */
export function exportDocumentationSite(
  input: SiteExportInput,
  options: SiteExportOptions = {},
): SiteExportResult {
  const files = buildDocumentationSite({
    ...input,
    theme: options.theme ?? input.theme,
    includeProblems: options.includeProblems ?? false,
  });
  return { files, summary: summarize(files) };
}
