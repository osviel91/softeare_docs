/**
 * Portable project archive: a project as a ZIP of human-readable files.
 *
 * The archive is deliberately the same documentation tree the app shows, only
 * packaged for moving between machines or into version control. A project is a
 * directory containing its manifest and its files, split by kind the way the
 * target workspace layout is:
 *
 * ```
 * payments-service/
 *   project.json            the manifest: project identity + resource index
 *   diagrams/checkout.seq
 *   docs/architecture.md
 * ```
 *
 * The manifest carries each resource's stable id, its original file name, and
 * the path it occupies in the archive. Keeping both `name` and `path` means the
 * archive can use readable, extension-correct paths while an import still
 * restores exactly the names the project had — which matters because an
 * in-browser diagram's name need not carry an extension at all.
 *
 * Nothing here knows about the DOM: it turns domain files into {@link ZipEntry}
 * values and back, so both halves are testable without a browser.
 */
import { ensureMarkdownExtension } from "../../domain/workspace/note";
import type { ResourceKind } from "../../domain/workspace/resource";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../../domain/workspace/types";
import { err, ok, type Result } from "../../shared/result/result";
import { createZip, readZip, type ZipEntry } from "./zip";

/** The `format` marker every manifest must carry. */
export const PROJECT_ARCHIVE_FORMAT = "sequencediagrams-project";
/** The manifest schema version this module reads and writes. */
export const PROJECT_ARCHIVE_VERSION = 1;
/** The manifest's file name inside the project directory. */
export const PROJECT_MANIFEST_NAME = "project.json";
/** Where diagram files are placed inside a project directory. */
export const DIAGRAMS_DIRECTORY = "diagrams";
/** Where markdown documents are placed inside a project directory. */
export const DOCS_DIRECTORY = "docs";

/** One resource recorded in the manifest. */
export interface ArchiveResource {
  /** Which kind of resource this is. */
  kind: ResourceKind;
  /** The resource's stable id inside the exporting workspace. */
  id: string;
  /** The file name it had in the exporting project. */
  name: string;
  /**
   * Where its content lives, **relative to the project directory** (for example
   * `diagrams/checkout.seq`). Relative paths keep an archive valid when its
   * project directory is renamed or moved.
   */
  path: string;
}

/** The manifest written to `project.json`. */
export interface ProjectArchiveManifest {
  format: string;
  version: number;
  project: { id: string; name: string };
  resources: ArchiveResource[];
}

/**
 * A project in the storage-agnostic shape an import reconstructs.
 *
 * This is what the UI hands to the workspace: names and content, with no ids
 * from the exporting machine, so importing never collides with anything local.
 */
export interface ImportedProject {
  /** The project's display name. */
  name: string;
  diagrams: Array<{ name: string; source: string }>;
  notes: Array<{ name: string; markdown: string }>;
}

/** Turn a project name into a filesystem-safe directory name. */
export function archiveSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return slug === "" ? "project" : slug;
}

/** Give `name` the extension when it does not already carry one. */
function withExtension(name: string, extension: string): string {
  return /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.${extension}`;
}

/** Strip path separators and reserved characters from a single file name. */
function safeFileName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, "-");
  return cleaned === "" ? "untitled" : cleaned;
}

/** The archive path a resource occupies, unique within its directory. */
function uniquePath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) {
    taken.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  const base = dot === -1 ? path : path.slice(0, dot);
  const extension = dot === -1 ? "" : path.slice(dot);
  let index = 2;
  while (taken.has(`${base}-${index}${extension}`)) index += 1;
  const unique = `${base}-${index}${extension}`;
  taken.add(unique);
  return unique;
}

/** UTF-8 encode text for an archive entry. */
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Build the archive for one project: a manifest plus a file per resource.
 *
 * @param project - The project being exported.
 * @param diagrams - Its diagram files, in display order.
 * @param notes - Its markdown files, in display order.
 */
export function buildProjectArchive(
  project: Project,
  diagrams: DiagramFile[],
  notes: NoteFile[],
): ZipEntry[] {
  const slug = archiveSlug(project.name);
  const takenDiagramPaths = new Set<string>();
  const takenNotePaths = new Set<string>();
  const resources: ArchiveResource[] = [];
  const entries: ZipEntry[] = [];

  for (const diagram of diagrams) {
    const path = uniquePath(
      `${DIAGRAMS_DIRECTORY}/${withExtension(
        safeFileName(diagram.name),
        "seq",
      )}`,
      takenDiagramPaths,
    );
    resources.push({
      kind: "diagram",
      id: diagram.id,
      name: diagram.name,
      path,
    });
    entries.push({ path: `${slug}/${path}`, data: encode(diagram.source) });
  }

  for (const note of notes) {
    const path = uniquePath(
      `${DOCS_DIRECTORY}/${ensureMarkdownExtension(safeFileName(note.name))}`,
      takenNotePaths,
    );
    resources.push({
      kind: "note",
      id: note.id,
      name: note.name,
      path,
    });
    entries.push({ path: `${slug}/${path}`, data: encode(note.markdown) });
  }

  const manifest: ProjectArchiveManifest = {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    project: { id: project.id, name: project.name },
    resources,
  };
  // The manifest comes first so a human opening the ZIP sees it immediately.
  return [
    {
      path: `${slug}/${PROJECT_MANIFEST_NAME}`,
      data: encode(JSON.stringify(manifest, null, 2)),
    },
    ...entries,
  ];
}

/** Serialize a project straight to ZIP bytes. */
export function exportProjectToZip(
  project: Project,
  diagrams: DiagramFile[],
  notes: NoteFile[],
): Uint8Array {
  return createZip(buildProjectArchive(project, diagrams, notes));
}

/** Validate a parsed manifest, returning an error message when invalid. */
function validateManifest(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return "the manifest is not a JSON object";
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== PROJECT_ARCHIVE_FORMAT) {
    return `unexpected format ${JSON.stringify(manifest.format)}`;
  }
  if (manifest.version !== PROJECT_ARCHIVE_VERSION) {
    return `unsupported archive version ${JSON.stringify(manifest.version)}`;
  }
  const project = manifest.project;
  if (typeof project !== "object" || project === null) {
    return "the manifest has no project";
  }
  const { name } = project as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") {
    return "the project has no name";
  }
  if (!Array.isArray(manifest.resources)) {
    return "the manifest has no resources array";
  }
  for (const [index, resource] of manifest.resources.entries()) {
    if (typeof resource !== "object" || resource === null) {
      return `resources[${index}] is not an object`;
    }
    const entry = resource as Record<string, unknown>;
    if (entry.kind !== "diagram" && entry.kind !== "note") {
      return `resources[${index}] has unknown kind ${JSON.stringify(entry.kind)}`;
    }
    if (typeof entry.name !== "string" || typeof entry.path !== "string") {
      return `resources[${index}] needs a string name and path`;
    }
  }
  return null;
}

/** The manifest entry of an archive: `<project>/project.json`. */
function findManifestEntry(entries: ZipEntry[]): ZipEntry | null {
  return (
    entries.find((entry) => entry.path === PROJECT_MANIFEST_NAME) ??
    entries.find((entry) => entry.path.endsWith(`/${PROJECT_MANIFEST_NAME}`)) ??
    null
  );
}

/** The directory a manifest lives in, without a trailing slash. */
function projectDirectoryOf(manifestPath: string): string {
  const index = manifestPath.lastIndexOf("/");
  return index === -1 ? "" : manifestPath.slice(0, index);
}

/** Resolve a manifest resource path against the manifest's own directory. */
function resolveEntryPath(directory: string, resourcePath: string): string {
  return directory === "" ? resourcePath : `${directory}/${resourcePath}`;
}

/**
 * Read a project archive back into the shape an import restores.
 *
 * Every failure is a value, not a throw: a ZIP the writer could not read, a
 * missing or malformed manifest, or a resource whose file is absent from the
 * archive all come back as a descriptive error.
 */
export function parseProjectArchive(
  entries: ZipEntry[],
): Result<ImportedProject, Error> {
  const manifestEntry = findManifestEntry(entries);
  if (!manifestEntry) {
    return err(new Error(`Archive has no ${PROJECT_MANIFEST_NAME} manifest`));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestEntry.data));
  } catch (error) {
    return err(
      new Error(
        `Manifest is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }

  const problem = validateManifest(parsed);
  if (problem) return err(new Error(`Invalid project manifest: ${problem}`));

  const manifest = parsed as ProjectArchiveManifest;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const decoder = new TextDecoder();
  const directory = projectDirectoryOf(manifestEntry.path);

  const imported: ImportedProject = {
    name: manifest.project.name.trim(),
    diagrams: [],
    notes: [],
  };

  for (const resource of manifest.resources) {
    const entry = byPath.get(resolveEntryPath(directory, resource.path));
    if (!entry) {
      return err(
        new Error(`Archive is missing "${resource.path}" for ${resource.name}`),
      );
    }
    const text = decoder.decode(entry.data);
    if (resource.kind === "diagram") {
      imported.diagrams.push({ name: resource.name, source: text });
    } else {
      imported.notes.push({ name: resource.name, markdown: text });
    }
  }

  return ok(imported);
}

/** Read ZIP bytes straight into an importable project. */
export function importProjectFromZip(
  bytes: Uint8Array,
): Result<ImportedProject, Error> {
  const entries = readZip(bytes);
  if (!entries.ok) return entries;
  return parseProjectArchive(entries.value);
}
