/**
 * The incremental project indexer.
 *
 * Re-parsing every file after every keystroke is the thing that makes an IDE
 * feel slow, and the mission's performance boundary is explicit: an edited
 * resource is re-analysed on its own, and the project view is then reassembled
 * from cached analyses. Assembly touches no text, so it stays cheap even when a
 * project holds a hundred diagrams.
 *
 * The cache is keyed by stable resource id and validated by a content
 * fingerprint, so it survives a rename (the id does not change, and neither does
 * the text) and, in a future session, could be persisted without changing this
 * module's contract.
 *
 * The indexer is deliberately a plain object with no React and no storage: the
 * browser UI drives it, and a future MCP server can drive the same thing.
 */
import { fingerprintContent, analyzeResource } from "./resource-analysis";
import {
  buildProjectIndex,
  type ProjectIndex,
  type ProjectDiagnostic,
  type ResourceAnalysis,
  type ResourceDescriptor,
} from "./project-index";
import { validateProject } from "./validate";
import type { ProjectMetadata } from "../workspace/metadata";

/** One resource to index: its identity plus its current text. */
export interface ProjectSourceFile {
  descriptor: ResourceDescriptor;
  content: string;
}

/** A cache of per-resource analyses, and the project view they add up to. */
export interface ProjectIndexer {
  /**
   * Re-analyse only the files whose content changed, then rebuild the project
   * view. Returns the same object shape regardless of how much work was needed.
   */
  update(
    projectId: string,
    files: ProjectSourceFile[],
    metadata: ProjectMetadata,
  ): ProjectIndex;
  /** The analyses currently cached, for tests and diagnostics. */
  cached(): ResourceAnalysis[];
  /** How many files were re-analysed on the last `update`, for tests. */
  lastAnalyzedCount(): number;
  /** Forget everything (a different project was opened). */
  clear(): void;
}

/** Build an indexer with an empty cache. */
export function createProjectIndexer(): ProjectIndexer {
  const cache = new Map<string, ResourceAnalysis>();
  let lastAnalyzed = 0;

  return {
    update(projectId, files, metadata): ProjectIndex {
      lastAnalyzed = 0;
      const analyses: ResourceAnalysis[] = [];
      const seen = new Set<string>();

      for (const file of files) {
        const { descriptor, content } = file;
        seen.add(descriptor.id);
        const fingerprint = fingerprintContent(content);
        const cached = cache.get(descriptor.id);
        if (
          cached &&
          cached.fingerprint === fingerprint &&
          cached.descriptor.type === descriptor.type
        ) {
          // A cached analysis whose descriptor changed only in path (a rename)
          // still describes the same content, so it is reused and the path — and
          // the title that falls back to it — is patched in rather than the file
          // being parsed again.
          const patched =
            cached.descriptor.path === descriptor.path
              ? cached
              : {
                  ...cached,
                  descriptor: {
                    ...cached.descriptor,
                    path: descriptor.path,
                    title: cached.declaredTitle ?? descriptor.path,
                  },
                };
          if (patched !== cached) cache.set(descriptor.id, patched);
          analyses.push(patched);
          continue;
        }
        const analysis = analyzeResource(descriptor, content);
        cache.set(descriptor.id, analysis);
        analyses.push(analysis);
        lastAnalyzed += 1;
      }

      // Drop analyses for resources that no longer exist, so a deleted file
      // cannot keep contributing symbols or references.
      for (const id of [...cache.keys()]) {
        if (!seen.has(id)) cache.delete(id);
      }

      const perResource: ProjectDiagnostic[] = analyses.flatMap(
        (analysis) => analysis.diagnostics,
      );

      return buildProjectIndex(projectId, analyses, metadata, (core) =>
        validateProject(core, perResource, metadata),
      );
    },

    cached(): ResourceAnalysis[] {
      return [...cache.values()];
    },

    lastAnalyzedCount(): number {
      return lastAnalyzed;
    },

    clear(): void {
      cache.clear();
      lastAnalyzed = 0;
    },
  };
}
