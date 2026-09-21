/**
 * Project-relative resource paths: the server's filesystem boundary (ADR-040).
 *
 * Every path that reaches a project's storage directory passes through
 * {@link normalizeResourcePath} first. The rule is deliberately strict and
 * deliberately boring:
 *
 * - **Relative only.** An absolute path (`/etc/passwd`, `C:\...`, a leading
 *   `~`) is a client trying to address the host, not the project.
 * - **No traversal.** `.` and `..` are rejected as segments, before or after
 *   percent-decoding, so `../../etc` and `%2e%2e%2f%2e%2e%2fetc` both fail.
 * - **One separator.** `/` is the only separator; `\` is rejected rather than
 *   translated, because translating it is how `..\..\` slips through on some
 *   hosts.
 * - **No NUL, no control characters**, no empty segments, no trailing slash.
 * - **Bounded length**, so a path cannot be used to exhaust a filesystem.
 *
 * The result is a *canonical* path: two spellings of the same file normalise to
 * the same string, which is also what makes the `(project_id, path)` unique
 * constraint meaningful rather than decorative.
 *
 * A decoded path is checked too. A resource path may legally contain a percent
 * sign (a file really called `50%.seq`), so the check is not "reject `%`": it is
 * "decode it, and reject the result if decoding changes the structure".
 *
 * The error type it throws is defined in the application layer
 * (`src/application/ports/resource-path.ts`), because the use cases that catch it
 * live there; it is re-exported here so a caller of this module does not have to
 * know that.
 */
import { InvalidResourcePathError } from "../application/ports/resource-path";

export { InvalidResourcePathError };

/** The longest path a resource may have, in characters. */
export const MAX_RESOURCE_PATH_LENGTH = 512;

/** The longest single segment a resource path may have. */
export const MAX_RESOURCE_SEGMENT_LENGTH = 200;

/** Control characters, including NUL, are never legal in a resource path. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Whether a path segment is a traversal or self reference. */
function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/**
 * Normalise a client-supplied resource path.
 *
 * @throws {InvalidResourcePathError} when the path is not a safe, project-relative
 *   `/`-separated path.
 */
export function normalizeResourcePath(input: string): string {
  if (typeof input !== "string") {
    throw new InvalidResourcePathError(
      String(input),
      "a path must be a string",
    );
  }
  if (input === "") {
    throw new InvalidResourcePathError(input, "a path must not be empty");
  }
  if (input.length > MAX_RESOURCE_PATH_LENGTH) {
    throw new InvalidResourcePathError(
      input,
      `a path must be at most ${MAX_RESOURCE_PATH_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTERS.test(input)) {
    throw new InvalidResourcePathError(
      input,
      "a path must not contain control characters",
    );
  }
  if (input.includes("\\")) {
    throw new InvalidResourcePathError(
      input,
      "a path must use / as its only separator",
    );
  }
  if (input.startsWith("/")) {
    throw new InvalidResourcePathError(
      input,
      "a path must be project-relative, not absolute",
    );
  }
  // A Windows drive letter (`C:`) or a UNC-ish `//` prefix both mean the caller
  // is addressing a volume rather than the project.
  if (/^[a-zA-Z]:/.test(input)) {
    throw new InvalidResourcePathError(
      input,
      "a path must not name a drive or volume",
    );
  }
  if (input.startsWith("~")) {
    throw new InvalidResourcePathError(input, "a path must not start with ~");
  }

  const segments = input.split("/");
  const canonical: string[] = [];
  for (const raw of segments) {
    if (raw === "") {
      throw new InvalidResourcePathError(
        input,
        "a path must not contain empty segments",
      );
    }
    if (isDotSegment(raw)) {
      throw new InvalidResourcePathError(
        input,
        "a path must not contain a . or .. segment",
      );
    }
    if (raw.length > MAX_RESOURCE_SEGMENT_LENGTH) {
      throw new InvalidResourcePathError(
        input,
        `a path segment must be at most ${MAX_RESOURCE_SEGMENT_LENGTH} characters`,
      );
    }
    canonical.push(raw);
  }

  const normalized = canonical.join("/");

  // Percent-encoding must not hide a structural change: `%2e%2e%2f` decodes to
  // `../`. A path is therefore decoded and the result re-checked — but a path
  // that simply *is not* valid percent-encoding is a legal file name, not an
  // attack: a document really called `50%-done.md` must keep working, and a
  // string that decodes to nothing dangerous has nowhere to hide.
  let decoded: string | null = null;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    decoded = null;
  }
  if (decoded !== null && decoded !== normalized) {
    assertDecodedIsSafe(input, decoded);
  }

  return normalized;
}

/**
 * Check a percent-decoded path.
 *
 * A decoded value is accepted only when it stays inside the project in exactly
 * the same shape: no absolute form, no separator change, no dot segment. This
 * is what keeps `%2e%2e%2fetc` out while allowing an ordinary `50%.seq`.
 */
function assertDecodedIsSafe(original: string, decoded: string): void {
  if (
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.startsWith("~")
  ) {
    throw new InvalidResourcePathError(
      original,
      "a percent-encoded path may not decode to an absolute or backslash path",
    );
  }
  if (CONTROL_CHARACTERS.test(decoded)) {
    throw new InvalidResourcePathError(
      original,
      "a percent-encoded path may not decode to control characters",
    );
  }
  for (const segment of decoded.split("/")) {
    if (segment === "" || isDotSegment(segment)) {
      throw new InvalidResourcePathError(
        original,
        "a percent-encoded path may not decode to a . or .. segment",
      );
    }
  }
}

/** Whether a path is safe to use, without throwing. */
export function isSafeResourcePath(input: string): boolean {
  try {
    normalizeResourcePath(input);
    return true;
  } catch {
    return false;
  }
}

/** The last segment of a resource path. */
export function resourceFileName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** The extension of a resource path, lower-cased, including the dot. */
export function resourceExtension(path: string): string {
  const name = resourceFileName(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index).toLowerCase();
}
