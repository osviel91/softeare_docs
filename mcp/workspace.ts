/**
 * The documentation workspace an MCP tool operates on.
 *
 * This is the application service the tool layer calls: it opens a directory as
 * a workspace, reads and writes the projects inside it, and answers the
 * questions a documentation agent asks — what exists, what does this document
 * say, is it valid, what does it render to, where is this symbol used, what is
 * still missing. Everything it does is built on the layers the app already has:
 *
 * - the same `WorkspaceRepository` (here over Node's filesystem) that backs a
 *   folder project in the browser,
 * - the same project service that reconciles `project.json` and gives files
 *   stable ids,
 * - the same incremental indexer, validator, outline, search and renderer.
 *
 * Nothing about the documentation domain is re-implemented here. This module is
 * the seam ADR-022 anticipated ("the natural seam for an agent-facing API") and
 * the reason the MCP server cannot disagree with the editor about what a
 * document means.
 *
 * A workspace mirrors the app's folder model (ADR-005): a subdirectory is a
 * project, and inside it `.md` is a document, `.eventseq` an event flow, and
 * anything else a sequence diagram. Errors are thrown as plain `Error`s with a
 * message written for the model to act on; the tool layer turns them into MCP
 * tool-execution errors.
 */
import { createLocalWorkspaceProvider } from "../src/application/local-workspace-provider";
import {
  isRevisionedRepository,
  type ProjectWorkspace,
  type ProjectWorkspaceProvider,
} from "../src/application/ports";
import {
  loadProjectSnapshot,
  recordResourceRename,
  toSourceFiles,
  type ProjectSnapshot,
} from "../src/application/project-service";
import { createProjectIndexer } from "../src/domain/project/indexer";
import type {
  ProjectDiagnostic,
  ProjectIndex,
  ResourceDescriptor,
} from "../src/domain/project/project-index";
import { findSymbolReferences } from "../src/domain/project/references";
import { analyzeResource } from "../src/domain/project/resource-analysis";
import {
  eventFlowOutline,
  markdownOutline,
  sequenceOutline,
  type OutlineNode,
} from "../src/domain/outline/outline";
import {
  runSearch,
  type SearchDocument,
  type SearchMatch,
} from "../src/domain/search/project-search";
import {
  resourceKindOf,
  type ResourceType,
} from "../src/domain/workspace/resource-id";
import {
  addResourceRelationship,
  removeResourceRelationships,
} from "../src/domain/workspace/metadata";
import {
  validateResourceRelationship,
  type ResourceRelationship,
} from "../src/domain/workspace/resource-relationship";
import { ensureMarkdownExtension } from "../src/domain/workspace/note";
import { createEmptyMetadata } from "../src/domain/workspace/metadata";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../src/domain/workspace/types";
import { analyze } from "../src/language/analyze";
import { analyzeEventFlow } from "../src/language/eventflow/parser";
import { renderDiagramDocument } from "../src/renderer/pipeline/diagram-to-svg";
import { renderEventFlowDocument } from "../src/renderer/pipeline/eventflow-to-svg";
import type { RenderOptions } from "../src/renderer/svg/sequence-svg-renderer";
import type { EventFlowRenderOptions } from "../src/renderer/svg/eventflow-svg-renderer";
import { isOk, type Result } from "../src/shared/result/result";
import { ApplicationError } from "../src/application/errors";
import {
  createNodeDirectoryHandle,
  resolveInside,
  writeTextFile,
} from "./node-fs";

/** A language diagnostic in the flat, JSON-friendly shape tools return. */
export interface DiagnosticView {
  severity: "error" | "warning" | "info";
  code?: string;
  message: string;
  resourceId: string;
  resourcePath?: string;
  /** 1-based line of the problem, when the language layer knows one. */
  line?: number;
  /** 1-based column of the problem, when the language layer knows one. */
  column?: number;
}

/** How much of each language a resource contains, for summaries. */
export interface ResourceMetrics {
  participants: number;
  messages: number;
  words: number;
  events: number;
  producers: number;
  consumers: number;
  channels: number;
}

/** One resource as the tools describe it. */
export interface ResourceSummary {
  /** The stable id documentation refers to (survives a rename). */
  id: string;
  /** The project-relative path, which a rename changes. */
  path: string;
  type: ResourceType;
  /** Which store the file lives in. */
  kind: "diagram" | "note";
  /** The display title: the `title` line, the first heading, or the path. */
  title: string;
  /** Whether the document declares a title of its own. */
  titleDeclared: boolean;
  metrics: ResourceMetrics;
  complementaryViews: ResourceRelationship[];
}

/** A project and the shape of its documentation, for `list_projects`. */
export interface ProjectSummary {
  id: string;
  name: string;
  resources: number;
  diagrams: number;
  eventFlows: number;
  documents: number;
  errors: number;
  warnings: number;
}

/** The resource a tool call resolved to, plus its text. */
export interface ResourceContent {
  resource: ResourceSummary;
  content: string;
}

/** Options for `render_diagram`. */
export interface RenderRequest {
  theme?: "light" | "dark";
  background?: string;
  padding?: number;
  includeTitle?: boolean;
  /** A workspace-relative path to write the SVG to, when the agent wants a file. */
  output?: string;
}

/** The outcome of a render. */
export interface RenderResult {
  format: "svg";
  width: number;
  height: number;
  bytes: number;
  /** The SVG text, present when no `output` path was requested. */
  svg?: string;
  /** The workspace-relative path written, when one was requested. */
  output?: string;
  resource: string;
}

/** One entry of the documentation audit. */
export interface DocumentationFinding {
  severity: "error" | "warning" | "info";
  /** A stable machine-readable code, e.g. `broken-link`. */
  code: string;
  message: string;
  resourceId?: string;
  path?: string;
  line?: number;
  /** What to do about it, phrased as an instruction. */
  suggestion?: string;
}

/** The full audit report. */
export interface DocumentationAudit {
  project: { id: string; name: string };
  summary: {
    resources: number;
    documents: number;
    diagrams: number;
    links: number;
    errors: number;
    warnings: number;
    suggestions: number;
  };
  findings: DocumentationFinding[];
}

/** Unwrap a `Result`, throwing the failure's message as a tool-facing error. */
function unwrap<T>(result: Result<T, Error>): T {
  if (!isOk(result)) throw result.error;
  return result.value;
}

/**
 * Enforce an expected revision against a store that has them.
 *
 * Three cases, all explicit: no expectation (nothing to check); an expectation
 * against a store without revisions (a client using the wrong store — refused
 * rather than silently ignored); and an expectation against a revisioned store
 * (checked, and a failure aborts the write).
 */
async function expectRevision(
  repo: ProjectWorkspace["repo"],
  projectId: string,
  path: string,
  expectedRevision: number | undefined,
): Promise<void> {
  if (expectedRevision === undefined) return;
  if (!isRevisionedRepository(repo)) {
    throw new ApplicationError(
      "invalid",
      "This workspace does not support revision checks, so an expectedRevision cannot be honoured.",
    );
  }
  const checked = await repo.expectRevision(projectId, path, expectedRevision);
  if (!isOk(checked)) throw checked.error;
}

/** The current revision of a resource, when the store carries revisions. */
async function revisionOfResource(
  repo: ProjectWorkspace["repo"],
  projectId: string,
  path: string,
): Promise<number | undefined> {
  if (!isRevisionedRepository(repo)) return undefined;
  const result = await repo.revisionOf(projectId, path);
  return isOk(result) ? (result.value ?? undefined) : undefined;
}

/** The repository id of a file: `<project>/<file name>`. */
function fullPath(project: Project, name: string): string {
  return `${project.id}/${name}`;
}

/** The last segment of a `/`-separated path. */
function baseName(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
}

/** The zero metrics, for a resource kind that has none of them. */
function emptyMetrics(): ResourceMetrics {
  return {
    participants: 0,
    messages: 0,
    words: 0,
    events: 0,
    producers: 0,
    consumers: 0,
    channels: 0,
  };
}

/** Map one project diagnostic onto the flat tool shape. */
function diagnosticView(
  diagnostic: ProjectDiagnostic,
  pathOf: (resourceId: string) => string | undefined,
): DiagnosticView {
  const view: DiagnosticView = {
    severity: diagnostic.severity,
    message: diagnostic.message,
    resourceId: diagnostic.resourceId,
  };
  if (diagnostic.code !== undefined) view.code = diagnostic.code;
  const resourcePath = pathOf(diagnostic.resourceId);
  if (resourcePath !== undefined) view.resourcePath = resourcePath;
  if (diagnostic.sourceRange) {
    view.line = diagnostic.sourceRange.start.line + 1;
    view.column = diagnostic.sourceRange.start.column + 1;
  }
  return view;
}

/** The language type a requested resource kind maps onto. */
export type ResourceKindInput = "diagram" | "note" | "event-flow";

/** The resource type a tool's `kind` argument names. */
export function resourceTypeOfInput(kind: ResourceKindInput): ResourceType {
  switch (kind) {
    case "note":
      return "markdown-document";
    case "event-flow":
      return "event-flow";
    default:
      return "sequence-diagram";
  }
}

/**
 * A workspace on disk, with the operations a documentation agent needs.
 *
 * One instance is stateless between calls beyond the repository and the default
 * project name, so it is safe to reuse for a whole session.
 */
export class DocumentationWorkspace {
  /**
   * @param provider - The source of project workspaces this service reads and
   *   writes through: a directory of projects in local mode, the server's
   *   project registry in server mode.
   * @param defaultProject - A project id/name used when a tool omits `project`.
   */
  private constructor(
    private readonly provider: ProjectWorkspaceProvider,
    private readonly defaultProject: string | undefined,
  ) {}

  /** A human-readable name for this workspace (its directory, in local mode). */
  get describe(): string {
    return this.provider.describe();
  }

  /** Open a directory as a workspace (local mode). */
  static open(root: string, defaultProject?: string): DocumentationWorkspace {
    return new DocumentationWorkspace(
      createLocalWorkspaceProvider(root, createNodeDirectoryHandle),
      defaultProject,
    );
  }

  /**
   * Build a service over any provider.
   *
   * This is the seam every host uses. The HTTP API and the MCP adapter construct
   * the same service with a different provider, so they cannot disagree about
   * what a resource means, what its diagnostics are, or what a revision is.
   */
  static over(
    provider: ProjectWorkspaceProvider,
    defaultProject?: string,
  ): DocumentationWorkspace {
    return new DocumentationWorkspace(provider, defaultProject);
  }

  /** The project and its resource store, or an error naming what is missing. */
  private async workspaceOf(project: Project): Promise<ProjectWorkspace> {
    const workspace = await this.provider.openProject(project);
    if (workspace === null) {
      throw new Error(
        `Project "${project.id}" is not reachable through this workspace.`,
      );
    }
    return workspace;
  }

  /** Every project in the workspace, with its documentation counts. */
  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await this.provider.listProjects();
    const summaries: ProjectSummary[] = [];
    for (const project of projects) {
      summaries.push(await this.projectSummary(project));
    }
    return summaries;
  }

  /** The counts and diagnostic totals of one project. */
  async projectSummary(project: Project): Promise<ProjectSummary> {
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const errors = index.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    ).length;
    const warnings = index.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    ).length;
    return {
      id: project.id,
      name: project.name,
      resources: index.resources.length,
      diagrams: index.diagrams.length,
      eventFlows: index.eventFlows.length,
      documents: index.documents.length,
      errors,
      warnings,
    };
  }

  /**
   * Resolve the project a tool named, falling back to the server's default.
   *
   * A missing name is only an error when the choice is genuinely ambiguous: a
   * workspace with exactly one project resolves it, which keeps the common
   * single-project case free of ceremony.
   */
  async resolveProject(name?: string): Promise<Project> {
    const wanted = (name ?? this.defaultProject ?? "").trim();
    const projects = await this.provider.listProjects();
    if (wanted === "") {
      if (projects.length === 1) return projects[0];
      if (projects.length === 0) {
        throw new Error(
          "This workspace has no projects. Create one first with create_project (a project is a subdirectory of the workspace).",
        );
      }
      throw new Error(
        `Several projects exist, so "project" is required. Available: ${projects
          .map((project) => project.id)
          .join(", ")}.`,
      );
    }
    const lower = wanted.toLowerCase();
    const match =
      projects.find((project) => project.id === wanted) ??
      projects.find((project) => project.name === wanted) ??
      projects.find((project) => project.id.toLowerCase() === lower) ??
      projects.find((project) => project.name.toLowerCase() === lower);
    if (!match) {
      const available =
        projects.length === 0
          ? "(none)"
          : projects.map((project) => project.id).join(", ");
      throw new Error(
        `Unknown project "${wanted}". Available projects: ${available}.`,
      );
    }
    return match;
  }

  /** Create a project directory and seed its identity record. */
  async createProject(name: string): Promise<ProjectSummary> {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("A project name is required.");
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      throw new Error(
        "A project name must not contain a path separator; it names one subdirectory of the workspace.",
      );
    }
    const existing = await this.provider.listProjects();
    const clash = existing.find((project) => project.name === trimmed);
    if (clash) {
      throw new Error(
        `A project named "${trimmed}" already exists (id: "${clash.id}").`,
      );
    }
    const project = await this.provider.createProject(trimmed);
    if (project === null) {
      throw new Error("This workspace does not support creating projects.");
    }
    const { repo } = await this.workspaceOf(project);
    // Materialise the identity record immediately, so the project is
    // self-describing before its first file exists: an agent (or a human) can
    // read `project.json` to learn the project's shape without the app.
    unwrap(await repo.writeProjectMetadata(project.id, createEmptyMetadata()));
    // Reading the snapshot reconciles the record against the files, which is
    // what gives the first resource its stable id.
    await this.snapshot(project);
    return this.projectSummary(project);
  }

  /** Read a project's files and its reconciled identity record. */
  async snapshot(project: Project): Promise<ProjectSnapshot> {
    const { repo } = await this.workspaceOf(project);
    return unwrap(await loadProjectSnapshot(repo, project));
  }

  /** Build the project index from a snapshot, or read one first when omitted. */
  async index(
    project: Project,
    snapshot?: ProjectSnapshot,
  ): Promise<ProjectIndex> {
    const current = snapshot ?? (await this.snapshot(project));
    const indexer = createProjectIndexer();
    return indexer.update(
      project.id,
      toSourceFiles(
        project.id,
        current.diagrams,
        current.notes,
        current.metadata,
      ),
      current.metadata,
    );
  }

  /** Every resource in a project, described for the model. */
  async listResources(project: Project): Promise<ResourceSummary[]> {
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    return index.resources.map((descriptor) =>
      this.summarize(descriptor, index, snapshot.metadata.relationships),
    );
  }

  async listRelationships(project: Project): Promise<ResourceRelationship[]> {
    return (await this.snapshot(project)).metadata.relationships ?? [];
  }

  async createRelationship(
    project: Project,
    input: ResourceRelationship,
  ): Promise<ResourceRelationship> {
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const relationship = validateResourceRelationship(input, index.resources);
    unwrap(
      await (await this.workspaceOf(project)).repo.writeProjectMetadata(
        project.id,
        addResourceRelationship(snapshot.metadata, relationship),
      ),
    );
    return relationship;
  }

  async deleteRelationshipsForResource(project: Project, resourceId: string): Promise<void> {
    const snapshot = await this.snapshot(project);
    unwrap(
      await (await this.workspaceOf(project)).repo.writeProjectMetadata(
        project.id,
        removeResourceRelationships(snapshot.metadata, resourceId),
      ),
    );
  }

  /** Describe a project as a dashboard: counts, symbols, diagnostics. */
  async overview(project: Project): Promise<Record<string, unknown>> {
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const bySeverity = { error: 0, warning: 0, info: 0 };
    for (const diagnostic of index.diagnostics)
      bySeverity[diagnostic.severity]++;

    const symbolsByKind = new Map<string, string[]>();
    for (const symbol of index.participants) {
      const names = symbolsByKind.get(symbol.kind) ?? [];
      names.push(symbol.name);
      symbolsByKind.set(symbol.kind, names);
    }

    return {
      project: { id: project.id, name: project.name },
      counts: {
        resources: index.resources.length,
        diagrams: index.diagrams.length,
        eventFlows: index.eventFlows.length,
        documents: index.documents.length,
        symbols: index.participants.length,
        references: index.references.length,
        diagnostics: index.diagnostics.length,
      },
      diagnosticsBySeverity: bySeverity,
      symbols: Object.fromEntries(
        [...symbolsByKind.entries()].map(([kind, names]) => [
          kind,
          [...new Set(names)].sort(),
        ]),
      ),
      resources: index.resources.map((descriptor) => {
        const summary = this.summarize(descriptor, index);
        return {
          id: summary.id,
          path: summary.path,
          type: summary.type,
          title: summary.title,
          titleDeclared: summary.titleDeclared,
        };
      }),
    };
  }

  /** Resolve a resource by id, path, file name, or title. */
  resolveResource(index: ProjectIndex, reference: string): ResourceDescriptor {
    const wanted = reference.trim();
    if (wanted === "") throw new Error("A resource reference is required.");
    const exactId = index.resources.find((entry) => entry.id === wanted);
    if (exactId) return exactId;
    const exactPath = index.resources.find((entry) => entry.path === wanted);
    if (exactPath) return exactPath;

    const wantedBase = baseName(wanted).toLowerCase();
    const byBase = index.resources.filter(
      (entry) => baseName(entry.path).toLowerCase() === wantedBase,
    );
    if (byBase.length === 1) return byBase[0];

    // A reference written without its extension ("checkout-flow" for
    // "checkout-flow.seq") is the most natural way to name a resource, so the
    // stem is matched before giving up. Only a unique match resolves, which
    // keeps `checkout-flow.seq` and `checkout-flow.eventseq` from being
    // confused for one another.
    const wantedStem = wantedBase.replace(/\.[^./\\]+$/, "");
    const byStem = index.resources.filter(
      (entry) =>
        baseName(entry.path)
          .toLowerCase()
          .replace(/\.[^./\\]+$/, "") === wantedStem,
    );
    if (byStem.length === 1) return byStem[0];

    const wantedLower = wanted.toLowerCase();
    const byTitle = index.resources.filter(
      (entry) => entry.title.toLowerCase() === wantedLower,
    );
    if (byTitle.length === 1) return byTitle[0];

    const ambiguous = [...byBase, ...byStem, ...byTitle];
    if (ambiguous.length > 1) {
      throw new Error(
        `"${wanted}" is ambiguous. Candidates: ${ambiguous
          .map((entry) => `${entry.id} (${entry.path})`)
          .join(", ")}.`,
      );
    }
    throw new Error(
      `No resource matches "${wanted}". Available: ${
        index.resources.map((entry) => entry.id).join(", ") || "(none)"
      }.`,
    );
  }

  /** Read one resource's text by id, path, file name, or title. */
  async readResource(
    project: Project,
    reference: string,
  ): Promise<ResourceContent> {
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const descriptor = this.resolveResource(index, reference);
    return {
      resource: this.summarize(descriptor, index, snapshot.metadata.relationships),
      content: this.contentOf(snapshot, descriptor),
    };
  }

  /** The structural outline of one resource. */
  async outline(
    project: Project,
    reference: string,
  ): Promise<{ resource: ResourceSummary; outline: OutlineNode[] }> {
    const { resource, content } = await this.readResource(project, reference);
    if (resource.type === "sequence-diagram") {
      const { ast } = analyze(content);
      return { resource, outline: sequenceOutline(ast) };
    }
    if (resource.type === "event-flow") {
      const { flow } = analyzeEventFlow(content);
      return { resource, outline: eventFlowOutline(flow) };
    }
    return { resource, outline: markdownOutline(content) };
  }

  /** Validate an existing resource and report its diagnostics. */
  async validateResource(
    project: Project,
    reference: string,
  ): Promise<{ resource: ResourceSummary; diagnostics: DiagnosticView[] }> {
    const { resource, content } = await this.readResource(project, reference);
    return { resource, diagnostics: this.validateContent(content, resource) };
  }

  /**
   * Validate ad-hoc text as a resource of a given kind.
   *
   * This is the self-correction loop: an agent can check a document before
   * creating it, and the diagnostics are the same ones the project index would
   * report afterwards, because both run `analyzeResource`.
   */
  validateSource(content: string, kind: ResourceKindInput): DiagnosticView[] {
    const type = resourceTypeOfInput(kind);
    return this.diagnosticsFor(content, {
      id: "(source)",
      projectId: "",
      path: "(source)",
      type,
      title: "",
    });
  }

  /** Every diagnostic in a project, addressed to its resource. */
  async validateProject(
    project: Project,
  ): Promise<{ summary: ProjectSummary; diagnostics: DiagnosticView[] }> {
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const pathOf = (resourceId: string) =>
      index.resources.find((entry) => entry.id === resourceId)?.path;
    return {
      summary: await this.projectSummary(project),
      diagnostics: index.diagnostics.map((diagnostic) =>
        diagnosticView(diagnostic, pathOf),
      ),
    };
  }

  /** Create a resource, writing it through the repository. */
  async createResource(
    project: Project,
    input: {
      kind: ResourceKindInput;
      name: string;
      content: string;
      title?: string;
      overwrite?: boolean;
    },
  ): Promise<{
    resource: ResourceSummary;
    created: boolean;
    diagnostics: DiagnosticView[];
  }> {
    const type = resourceTypeOfInput(input.kind);
    const name = this.fileNameFor(type, input.name);
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const existing = index.resources.find((entry) => entry.path === name);
    if (existing && !input.overwrite) {
      throw new Error(
        `A resource named "${name}" already exists (id: "${existing.id}"). Pass overwrite: true to replace it, or use update_resource to edit it.`,
      );
    }

    const content = this.withTitle(input.content, type, input.title);
    await this.saveContent(project, type, name, content);

    const after = await this.snapshot(project);
    const afterIndex = await this.index(project, after);
    const descriptor =
      afterIndex.resources.find((entry) => entry.path === name) ?? null;
    if (!descriptor) {
      throw new Error(
        `Wrote "${name}" but could not read it back from the project.`,
      );
    }
    return {
      resource: this.summarize(descriptor, afterIndex, after.metadata.relationships),
      created: existing === undefined,
      diagnostics: this.validateContent(
        content,
        this.summarize(descriptor, afterIndex, after.metadata.relationships),
      ),
    };
  }

  /**
   * Replace, append to, or prepend to a resource's text.
   *
   * The one use case both the HTTP API and the MCP server expose. When the store
   * carries revisions (server mode) and the caller supplies
   * `expectedRevision`, a stale write is refused with a 409-mapped conflict
   * rather than silently overwriting whoever wrote first. A local store has no
   * revisions and ignores the expectation, which is why local mode behaves
   * exactly as before.
   */
  async updateResource(
    project: Project,
    reference: string,
    input: {
      content: string;
      mode?: "replace" | "append" | "prepend";
      expectedRevision?: number;
    },
  ): Promise<{
    resource: ResourceSummary;
    revision?: number;
    mode: string;
    bytesBefore: number;
    bytesAfter: number;
    diagnostics: DiagnosticView[];
  }> {
    const { repo } = await this.workspaceOf(project);
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const descriptor = this.resolveResource(index, reference);
    const previous = this.contentOf(snapshot, descriptor);
    const mode = input.mode ?? "replace";

    let next: string;
    switch (mode) {
      case "append":
        next = `${previous}${previous.endsWith("\n") || previous === "" ? "" : "\n"}${input.content}`;
        break;
      case "prepend":
        next = `${input.content}${previous === "" ? "" : "\n"}${previous}`;
        break;
      default:
        next = input.content;
        break;
    }

    await this.saveContent(
      project,
      descriptor.type,
      descriptor.path,
      next,
      input.expectedRevision,
    );
    const revision = await revisionOfResource(
      repo,
      project.id,
      descriptor.path,
    );
    const after = await this.snapshot(project);
    const afterIndex = await this.index(project, after);
    const resource = this.summarize(
      afterIndex.resources.find((entry) => entry.path === descriptor.path) ??
        descriptor,
      afterIndex,
    );
    return {
      resource,
      ...(revision === undefined ? {} : { revision }),
      mode,
      bytesBefore: previous.length,
      bytesAfter: next.length,
      diagnostics: this.validateContent(next, resource),
    };
  }

  /** Rename a resource's file, keeping its stable id and moving its record. */
  async renameResource(
    project: Project,
    reference: string,
    newName: string,
  ): Promise<{ resource: ResourceSummary; renamedFrom: string }> {
    const trimmed = newName.trim();
    if (trimmed === "") throw new Error("A new file name is required.");
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const descriptor = this.resolveResource(index, reference);
    const isNote = descriptor.type === "markdown-document";
    const fromPath = descriptor.path;
    const target = isNote ? ensureMarkdownExtension(trimmed) : trimmed;

    const { repo } = await this.workspaceOf(project);
    const renamed = isNote
      ? unwrap(
          await repo.renameNoteFile(
            project.id,
            fullPath(project, fromPath),
            target,
          ),
        )
      : unwrap(
          await repo.renameDiagramFile(
            project.id,
            fullPath(project, fromPath),
            target,
          ),
        );

    unwrap(
      await recordResourceRename(
        repo,
        project.id,
        snapshot.metadata,
        fromPath,
        renamed.name,
      ),
    );

    const after = await this.snapshot(project);
    const afterIndex = await this.index(project, after);
    const resource =
      afterIndex.resources.find((entry) => entry.path === renamed.name) ??
      descriptor;
    return {
      resource: this.summarize(resource, afterIndex),
      renamedFrom: fromPath,
    };
  }

  /** Delete a resource. Requires `confirm` so a stray call cannot destroy work. */
  async deleteResource(
    project: Project,
    reference: string,
    confirm: boolean,
  ): Promise<{ deleted: ResourceSummary }> {
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const descriptor = this.resolveResource(index, reference);
    if (!confirm) {
      throw new Error(
        `Refusing to delete "${descriptor.path}" without confirmation. Show the user what will be removed, then call delete_resource again with confirm: true.`,
      );
    }
    const { repo } = await this.workspaceOf(project);
    if (descriptor.type === "markdown-document") {
      unwrap(
        await repo.deleteNoteFile(
          project.id,
          fullPath(project, descriptor.path),
        ),
      );
    } else {
      unwrap(
        await repo.deleteDiagramFile(
          project.id,
          fullPath(project, descriptor.path),
        ),
      );
    }
    await this.deleteRelationshipsForResource(project, descriptor.id);
    return { deleted: this.summarize(descriptor, index) };
  }

  /** Render a diagram or event flow to SVG, optionally writing a file. */
  async render(
    project: Project,
    reference: string,
    request: RenderRequest = {},
  ): Promise<RenderResult> {
    const { root } = await this.workspaceOf(project);
    const { resource, content } = await this.readResource(project, reference);
    let svg: string;
    let width: number;
    let height: number;

    if (resource.type === "sequence-diagram") {
      const options: RenderOptions = {};
      if (request.theme !== undefined) options.theme = request.theme;
      if (request.background !== undefined)
        options.background = request.background;
      if (request.padding !== undefined) options.padding = request.padding;
      if (request.includeTitle !== undefined) {
        options.includeTitle = request.includeTitle;
      }
      const { ast } = analyze(content);
      const document = renderDiagramDocument(ast, options);
      svg = document.svg;
      width = document.width;
      height = document.height;
    } else if (resource.type === "event-flow") {
      const options: EventFlowRenderOptions = {};
      if (request.theme !== undefined) options.theme = request.theme;
      if (request.background !== undefined)
        options.background = request.background;
      if (request.padding !== undefined) options.padding = request.padding;
      if (request.includeTitle !== undefined) {
        options.includeTitle = request.includeTitle;
      }
      const { flow } = analyzeEventFlow(content);
      const document = renderEventFlowDocument(flow, options);
      svg = document.svg;
      width = document.width;
      height = document.height;
    } else {
      throw new Error(
        `"${resource.path}" is a markdown document, which does not render to a diagram. Use read_resource to read it.`,
      );
    }

    const result: RenderResult = {
      format: "svg",
      width,
      height,
      bytes: svg.length,
      resource: resource.path,
    };
    if (request.output !== undefined && request.output.trim() !== "") {
      const absolute = resolveInside(root, request.output.trim());
      await writeTextFile(absolute, svg);
      result.output = request.output.trim();
    } else {
      result.svg = svg;
    }
    return result;
  }

  /** Search every resource's text, or one project's, with scoped queries. */
  async search(
    project: Project | null,
    query: string,
    limit?: number,
  ): Promise<{
    query: string;
    matches: SearchMatch[];
    scanned: number;
    truncated: boolean;
  }> {
    const projects = project ? [project] : await this.provider.listProjects();
    const documents: SearchDocument[] = [];

    for (const current of projects) {
      const snapshot = await this.snapshot(current);
      const index = await this.index(current, snapshot);
      for (const descriptor of index.resources) {
        const participants = index.participants
          .filter(
            (symbol) =>
              symbol.resourceId === descriptor.id &&
              (symbol.kind === "participant" || symbol.kind === "actor"),
          )
          .map((symbol) => symbol.name);
        documents.push({
          kind: resourceKindOf(descriptor.type),
          id: descriptor.id,
          projectId: current.id,
          projectName: current.name,
          name: descriptor.path,
          title: descriptor.title,
          content: this.contentOf(snapshot, descriptor),
          metadata: snapshot.metadata.resources.find(
            (resource) => resource.id === descriptor.id,
          )?.metadata,
          facets: { participants },
        });
      }
    }

    const options = limit === undefined ? {} : { limit };
    const matches = runSearch(documents, query, options);
    const cap = limit ?? 200;
    return {
      query,
      matches,
      scanned: documents.length,
      truncated: matches.length >= cap,
    };
  }

  /** Every declaration and usage of a symbol name across a project. */
  async findReferences(
    project: Project,
    name: string,
  ): Promise<ReturnType<typeof findSymbolReferences>> {
    const index = await this.index(project);
    return findSymbolReferences(index, name);
  }

  /**
   * Audit a project for documentation gaps a reviewer would flag.
   *
   * The project index already knows every diagnostic, reference and symbol, so
   * the audit is assembly rather than analysis — the same reason the Problems
   * panel is cheap. It exists because "improve the documentation" needs an
   * answer to *what is missing*, which validation alone does not give.
   */
  async audit(project: Project): Promise<DocumentationAudit> {
    const snapshot = await this.snapshot(project);
    const index = await this.index(project, snapshot);
    const pathOf = (resourceId: string) =>
      index.resources.find((entry) => entry.id === resourceId)?.path;
    const findings: DocumentationFinding[] = [];

    for (const diagnostic of index.diagnostics) {
      const finding: DocumentationFinding = {
        severity: diagnostic.severity,
        code: diagnostic.code ?? "project.diagnostic",
        message: diagnostic.message,
        resourceId: diagnostic.resourceId,
      };
      const resourcePath = pathOf(diagnostic.resourceId);
      if (resourcePath !== undefined) finding.path = resourcePath;
      if (diagnostic.sourceRange) {
        finding.line = diagnostic.sourceRange.start.line + 1;
      }
      findings.push(finding);
    }

    // Broken internal links: an external URL in a note is fine, a project target
    // that does not resolve is not.
    const referenced = new Set<string>();
    for (const reference of index.references) {
      if (reference.to !== null) {
        referenced.add(reference.to);
        continue;
      }
      if (reference.problem?.reason === "external") continue;
      const finding: DocumentationFinding = {
        severity: "error",
        code: "broken-link",
        message: `"${reference.raw}" does not resolve (${reference.problem?.detail ?? "unknown target"})`,
        resourceId: reference.from,
        suggestion:
          "Fix the target, or link by stable id with resource://, diagram:// or doc://.",
      };
      const resourcePath = pathOf(reference.from);
      if (resourcePath !== undefined) finding.path = resourcePath;
      if (reference.sourceRange) {
        finding.line = reference.sourceRange.start.line + 1;
      }
      findings.push(finding);
    }

    for (const descriptor of index.resources) {
      const content = this.contentOf(snapshot, descriptor);
      if (descriptor.title === descriptor.path) {
        findings.push({
          severity: "info",
          code: "missing-title",
          message: `"${descriptor.path}" declares no title, so it is listed by file name`,
          resourceId: descriptor.id,
          path: descriptor.path,
          suggestion:
            descriptor.type === "markdown-document"
              ? "Start the document with a `# Heading`."
              : "Add a `title <text>` line.",
        });
      }
      if (content.trim() === "") {
        findings.push({
          severity: "warning",
          code: "empty-resource",
          message: `"${descriptor.path}" is empty`,
          resourceId: descriptor.id,
          path: descriptor.path,
          suggestion:
            "Fill it in, or delete it so the project has no dead files.",
        });
      }
      if (!referenced.has(descriptor.id)) {
        findings.push({
          severity: "info",
          code: "unreferenced-resource",
          message: `"${descriptor.path}" is not linked from any other document`,
          resourceId: descriptor.id,
          path: descriptor.path,
          suggestion:
            "Link it from an overview document (for example `[[Title]]` or a relative markdown link) so a reader can find it.",
        });
      }
    }

    const documents = index.documents;
    if (documents.length === 0 && index.resources.length > 0) {
      findings.push({
        severity: "warning",
        code: "no-prose-overview",
        message:
          "The project has no markdown document, so nothing explains the diagrams",
        suggestion:
          "Create a markdown document that introduces the system and links to each diagram.",
      });
    }
    for (const document of documents) {
      if (document.words > 0 && document.words < 40) {
        findings.push({
          severity: "info",
          code: "thin-document",
          message: `"${document.path}" has only ${document.words} words`,
          resourceId: document.id,
          path: document.path,
          suggestion:
            "Expand it into a useful explanation: purpose, actors, sequence, and failure modes.",
        });
      }
    }

    const errors = findings.filter(
      (entry) => entry.severity === "error",
    ).length;
    const warnings = findings.filter(
      (entry) => entry.severity === "warning",
    ).length;
    const suggestions = findings.filter(
      (entry) => entry.severity === "info",
    ).length;

    return {
      project: { id: project.id, name: project.name },
      summary: {
        resources: index.resources.length,
        documents: documents.length,
        diagrams: index.diagrams.length + index.eventFlows.length,
        links: index.references.length,
        errors,
        warnings,
        suggestions,
      },
      findings,
    };
  }

  /** Describe one descriptor for the tool layer. */
  private summarize(
    descriptor: ResourceDescriptor,
    index: ProjectIndex,
    relationships: ResourceRelationship[] = [],
  ): ResourceSummary {
    return {
      id: descriptor.id,
      path: descriptor.path,
      type: descriptor.type,
      kind: resourceKindOf(descriptor.type),
      title: descriptor.title,
      titleDeclared: descriptor.title !== descriptor.path,
      metrics: this.metricsOf(descriptor.id, index),
      complementaryViews: relationships.filter(
        (relationship) =>
          relationship.sourceId === descriptor.id || relationship.targetId === descriptor.id,
      ),
    };
  }

  /** The shape metrics of one resource, read from the index's typed lists. */
  private metricsOf(resourceId: string, index: ProjectIndex): ResourceMetrics {
    const diagram = index.diagrams.find((entry) => entry.id === resourceId);
    if (diagram) {
      return {
        ...emptyMetrics(),
        participants: diagram.participants,
        messages: diagram.messages,
      };
    }
    const eventFlow = index.eventFlows.find((entry) => entry.id === resourceId);
    if (eventFlow) {
      return {
        ...emptyMetrics(),
        events: eventFlow.events,
        producers: eventFlow.producers,
        consumers: eventFlow.consumers,
        channels: eventFlow.channels,
      };
    }
    const document = index.documents.find((entry) => entry.id === resourceId);
    if (document) return { ...emptyMetrics(), words: document.words };
    return emptyMetrics();
  }

  /** The text of a resource, from a snapshot that already read it. */
  private contentOf(
    snapshot: ProjectSnapshot,
    descriptor: ResourceDescriptor,
  ): string {
    const diagram = snapshot.diagrams.find(
      (file) => file.name === descriptor.path,
    );
    if (diagram) return diagram.source;
    const note = snapshot.notes.find((file) => file.name === descriptor.path);
    if (note) return note.markdown;
    throw new Error(
      `"${descriptor.path}" is recorded with the id "${descriptor.id}" but its file could not be read.`,
    );
  }

  /**
   * Write a resource's text through the repository.
   *
   * When the store carries revisions and the caller named one, the expectation
   * is checked *before* the write, so a stale writer changes nothing at all.
   */
  private async saveContent(
    project: Project,
    type: ResourceType,
    name: string,
    content: string,
    expectedRevision?: number,
  ): Promise<void> {
    const { repo } = await this.workspaceOf(project);
    await expectRevision(repo, project.id, name, expectedRevision);
    if (type === "markdown-document") {
      const note: NoteFile = {
        id: fullPath(project, name),
        name,
        markdown: content,
        projectId: project.id,
      };
      unwrap(await repo.saveNoteFile(project.id, note));
      return;
    }
    const diagram: DiagramFile = {
      id: fullPath(project, name),
      name,
      source: content,
      projectId: project.id,
    };
    unwrap(await repo.saveDiagramFile(project.id, diagram));
  }

  /**
   * Apply the file extension a resource type implies.
   *
   * The extension is what distinguishes the three kinds in a folder project, so
   * a tool that names a resource `checkout` still produces `checkout.seq`.
   */
  private fileNameFor(type: ResourceType, rawName: string): string {
    const name = rawName.trim();
    if (name === "") throw new Error("A resource name is required.");
    if (name.includes("/") || name.includes("\\")) {
      throw new Error(
        "A resource name must not contain a path separator; it names one file inside a project.",
      );
    }
    if (type === "markdown-document") return ensureMarkdownExtension(name);
    if (/\.md$/i.test(name)) {
      throw new Error(
        `"${name}" ends with .md, which makes it a markdown document. Use kind "note" for it.`,
      );
    }
    if (type === "event-flow") {
      return /\.eventseq$/i.test(name) ? name : `${name}.eventseq`;
    }
    if (/\.eventseq$/i.test(name)) {
      throw new Error(
        `"${name}" ends with .eventseq, which makes it an event flow. Use kind "event-flow" for it.`,
      );
    }
    return /\.[^./\\]+$/.test(name) ? name : `${name}.seq`;
  }

  /**
   * Ensure a new document declares a title when one was supplied.
   *
   * A document without a title is legal but is listed by file name, which reads
   * worse in a documentation tree; when the caller knows the title and the text
   * has none, it is prepended rather than silently dropped.
   */
  private withTitle(
    content: string,
    type: ResourceType,
    title: string | undefined,
  ): string {
    const wanted = title?.trim();
    if (wanted === undefined || wanted === "") return content;
    if (type === "markdown-document") {
      if (/^#{1,6}\s+/m.test(content)) return content;
      return `# ${wanted}\n\n${content}`;
    }
    if (/^[ \t]*title\b/m.test(content)) return content;
    return content.trim() === ""
      ? `title ${wanted}\n`
      : `title ${wanted}\n\n${content}`;
  }

  /** The diagnostics of ad-hoc text, via the same analysis the index runs. */
  private validateContent(
    content: string,
    resource: ResourceSummary,
  ): DiagnosticView[] {
    return this.diagnosticsFor(content, {
      id: resource.id,
      projectId: "",
      path: resource.path,
      type: resource.type,
      title: resource.title,
    });
  }

  /** Analyse text as one resource and flatten its diagnostics. */
  private diagnosticsFor(
    content: string,
    descriptor: ResourceDescriptor,
  ): DiagnosticView[] {
    return analyzeResource(descriptor, content).diagnostics.map(
      (diagnostic) => {
        const view: DiagnosticView = {
          severity: diagnostic.severity,
          message: diagnostic.message,
          resourceId: diagnostic.resourceId,
        };
        if (diagnostic.code !== undefined) view.code = diagnostic.code;
        view.resourcePath = descriptor.path;
        if (diagnostic.sourceRange) {
          view.line = diagnostic.sourceRange.start.line + 1;
          view.column = diagnostic.sourceRange.start.column + 1;
        }
        return view;
      },
    );
  }
}
