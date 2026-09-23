/**
 * Build the searchable document set from the workspace.
 *
 * The search model (see `src/domain/search/project-search.ts`) is deliberately
 * content-agnostic; this is the one place that knows how a stored diagram or
 * markdown file becomes a {@link SearchDocument}: its display title comes from
 * the same language helpers the explorer uses, and a diagram's participant
 * facet comes from the parser's own AST rather than a regex over the text.
 *
 * The result is a value, not state: it is derived from whatever the workspace
 * currently holds, so there is no index to keep in sync.
 */
import type { SearchDocument } from "../../domain/search/project-search";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../../domain/workspace/types";
import { analyze } from "../../language/analyze";
import { diagramDisplayName } from "../../language/diagram-title";
import { noteDisplayName } from "../../language/markdown/note-title";

/**
 * The participant names a diagram declares: each declaration's id and its
 * display label, de-duplicated so `participant api as "Auth Service"` matches
 * either spelling. A diagram that does not parse contributes no facet — search
 * still scans its text.
 */
function participantFacet(source: string): string[] {
  const { ast } = analyze(source);
  if (!ast) return [];
  const names: string[] = [];
  for (const participant of ast.participants) {
    for (const name of [participant.id, participant.label]) {
      if (name !== "" && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Turn every diagram and markdown document in a workspace into a searchable
 * document, carrying its project's display name for grouping results.
 */
export function buildSearchDocuments(
  projects: Project[],
  diagrams: DiagramFile[],
  notes: NoteFile[],
): SearchDocument[] {
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );

  const diagramDocuments: SearchDocument[] = diagrams.map((diagram) => ({
    kind: "diagram",
    id: diagram.id,
    projectId: diagram.projectId,
    projectName: projectNames.get(diagram.projectId) ?? diagram.projectId,
    name: diagram.name,
    title: diagramDisplayName(diagram.name, diagram.source),
    content: diagram.source,
    metadata: diagram.metadata,
    facets: { participants: participantFacet(diagram.source) },
  }));

  const noteDocuments: SearchDocument[] = notes.map((note) => ({
    kind: "note",
    id: note.id,
    projectId: note.projectId,
    projectName: projectNames.get(note.projectId) ?? note.projectId,
    name: note.name,
    title: noteDisplayName(note.name, note.markdown),
    content: note.markdown,
    metadata: note.metadata,
  }));

  return [...diagramDocuments, ...noteDocuments];
}
