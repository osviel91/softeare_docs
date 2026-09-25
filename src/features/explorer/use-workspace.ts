/**
 * Workspace state hook for local and server projects.
 *
 * `useWorkspace` owns everything the explorer and editor share: the projects, the
 * selected project's diagrams and notes, the currently loaded document (a diagram
 * source or a note's markdown), and the async actions that mutate storage. App
 * feeds the resulting buffers to the editor and preview, so selecting or editing
 * a document flows through this single hook instead of scattering state across
 * panes.
 *
 * A project has two kinds of file — diagrams (DSL) and notes (markdown) — and
 * exactly one document is active at a time: selecting a note clears the selected
 * diagram and vice versa. That keeps "the active document" a single, obvious
 * piece of state for the shell.
 *
 * The initial source is seeded with a valid sample diagram so the editor and
 * preview are populated synchronously on first render — before the async load
 * resolves. If the repository holds real projects, the load replaces the seed;
 * otherwise the sample remains as a convenient starting point.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../../domain/workspace/types";
import type { Result } from "../../shared/result/result";
import { isOk } from "../../shared/result/result";
import { withDiagramTitle } from "../../language/diagram-title";
import { withNoteTitle } from "../../language/markdown/note-title";
import { uniqueCopyName } from "../../domain/workspace/copy-name";
import { resourceTypeOfName } from "../../domain/workspace/resource-id";
import {
  newDiagramFileId,
  newNoteId,
} from "../../domain/workspace/workspace-ids";
import {
  reconcileMetadata,
  renameResourcePath,
  type MetadataFile,
  type ProjectMetadata,
} from "../../domain/workspace/metadata";
import { diagramDisplayName } from "../../language/diagram-title";
import { noteDisplayName } from "../../language/markdown/note-title";
import type { ImportedProject } from "../../workspace/transfer/project-archive";
import type { WorkspaceRepository } from "../../workspace/WorkspaceRepository";
import {
  createInMemoryHiddenPathStore,
  isHidden,
  type HiddenPathStore,
} from "../../workspace/hidden-paths";
import { SAMPLE_SOURCE } from "../../sample-source";

/**
 * How far a delete reaches.
 *
 * - `disk` removes the entity from its backing store (IndexedDB or the opened
 *   folder) for good.
 * - `app` only hides it in the explorer, leaving any file on disk untouched.
 *   This is the "remove from app, keep the file" choice offered when a local
 *   folder is open; for in-browser projects there is no separate disk copy, so
 *   callers should always pass `disk` there.
 */
export type DeleteScope = "app" | "disk";

/** The state and actions exposed by {@link useWorkspace}. */
export interface WorkspaceHook {
  /** Every project, in storage order. */
  projects: Project[];
  /** Diagram files of the selected project, in display order. */
  diagrams: DiagramFile[];
  /** Markdown notes of the selected project, in display order. */
  notes: NoteFile[];
  /**
   * Every diagram file in the workspace, across all projects. Loaded once at
   * startup (and kept current as files are created or opened) so the explorer
   * search box can filter by name across projects, not just the selected one.
   */
  allDiagrams: DiagramFile[];
  /** Every note in the workspace, across all projects, for search and links. */
  allNotes: NoteFile[];
  /** The id of the selected project, or `null` when none is selected. */
  selectedProjectId: string | null;
  /** The id of the loaded diagram, or `null` when none is loaded. */
  selectedDiagramId: string | null;
  /** The id of the loaded note, or `null` when none is loaded. */
  selectedNoteId: string | null;
  /** The loaded diagram file, or `null` when none is loaded. */
  selectedDiagram: DiagramFile | null;
  /** The loaded note, or `null` when none is loaded. */
  selectedNote: NoteFile | null;
  /** The DSL source currently shown in the editor. */
  source: string;
  /** The markdown currently shown in the editor when a note is active. */
  noteMarkdown: string;
  /** True while the initial load or any action is in flight. */
  isLoading: boolean;
  /** Re-read the selected project without replacing the current selection. */
  refresh(): Promise<{ diagrams: DiagramFile[]; notes: NoteFile[] }>;
  /** The last error surfaced by the repository, or `null`. */
  error: Error | null;
  /**
   * The selected project's identity record: which stable resource id belongs to
   * which file. `null` until a project is loaded.
   */
  metadata: ProjectMetadata | null;
  /**
   * The stable id of a stored file, or `null` when the record does not know it.
   * Renames change a file's id (its path) but never its resource id.
   */
  resourceIdForFile(file: DiagramFile | NoteFile): string | null;
  /** Load a diagram's source into the editor and select its project. */
  loadDiagram(diagram: DiagramFile): void;
  /** Load a note's markdown into the editor and select its project. */
  loadNote(note: NoteFile): void;
  /** Persist the current source back to the loaded diagram file. */
  saveCurrentDiagram(source: string): Promise<void>;
  /** Persist the current markdown back to the loaded note. */
  saveCurrentNote(markdown: string): Promise<void>;
  /** Create a new empty project and select it. */
  createProject(name: string): Promise<void>;
  /**
   * Change a project's name. A local-folder project's id is its directory path,
   * so the returned project may carry a new id and every file beneath it moves
   * with it; the workspace's lists and selection follow the move in place.
   */
  renameProject(id: string, newName: string): Promise<Project | null>;
  /**
   * Recreate a project from a portable archive and select it.
   *
   * Files are written with fresh ids — the archive's ids belong to the exporting
   * workspace — so an import can never overwrite something already here. Returns
   * the created project, or `null` when the repository refused.
   */
  importProject(imported: ImportedProject): Promise<Project | null>;
  /**
   * Remove a project (and, for a `disk` delete, its files). Clears the editor
   * when the deleted project was selected. With `app` scope the project is only
   * hidden in the explorer; nothing on disk is touched.
   */
  deleteProject(id: string, scope: DeleteScope): Promise<void>;
  /** Remove a single diagram (see {@link DeleteScope}). */
  deleteDiagram(
    projectId: string,
    diagramId: string,
    scope: DeleteScope,
  ): Promise<void>;
  /** Remove a single note (see {@link DeleteScope}). */
  deleteNote(
    projectId: string,
    noteId: string,
    scope: DeleteScope,
  ): Promise<void>;
  /**
   * Paths the user has removed from the app but left on disk. The explorer never
   * renders them; the set is exposed so the shell can report and undo hiding.
   */
  hiddenPaths: ReadonlySet<string>;
  /** Reveal a previously hidden path again. */
  unhidePath(path: string): void;
  /**
   * Create an empty diagram in a project, add it to the explorer's list, select
   * it, and return it (or `null` on failure).
   */
  createEmptyDiagram(projectId: string): Promise<DiagramFile | null>;
  /**
   * Create an empty event flow (a `.eventseq` file) in a project, select it, and
   * return it. It is stored like a diagram — the extension is the language — so
   * the tab strip and the explorer treat it as one.
   */
  createEmptyEventFlow(projectId: string): Promise<DiagramFile | null>;
  /** Create a note seeded with a heading, select it, and return it. */
  createEmptyNote(projectId: string): Promise<NoteFile | null>;
  /**
   * Duplicate a diagram inside its project with the same source and a free copy
   * name, then select the copy and return it (or `null` on failure).
   */
  duplicateDiagram(diagram: DiagramFile): Promise<DiagramFile | null>;
  /** Duplicate a note inside its project, select the copy, and return it. */
  duplicateNote(note: NoteFile): Promise<NoteFile | null>;
  /**
   * Change a diagram's file name. A local-folder rename changes the file's id,
   * so the returned file may carry a different id than the one passed in.
   */
  renameDiagram(
    projectId: string,
    diagramId: string,
    newName: string,
  ): Promise<DiagramFile | null>;
  /** Change a note's file name; the same id caveat as {@link renameDiagram}. */
  renameNote(
    projectId: string,
    noteId: string,
    newName: string,
  ): Promise<NoteFile | null>;
  /** Set a diagram's `title` (its display name) by rewriting its source. */
  setDiagramTitle(
    diagram: DiagramFile,
    title: string,
  ): Promise<DiagramFile | null>;
  /** Set a note's title by rewriting its first heading. */
  setNoteTitle(note: NoteFile, title: string): Promise<NoteFile | null>;
  /**
   * Merge an edited diagram back into the in-memory lists. Called by the tab
   * hook after each auto-save, so a diagram whose `title` (and therefore its
   * name) just changed is relabelled without a round-trip to storage.
   */
  applyDiagramEdit(diagram: DiagramFile): void;
  /** Merge an edited note back into both note lists after an auto-save. */
  applyNoteEdit(note: NoteFile): void;
}

/** The mutable pieces of {@link WorkspaceHook}, passed as a single object. */
interface ProjectSetters {
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setDiagrams: Dispatch<SetStateAction<DiagramFile[]>>;
  setNotes: Dispatch<SetStateAction<NoteFile[]>>;
  setSelectedProjectId: (value: string | null) => void;
  setSelectedDiagramId: (value: string | null) => void;
  setSelectedNoteId: (value: string | null) => void;
  setSource: (value: string) => void;
  setNoteMarkdown: (value: string) => void;
  setError: (value: Error | null) => void;
  setMetadata: (value: ProjectMetadata | null) => void;
  /** Record that the diagram/note lists now describe this project. */
  markFilesLoaded: (projectId: string) => void;
}

/** The identity record's view of one stored file. */
function metadataFileOf(file: DiagramFile | NoteFile): MetadataFile {
  // The stored kind cannot separate the two diagram languages — both live in the
  // diagram store — so the file name decides, exactly as it does on disk.
  const type =
    "markdown" in file ? "markdown-document" : resourceTypeOfName(file.name);
  return {
    path: file.name,
    type,
    title:
      type === "markdown-document"
        ? noteDisplayName(file.name, (file as NoteFile).markdown)
        : diagramDisplayName(file.name, (file as DiagramFile).source),
  };
}

/**
 * Load a project's diagrams and notes, auto-selecting the first document.
 *
 * A project with diagrams selects its first diagram; one with only notes selects
 * its first note; an empty project clears the editor.
 */
async function selectProject(
  repo: WorkspaceRepository,
  projectId: string,
  setters: ProjectSetters,
  mergeDiagrams: (diagrams: DiagramFile[]) => void,
  mergeNotes: (notes: NoteFile[]) => void,
): Promise<void> {
  setters.setSelectedProjectId(projectId);
  setters.setSelectedDiagramId(null);
  setters.setSelectedNoteId(null);

  const [diagramsResult, notesResult] = await Promise.all([
    repo.listDiagramFiles(projectId),
    repo.listNoteFiles(projectId),
  ]);

  const nextDiagrams = isOk(diagramsResult) ? diagramsResult.value : [];
  const nextNotes = isOk(notesResult) ? notesResult.value : [];
  setters.setDiagrams(nextDiagrams);
  setters.setNotes(nextNotes);
  setters.markFilesLoaded(projectId);
  // Keep the workspace-wide lists (used by search and diagram links) current as
  // the user navigates between projects.
  mergeDiagrams(nextDiagrams);
  mergeNotes(nextNotes);

  if (!isOk(diagramsResult)) setters.setError(diagramsResult.error);
  if (!isOk(notesResult)) setters.setError(notesResult.error);

  if (nextDiagrams.length > 0) {
    setters.setSelectedDiagramId(nextDiagrams[0].id);
    setters.setSource(nextDiagrams[0].source);
    setters.setNoteMarkdown("");
  } else if (nextNotes.length > 0) {
    setters.setSelectedNoteId(nextNotes[0].id);
    setters.setNoteMarkdown(nextNotes[0].markdown);
    setters.setSource("");
  } else {
    setters.setSource("");
    setters.setNoteMarkdown("");
  }
}

/** Replace the entry with `id` in a list, keeping its position. */
function replaceById<T extends { id: string }>(current: T[], next: T): T[] {
  return current.map((entry) => (entry.id === next.id ? next : entry));
}

/**
 * Bind the {@link WorkspaceRepository} to React state.
 *
 * The initial load runs once on mount; individual actions each open their own
 * transaction and refresh the affected state. Every repository error is captured
 * in `error` so the UI can surface it without catching exceptions.
 *
 * @param repo - The active workspace repository.
 * @param hiddenStore - Where paths the user removed from the app are recorded.
 *   Defaults to a per-hook in-memory store, which is what in-browser projects
 *   use (they have no disk copy to fall back to).
 */
export function useWorkspace(
  repo: WorkspaceRepository,
  hiddenStore?: HiddenPathStore,
): WorkspaceHook {
  const [projects, setProjects] = useState<Project[]>([]);
  const [diagrams, setDiagrams] = useState<DiagramFile[]>([]);
  const [notes, setNotes] = useState<NoteFile[]>([]);
  // Every file in the workspace, keyed by id. Loaded once at startup and kept
  // current as files are created or opened; the explorer search and the notes'
  // `[[Diagram]]` links resolve against these lists, so they span projects.
  const [allDiagrams, setAllDiagrams] = useState<DiagramFile[]>([]);
  const [allNotes, setAllNotes] = useState<NoteFile[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | null>(
    null,
  );
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // Seed the editor with a valid sample so the preview is populated synchronously
  // on first render, before the async load resolves.
  const [source, setSource] = useState<string>(SAMPLE_SOURCE);
  const [noteMarkdown, setNoteMarkdown] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  // The selected project's identity record (stable resource ids). Loaded with
  // the project and kept in step with its files from then on.
  const [metadata, setMetadata] = useState<ProjectMetadata | null>(null);
  // A mirror for async callbacks, which otherwise close over a stale render.
  const metadataRef = useRef<ProjectMetadata | null>(null);
  metadataRef.current = metadata;
  // Which project the loaded identity record belongs to. Selecting a project
  // happens through several paths — the explorer, a tab, a quick-open result —
  // so this is tracked here rather than at each call site, and nothing
  // reconciles files against a record that describes a different project.
  const metadataProject = useRef<string | null>(null);
  // Which project the diagram/note lists describe. Selecting a document from a
  // tab or a search result changes the selected project without re-listing it,
  // so the lists refresh asynchronously and nothing reconciles identity against
  // a list that still belongs to the previous project.
  const filesProject = useRef<string | null>(null);

  // A stable fallback store for callers that do not supply one. A ref keeps the
  // same instance across renders instead of creating a fresh store each time.
  const fallbackStoreRef = useRef<HiddenPathStore | null>(null);
  if (!fallbackStoreRef.current) {
    fallbackStoreRef.current = createInMemoryHiddenPathStore();
  }
  const hidden = hiddenStore ?? fallbackStoreRef.current;

  // The hidden set is mirrored into state so filtering happens during render.
  // Re-read whenever the store identity changes (a different folder was opened).
  const [hiddenPaths, setHiddenPaths] = useState<ReadonlySet<string>>(
    () => new Set(hidden.list()),
  );
  useEffect(() => {
    setHiddenPaths(new Set(hidden.list()));
  }, [hidden]);

  // Merge a batch of files into a workspace-wide list by id, updating in place
  // (so a re-listed file carries its latest content) and appending new ones.
  // Stable across renders since each only wraps a state setter.
  const mergeDiagrams = useCallback((next: DiagramFile[]) => {
    if (next.length === 0) return;
    setAllDiagrams((current) => {
      const byId = new Map(current.map((diagram) => [diagram.id, diagram]));
      for (const diagram of next) byId.set(diagram.id, diagram);
      return [...byId.values()];
    });
  }, []);

  const mergeNotes = useCallback((next: NoteFile[]) => {
    if (next.length === 0) return;
    setAllNotes((current) => {
      const byId = new Map(current.map((note) => [note.id, note]));
      for (const note of next) byId.set(note.id, note);
      return [...byId.values()];
    });
  }, []);

  const setters: ProjectSetters = {
    setProjects,
    setDiagrams,
    setNotes,
    setSelectedProjectId,
    setSelectedDiagramId,
    setSelectedNoteId,
    setSource,
    setNoteMarkdown,
    setError,
    setMetadata,
    markFilesLoaded: (projectId: string) => {
      filesProject.current = projectId;
    },
  };

  // The loaded documents themselves (matched by id), so the shell can open a tab
  // or render markdown from the full file rather than the id alone. Resolved
  // against the workspace-wide lists so a file selected from another project
  // (e.g. via search) still resolves.
  const selectedDiagram =
    allDiagrams.find((diagram) => diagram.id === selectedDiagramId) ?? null;
  const selectedNote =
    allNotes.find((note) => note.id === selectedNoteId) ?? null;

  // Initial load: projects plus every project's diagrams and notes.
  //
  // The workspace-wide lists are cleared first because this effect also runs when
  // the *repository* changes — switching from local projects to a server project,
  // say. A file id means nothing outside the store that issued it, so keeping the
  // previous store's entries would let the explorer's search and a note's
  // `[[Diagram]]` links resolve to documents that are no longer reachable.
  useEffect(() => {
    let active = true;
    (async () => {
      setIsLoading(true);
      setError(null);
      setAllDiagrams([]);
      setAllNotes([]);
      const projectsResult: Result<Project[], Error> =
        await repo.listProjects();
      if (!active) return;
      if (isOk(projectsResult)) {
        // Paths the user removed from the app are skipped here, so a hidden
        // project neither appears in the explorer nor gets auto-selected.
        const hiddenNow = new Set(hidden.list());
        const visible = projectsResult.value.filter(
          (project) => !isHidden(hiddenNow, project.id),
        );
        setters.setProjects(projectsResult.value);
        const allD: DiagramFile[] = [];
        const allN: NoteFile[] = [];
        for (const project of visible) {
          const [files, noteFiles] = await Promise.all([
            repo.listDiagramFiles(project.id),
            repo.listNoteFiles(project.id),
          ]);
          if (isOk(files)) {
            allD.push(
              ...files.value.filter((file) => !isHidden(hiddenNow, file.id)),
            );
          }
          if (isOk(noteFiles)) {
            allN.push(
              ...noteFiles.value.filter(
                (file) => !isHidden(hiddenNow, file.id),
              ),
            );
          }
        }
        mergeDiagrams(allD);
        mergeNotes(allN);
        if (visible.length > 0) {
          await selectProject(
            repo,
            visible[0].id,
            setters,
            mergeDiagrams,
            mergeNotes,
          );
        } else {
          setters.setDiagrams([]);
          setters.setNotes([]);
        }
      } else {
        setError(projectsResult.error);
      }
      setIsLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [repo, mergeDiagrams, mergeNotes, hidden]);

  // Load the selected project's identity record. Reading is all this does; the
  // effect below brings it in step with the files, which is the migration path.
  useEffect(() => {
    if (!selectedProjectId) {
      metadataProject.current = null;
      setMetadata(null);
      return;
    }
    if (metadataProject.current === selectedProjectId) return;
    metadataProject.current = selectedProjectId;
    let active = true;
    void (async () => {
      const result = await repo.readProjectMetadata(selectedProjectId);
      if (!active) return;
      if (!isOk(result)) {
        setError(result.error);
        setMetadata(null);
        return;
      }
      metadataRef.current = result.value;
      setMetadata(result.value);
    })();
    return () => {
      active = false;
    };
  }, [repo, selectedProjectId]);

  // Keep the identity record in step with the files the app can see. Creating,
  // duplicating, deleting and retitling all change what the record should say,
  // and reconciling here means none of those actions has to remember to. A
  // *rename* is the one case that must be handled before the file list changes,
  // because reconciling would otherwise mint a new id for the new path instead
  // of carrying the old one across — see `renameDiagram` / `renameNote`.
  //
  // Files are filtered by their own `projectId`, so the one render where the
  // previous project's files are still in state cannot write ids for them into
  // the newly selected project's record.
  useEffect(() => {
    if (!selectedProjectId) return;
    if (metadataProject.current !== selectedProjectId) return;
    if (filesProject.current !== selectedProjectId) return;
    const files = [
      ...diagrams.filter((file) => file.projectId === selectedProjectId),
      ...notes.filter((file) => file.projectId === selectedProjectId),
    ];
    const reconciled = reconcileMetadata(
      metadataRef.current,
      files.map(metadataFileOf),
    );
    if (!reconciled.changed) return;
    metadataRef.current = reconciled.metadata;
    setMetadata(reconciled.metadata);
    void repo.writeProjectMetadata(selectedProjectId, reconciled.metadata);
  }, [repo, selectedProjectId, diagrams, notes, metadata]);

  const resourceIdForFile = useCallback(
    (file: DiagramFile | NoteFile): string | null =>
      metadataRef.current?.resources.find(
        (resource) => resource.path === file.name,
      )?.id ?? null,
    [],
  );

  /**
   * Make sure the selected project's file lists describe that project.
   *
   * Opening a document from another project — through a tab, a search result or
   * a quick-open entry — selects that project without going through the
   * explorer, so its lists are refreshed here. Until they arrive the identity
   * record is deliberately left alone, which is what stops a stale list from
   * being reconciled against the wrong project's records.
   */
  const refreshProjectFiles = useCallback(
    async (projectId: string): Promise<void> => {
      if (filesProject.current === projectId) return;
      const [diagramsResult, notesResult] = await Promise.all([
        repo.listDiagramFiles(projectId),
        repo.listNoteFiles(projectId),
      ]);
      if (isOk(diagramsResult)) {
        setDiagrams(diagramsResult.value);
        mergeDiagrams(diagramsResult.value);
      }
      if (isOk(notesResult)) {
        setNotes(notesResult.value);
        mergeNotes(notesResult.value);
      }
      if (!isOk(diagramsResult)) setError(diagramsResult.error);
      else if (!isOk(notesResult)) setError(notesResult.error);
      filesProject.current = projectId;
    },
    [repo, mergeDiagrams, mergeNotes],
  );

  /**
   * Make sure `projectId`'s files are the ones held in state, loading them when
   * another project's are.
   *
   * The explorer renders every project's files and offers each header its own
   * `＋` menu, so a create or duplicate can target a project that is not the
   * selected one. `diagrams`/`notes` describe exactly one project at a time, so
   * appending to them without reloading first would mix two projects' files —
   * the new file would appear beneath a list that still belonged to the project
   * that was selected.
   *
   * Deliberately does not touch the selection: the caller picks the new document
   * itself, so the tab strip never opens a tab for the project's first file.
   */
  const loadProjectFiles = useCallback(
    (projectId: string): Promise<void> => refreshProjectFiles(projectId),
    [refreshProjectFiles],
  );

  const loadDiagram = useCallback(
    (diagram: DiagramFile) => {
      // Ensure the clicked diagram is part of the workspace-wide list so it
      // remains findable after navigating into a project.
      mergeDiagrams([diagram]);
      setSelectedProjectId(diagram.projectId);
      setSelectedDiagramId(diagram.id);
      setSelectedNoteId(null);
      setSource(diagram.source);
      setError(null);
      void refreshProjectFiles(diagram.projectId);
    },
    [mergeDiagrams, refreshProjectFiles],
  );

  const loadNote = useCallback(
    (note: NoteFile) => {
      mergeNotes([note]);
      setSelectedProjectId(note.projectId);
      setSelectedNoteId(note.id);
      setSelectedDiagramId(null);
      setNoteMarkdown(note.markdown);
      setError(null);
      void refreshProjectFiles(note.projectId);
    },
    [mergeNotes, refreshProjectFiles],
  );

  const saveCurrentDiagram = useCallback(
    async (nextSource: string): Promise<void> => {
      // Update source first so the preview re-renders in lockstep with edits,
      // then persist asynchronously. When no diagram is loaded there is nothing
      // to save, but the editor should still reflect what the user typed.
      setSource(nextSource);
      if (!selectedProjectId || !selectedDiagramId) return;
      const result: Result<DiagramFile, Error> = await repo.saveDiagramFile(
        selectedProjectId,
        {
          id: selectedDiagramId,
          name:
            diagrams.find((diagram) => diagram.id === selectedDiagramId)
              ?.name ?? "Untitled",
          source: nextSource,
          projectId: selectedProjectId,
        },
      );
      if (!isOk(result)) {
        setError(result.error);
      }
    },
    [repo, selectedProjectId, selectedDiagramId, diagrams],
  );

  const saveCurrentNote = useCallback(
    async (nextMarkdown: string): Promise<void> => {
      setNoteMarkdown(nextMarkdown);
      if (!selectedProjectId || !selectedNoteId) return;
      const existing = allNotes.find((note) => note.id === selectedNoteId);
      const result: Result<NoteFile, Error> = await repo.saveNoteFile(
        selectedProjectId,
        {
          id: selectedNoteId,
          name: existing?.name ?? "Untitled.md",
          markdown: nextMarkdown,
          projectId: selectedProjectId,
        },
      );
      if (!isOk(result)) {
        setError(result.error);
        return;
      }
      // Fold the saved copy back in so the explorer relabels the note as its
      // first heading changes, without a reload.
      const stored = result.value;
      const merge = (current: NoteFile[]): NoteFile[] =>
        replaceById(current, stored);
      setNotes(merge);
      setAllNotes(merge);
    },
    [repo, selectedProjectId, selectedNoteId, allNotes],
  );

  const createProject = useCallback(
    async (name: string): Promise<void> => {
      const result: Result<Project, Error> = await repo.createProject(name);
      if (isOk(result)) {
        setters.setProjects((current: Project[]) => [...current, result.value]);
        await selectProject(
          repo,
          result.value.id,
          setters,
          mergeDiagrams,
          mergeNotes,
        );
      } else {
        setError(result.error);
      }
    },
    [repo, mergeDiagrams, mergeNotes],
  );

  /**
   * Rename a project.
   *
   * An in-browser project keeps its generated id, so only the label changes. A
   * local-folder project's id *is* its directory path, so a rename moves every
   * file beneath it: the file ids (paths) are re-prefixed and the selection is
   * carried across, which keeps the explorer, search and links consistent without
   * a reload. Re-selecting the renamed project makes the metadata effect re-read
   * the sidecar from its new directory.
   */
  const renameProject = useCallback(
    async (id: string, newName: string): Promise<Project | null> => {
      const result: Result<Project, Error> = await repo.renameProject(
        id,
        newName,
      );
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const renamed = result.value;

      setProjects((current: Project[]) =>
        current.map((project) => (project.id === id ? renamed : project)),
      );

      if (renamed.id !== id) {
        // The id changed (a folder path), so re-prefix every file that lived
        // under it: id and projectId both follow the directory.
        const prefix = `${id}/`;
        const move = <T extends { id: string; projectId: string }>(
          file: T,
        ): T =>
          file.projectId === id
            ? {
                ...file,
                id: `${renamed.id}/${file.id.slice(prefix.length)}`,
                projectId: renamed.id,
              }
            : file;
        const moveAll = <T extends { id: string; projectId: string }>(
          current: T[],
        ): T[] => current.map(move);
        setDiagrams(moveAll);
        setAllDiagrams(moveAll);
        setNotes(moveAll);
        setAllNotes(moveAll);
        if (selectedProjectId === id) {
          // The file lists already describe the renamed project, so record that
          // before the selection change so reconciliation does not re-list them.
          filesProject.current = renamed.id;
          setSelectedProjectId(renamed.id);
        }
        if (selectedDiagramId && selectedDiagramId.startsWith(prefix)) {
          setSelectedDiagramId(
            `${renamed.id}/${selectedDiagramId.slice(prefix.length)}`,
          );
        }
        if (selectedNoteId && selectedNoteId.startsWith(prefix)) {
          setSelectedNoteId(
            `${renamed.id}/${selectedNoteId.slice(prefix.length)}`,
          );
        }
      }

      return renamed;
    },
    [
      repo,
      selectedProjectId,
      selectedDiagramId,
      selectedNoteId,
      setProjects,
      setDiagrams,
      setAllDiagrams,
      setNotes,
      setAllNotes,
    ],
  );

  /**
   * Recreate a project from an imported archive.
   *
   * The archive's ids belong to the exporting workspace, so every file is written
   * with a fresh id: importing can never overwrite something already here. A name
   * that the archive itself repeats is disambiguated with the same copy-name rule
   * duplication uses, so even a hand-edited archive imports cleanly.
   */
  const importProject = useCallback(
    async (imported: ImportedProject): Promise<Project | null> => {
      const created: Result<Project, Error> = await repo.createProject(
        imported.name,
      );
      if (!isOk(created)) {
        setError(created.error);
        return null;
      }
      const project = created.value;

      const diagramNames: string[] = [];
      for (const item of imported.diagrams) {
        const name = diagramNames.includes(item.name)
          ? uniqueCopyName(item.name, diagramNames)
          : item.name;
        diagramNames.push(name);
        const stored: Result<DiagramFile, Error> = await repo.saveDiagramFile(
          project.id,
          {
            id: newDiagramFileId(),
            name,
            source: item.source,
            projectId: project.id,
          },
        );
        if (!isOk(stored)) {
          setError(stored.error);
          return null;
        }
      }

      const noteNames: string[] = [];
      for (const item of imported.notes) {
        const name = noteNames.includes(item.name)
          ? uniqueCopyName(item.name, noteNames)
          : item.name;
        noteNames.push(name);
        const stored: Result<NoteFile, Error> = await repo.saveNoteFile(
          project.id,
          {
            id: newNoteId(),
            name,
            markdown: item.markdown,
            projectId: project.id,
          },
        );
        if (!isOk(stored)) {
          setError(stored.error);
          return null;
        }
      }

      // Show the project immediately, then re-read it so the explorer, the tab
      // strip, and the workspace-wide lists all see the imported files.
      setters.setProjects((current: Project[]) => [...current, project]);
      await selectProject(repo, project.id, setters, mergeDiagrams, mergeNotes);
      return project;
    },
    [repo, mergeDiagrams, mergeNotes],
  );

  /** Drop a path from the hidden set and mirror the change into state. */
  const unhidePath = useCallback(
    (path: string): void => {
      hidden.unhide(path);
      setHiddenPaths(new Set(hidden.list()));
    },
    [hidden],
  );

  const deleteProject = useCallback(
    async (id: string, scope: DeleteScope): Promise<void> => {
      if (scope === "disk") {
        const result: Result<void, Error> = await repo.deleteProject(id);
        if (!isOk(result)) {
          setError(result.error);
          return;
        }
        // The files went with it; drop them from every list.
        const inProject = (file: { projectId: string }): boolean =>
          file.projectId === id;
        setDiagrams((current) => current.filter((d) => !inProject(d)));
        setAllDiagrams((current) => current.filter((d) => !inProject(d)));
        setNotes((current) => current.filter((n) => !inProject(n)));
        setAllNotes((current) => current.filter((n) => !inProject(n)));
        setters.setProjects((current: Project[]) =>
          current.filter((project) => project.id !== id),
        );
      } else {
        // "Remove from app": hide the directory (its files hide by prefix) so a
        // mistake never destroys the folder on disk. The project stays in state
        // so "Restore" can bring it back without a reload.
        hidden.hide(id);
        setHiddenPaths(new Set(hidden.list()));
      }

      if (selectedProjectId === id) {
        setSelectedProjectId(null);
        setSelectedDiagramId(null);
        setSelectedNoteId(null);
        setSource("");
        setNoteMarkdown("");
        setDiagrams([]);
        setNotes([]);
      }
    },
    [repo, hidden, selectedProjectId],
  );

  const deleteDiagram = useCallback(
    async (
      projectId: string,
      diagramId: string,
      scope: DeleteScope,
    ): Promise<void> => {
      if (scope === "disk") {
        const result: Result<void, Error> = await repo.deleteDiagramFile(
          projectId,
          diagramId,
        );
        if (!isOk(result)) {
          setError(result.error);
          return;
        }
        // A disk delete is permanent, so drop the file from both lists.
        const drop = (current: DiagramFile[]): DiagramFile[] =>
          current.filter((diagram) => diagram.id !== diagramId);
        setDiagrams(drop);
        setAllDiagrams(drop);
      } else {
        // "Remove from app" only hides the file; keeping it in state is what
        // makes the explorer's "Restore" action work without re-reading disk.
        hidden.hide(diagramId);
        setHiddenPaths(new Set(hidden.list()));
      }
      if (selectedDiagramId === diagramId) {
        setSelectedDiagramId(null);
        setSource("");
      }
    },
    [repo, hidden, selectedDiagramId],
  );

  const deleteNote = useCallback(
    async (
      projectId: string,
      noteId: string,
      scope: DeleteScope,
    ): Promise<void> => {
      if (scope === "disk") {
        const result: Result<void, Error> = await repo.deleteNoteFile(
          projectId,
          noteId,
        );
        if (!isOk(result)) {
          setError(result.error);
          return;
        }
        const drop = (current: NoteFile[]): NoteFile[] =>
          current.filter((note) => note.id !== noteId);
        setNotes(drop);
        setAllNotes(drop);
      } else {
        hidden.hide(noteId);
        setHiddenPaths(new Set(hidden.list()));
      }
      if (selectedNoteId === noteId) {
        setSelectedNoteId(null);
        setNoteMarkdown("");
      }
    },
    [repo, hidden, selectedNoteId],
  );

  const createEmptyDiagram = useCallback(
    async (projectId: string): Promise<DiagramFile | null> => {
      const result: Result<DiagramFile, Error> =
        await repo.createEmptyDiagram(projectId);
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const diagram = result.value;
      // Add it to the explorer's list for this project (when it is the selected
      // one) and select it, so the new file appears and is ready to edit. The
      // project's existing files are loaded first when it was not the selected
      // one, so the list never mixes two projects.
      await loadProjectFiles(projectId);
      setDiagrams((current: DiagramFile[]) =>
        current.some((item) => item.id === diagram.id)
          ? current
          : [...current, diagram],
      );
      mergeDiagrams([diagram]);
      setters.setSelectedProjectId(projectId);
      setters.setSelectedDiagramId(diagram.id);
      setters.setSelectedNoteId(null);
      setters.setSource(diagram.source);
      setters.setNoteMarkdown("");
      return diagram;
    },
    [repo, loadProjectFiles, setters, mergeDiagrams],
  );

  const createEmptyNote = useCallback(
    async (projectId: string): Promise<NoteFile | null> => {
      const result: Result<NoteFile, Error> =
        await repo.createEmptyNote(projectId);
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const note = result.value;
      await loadProjectFiles(projectId);
      setNotes((current: NoteFile[]) =>
        current.some((item) => item.id === note.id)
          ? current
          : [...current, note],
      );
      mergeNotes([note]);
      setters.setSelectedProjectId(projectId);
      setters.setSelectedNoteId(note.id);
      setters.setSelectedDiagramId(null);
      setters.setNoteMarkdown(note.markdown);
      setters.setSource("");
      return note;
    },
    [repo, loadProjectFiles, setters, mergeNotes],
  );

  const createEmptyEventFlow = useCallback(
    async (projectId: string): Promise<DiagramFile | null> => {
      const result: Result<DiagramFile, Error> =
        await repo.createEmptyEventFlow(projectId);
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const flow = result.value;
      await loadProjectFiles(projectId);
      setDiagrams((current: DiagramFile[]) =>
        current.some((item) => item.id === flow.id)
          ? current
          : [...current, flow],
      );
      mergeDiagrams([flow]);
      setters.setSelectedProjectId(projectId);
      setters.setSelectedDiagramId(flow.id);
      setters.setSelectedNoteId(null);
      setters.setSource(flow.source);
      setters.setNoteMarkdown("");
      return flow;
    },
    [repo, loadProjectFiles, setters, mergeDiagrams],
  );

  const duplicateDiagram = useCallback(
    async (diagram: DiagramFile): Promise<DiagramFile | null> => {
      const result: Result<DiagramFile, Error> =
        await repo.duplicateDiagramFile(diagram.projectId, diagram.id);
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const copy = result.value;
      // Show the copy next to its original and make it the active document, so
      // the user lands on what they just created. The original's project may not
      // be the selected one, so its files are loaded first.
      await loadProjectFiles(copy.projectId);
      setDiagrams((current: DiagramFile[]) =>
        current.some((item) => item.id === copy.id)
          ? current
          : [...current, copy],
      );
      mergeDiagrams([copy]);
      setters.setSelectedProjectId(copy.projectId);
      setters.setSelectedDiagramId(copy.id);
      setters.setSelectedNoteId(null);
      setters.setSource(copy.source);
      setters.setNoteMarkdown("");
      return copy;
    },
    [repo, loadProjectFiles, setters, mergeDiagrams],
  );

  const duplicateNote = useCallback(
    async (note: NoteFile): Promise<NoteFile | null> => {
      const result: Result<NoteFile, Error> = await repo.duplicateNoteFile(
        note.projectId,
        note.id,
      );
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const copy = result.value;
      await loadProjectFiles(copy.projectId);
      setNotes((current: NoteFile[]) =>
        current.some((item) => item.id === copy.id)
          ? current
          : [...current, copy],
      );
      mergeNotes([copy]);
      setters.setSelectedProjectId(copy.projectId);
      setters.setSelectedNoteId(copy.id);
      setters.setSelectedDiagramId(null);
      setters.setNoteMarkdown(copy.markdown);
      setters.setSource("");
      return copy;
    },
    [repo, loadProjectFiles, setters, mergeNotes],
  );

  /**
   * Move a resource's identity record to a new path, preserving its id.
   *
   * Deliberately synchronous: the caller applies the new file list in the same
   * React update, so the reconciling effect never observes a new path beside an
   * old record — which is exactly the state in which it would mint a fresh id
   * and quietly break every `resource://` link to the file. Persisting the
   * record is the caller's business and may be asynchronous.
   */
  const moveMetadataRecord = useCallback(
    (previousPath: string, nextPath: string): ProjectMetadata | null => {
      const current = metadataRef.current;
      if (!current) return null;
      const next = renameResourcePath(current, previousPath, nextPath);
      if (next === current) return null;
      metadataRef.current = next;
      return next;
    },
    [],
  );

  /**
   * Move a resource's identity record for one project, whichever project it is.
   *
   * The in-memory record describes only the selected project, so it is used —
   * and returned for the caller to commit beside the new file list — only when
   * that is the project being renamed. For any other project the record is read
   * from and written back to *that* project's own document; writing the selected
   * project's record under another project's id would overwrite its identities.
   */
  const moveMetadataRecordFor = useCallback(
    async (
      projectId: string,
      previousPath: string,
      nextPath: string,
    ): Promise<ProjectMetadata | null> => {
      if (metadataProject.current === projectId) {
        return moveMetadataRecord(previousPath, nextPath);
      }
      const read = await repo.readProjectMetadata(projectId);
      if (!isOk(read)) {
        setError(read.error);
        return null;
      }
      if (!read.value) return null;
      const next = renameResourcePath(read.value, previousPath, nextPath);
      if (next === read.value) return null;
      const written = await repo.writeProjectMetadata(projectId, next);
      if (!isOk(written)) setError(written.error);
      return null;
    },
    [repo, moveMetadataRecord],
  );

  const renameDiagram = useCallback(
    async (
      projectId: string,
      diagramId: string,
      newName: string,
    ): Promise<DiagramFile | null> => {
      const result: Result<DiagramFile, Error> = await repo.renameDiagramFile(
        projectId,
        diagramId,
        newName,
      );
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const renamed = result.value;
      // Carry the resource id across the rename. This has to happen before the
      // file list below changes, so the reconciling effect never sees a new path
      // with no record and mints a fresh id for it.
      //
      // The record is keyed by *path*, and only a folder-backed project uses the
      // path as the file id — an in-browser diagram's id is generated — so the
      // old name has to come from the file list, not from `diagramId`. The
      // workspace-wide list is what knows a file in a project that is not
      // selected.
      const previousName =
        allDiagrams.find((diagram) => diagram.id === diagramId)?.name ??
        diagrams.find((diagram) => diagram.id === diagramId)?.name ??
        diagramId;
      const nextMetadata = await moveMetadataRecordFor(
        projectId,
        previousName,
        renamed.name,
      );
      // A local-folder rename changes the id (the path *is* the id), so replace
      // the old entry wherever it appears instead of updating it in place.
      const swap = (current: DiagramFile[]): DiagramFile[] => {
        const mapped = current.map((diagram) =>
          diagram.id === diagramId ? renamed : diagram,
        );
        // Guard against a stale entry under the new id (harmless but possible
        // when the tree changed on disk between list and rename).
        return mapped.filter(
          (diagram, index) =>
            mapped.findIndex((other) => other.id === diagram.id) === index,
        );
      };
      setDiagrams(swap);
      setAllDiagrams(swap);
      if (selectedDiagramId === diagramId) setSelectedDiagramId(renamed.id);
      if (nextMetadata) {
        setMetadata(nextMetadata);
        void repo.writeProjectMetadata(projectId, nextMetadata);
      }
      return renamed;
    },
    [repo, diagrams, allDiagrams, selectedDiagramId, moveMetadataRecordFor],
  );

  const renameNote = useCallback(
    async (
      projectId: string,
      noteId: string,
      newName: string,
    ): Promise<NoteFile | null> => {
      const result: Result<NoteFile, Error> = await repo.renameNoteFile(
        projectId,
        noteId,
        newName,
      );
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const renamed = result.value;
      const previousName =
        allNotes.find((note) => note.id === noteId)?.name ??
        notes.find((note) => note.id === noteId)?.name ??
        noteId;
      const nextMetadata = await moveMetadataRecordFor(
        projectId,
        previousName,
        renamed.name,
      );
      const swap = (current: NoteFile[]): NoteFile[] => {
        const mapped = current.map((note) =>
          note.id === noteId ? renamed : note,
        );
        return mapped.filter(
          (note, index) =>
            mapped.findIndex((other) => other.id === note.id) === index,
        );
      };
      setNotes(swap);
      setAllNotes(swap);
      if (selectedNoteId === noteId) setSelectedNoteId(renamed.id);
      if (nextMetadata) {
        setMetadata(nextMetadata);
        void repo.writeProjectMetadata(projectId, nextMetadata);
      }
      return renamed;
    },
    [repo, notes, allNotes, selectedNoteId, moveMetadataRecordFor],
  );

  const setDiagramTitle = useCallback(
    async (
      diagram: DiagramFile,
      title: string,
    ): Promise<DiagramFile | null> => {
      const nextSource = withDiagramTitle(diagram.source, title);
      const result: Result<DiagramFile, Error> = await repo.saveDiagramFile(
        diagram.projectId,
        { ...diagram, source: nextSource },
      );
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const stored = result.value;
      const merge = (current: DiagramFile[]): DiagramFile[] =>
        replaceById(current, stored);
      setDiagrams(merge);
      setAllDiagrams(merge);
      if (selectedDiagramId === diagram.id) setSource(nextSource);
      return stored;
    },
    [repo, selectedDiagramId],
  );

  const setNoteTitle = useCallback(
    async (note: NoteFile, title: string): Promise<NoteFile | null> => {
      const nextMarkdown = withNoteTitle(note.markdown, title);
      const result: Result<NoteFile, Error> = await repo.saveNoteFile(
        note.projectId,
        { ...note, markdown: nextMarkdown },
      );
      if (!isOk(result)) {
        setError(result.error);
        return null;
      }
      const stored = result.value;
      const merge = (current: NoteFile[]): NoteFile[] =>
        replaceById(current, stored);
      setNotes(merge);
      setAllNotes(merge);
      if (selectedNoteId === note.id) setNoteMarkdown(nextMarkdown);
      return stored;
    },
    [repo, selectedNoteId],
  );

  // Fold an edit made in the editor back into both lists. Only the content and
  // file name can change; the id and project are stable.
  const applyDiagramEdit = useCallback((edited: DiagramFile) => {
    const merge = (current: DiagramFile[]): DiagramFile[] =>
      current.map((diagram) =>
        diagram.id === edited.id
          ? {
              ...diagram,
              name: edited.name,
              source: edited.source,
              metadata: edited.metadata,
            }
          : diagram,
      );
    setDiagrams(merge);
    setAllDiagrams(merge);
  }, []);

  const applyNoteEdit = useCallback((edited: NoteFile) => {
    const merge = (current: NoteFile[]): NoteFile[] =>
      current.map((note) =>
        note.id === edited.id
          ? {
              ...note,
              name: edited.name,
              markdown: edited.markdown,
              metadata: edited.metadata,
            }
          : note,
      );
    setNotes(merge);
    setAllNotes(merge);
  }, []);

  const refresh = useCallback(async (): Promise<{
    diagrams: DiagramFile[];
    notes: NoteFile[];
  }> => {
    if (!selectedProjectId) return { diagrams: [], notes: [] };
    const projectId = selectedProjectId;
    const [diagramResult, noteResult] = await Promise.all([
      repo.listDiagramFiles(projectId),
      repo.listNoteFiles(projectId),
    ]);
    const nextDiagrams = isOk(diagramResult) ? diagramResult.value : [];
    const nextNotes = isOk(noteResult) ? noteResult.value : [];
    setDiagrams(nextDiagrams);
    setNotes(nextNotes);
    setAllDiagrams((current) => [
      ...current.filter((file) => file.projectId !== projectId),
      ...nextDiagrams,
    ]);
    setAllNotes((current) => [
      ...current.filter((file) => file.projectId !== projectId),
      ...nextNotes,
    ]);
    const diagram = nextDiagrams.find((file) => file.id === selectedDiagramId);
    const note = nextNotes.find((file) => file.id === selectedNoteId);
    if (diagram) {
      setSelectedDiagramId(diagram.id);
      setSelectedNoteId(null);
      setSource(diagram.source);
    } else if (note) {
      setSelectedNoteId(note.id);
      setSelectedDiagramId(null);
      setNoteMarkdown(note.markdown);
    } else if (nextDiagrams[0]) {
      setSelectedDiagramId(nextDiagrams[0].id);
      setSelectedNoteId(null);
      setSource(nextDiagrams[0].source);
    } else if (nextNotes[0]) {
      setSelectedNoteId(nextNotes[0].id);
      setSelectedDiagramId(null);
      setNoteMarkdown(nextNotes[0].markdown);
    } else {
      setSelectedDiagramId(null);
      setSelectedNoteId(null);
      setSource("");
      setNoteMarkdown("");
    }
    if (!isOk(diagramResult)) setError(diagramResult.error);
    if (!isOk(noteResult)) setError(noteResult.error);
    return { diagrams: nextDiagrams, notes: nextNotes };
  }, [repo, selectedDiagramId, selectedNoteId, selectedProjectId]);

  // The explorer and its search never see paths the user removed from the app.
  // Filtering happens here, during render, so every consumer agrees on what is
  // visible and a hide shows up immediately.
  const visibleProjects = useMemo(
    () => projects.filter((project) => !isHidden(hiddenPaths, project.id)),
    [projects, hiddenPaths],
  );
  const visibleDiagrams = useMemo(
    () => diagrams.filter((diagram) => !isHidden(hiddenPaths, diagram.id)),
    [diagrams, hiddenPaths],
  );
  const visibleNotes = useMemo(
    () => notes.filter((note) => !isHidden(hiddenPaths, note.id)),
    [notes, hiddenPaths],
  );
  const visibleAllDiagrams = useMemo(
    () => allDiagrams.filter((diagram) => !isHidden(hiddenPaths, diagram.id)),
    [allDiagrams, hiddenPaths],
  );
  const visibleAllNotes = useMemo(
    () => allNotes.filter((note) => !isHidden(hiddenPaths, note.id)),
    [allNotes, hiddenPaths],
  );

  return {
    projects: visibleProjects,
    diagrams: visibleDiagrams,
    notes: visibleNotes,
    allDiagrams: visibleAllDiagrams,
    allNotes: visibleAllNotes,
    selectedProjectId,
    selectedDiagramId,
    selectedNoteId,
    selectedDiagram,
    selectedNote,
    source,
    noteMarkdown,
    isLoading,
    refresh,
    error,
    metadata,
    resourceIdForFile,
    loadDiagram,
    loadNote,
    saveCurrentDiagram,
    saveCurrentNote,
    createProject,
    renameProject,
    importProject,
    deleteProject,
    deleteDiagram,
    deleteNote,
    hiddenPaths,
    unhidePath,
    createEmptyDiagram,
    createEmptyEventFlow,
    createEmptyNote,
    duplicateDiagram,
    duplicateNote,
    renameDiagram,
    renameNote,
    setDiagramTitle,
    setNoteTitle,
    applyDiagramEdit,
    applyNoteEdit,
  };
}
