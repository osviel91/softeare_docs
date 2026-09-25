/**
 * Application shell.
 *
 * App owns the workspace repository and feeds its state to every pane. A project
 * holds two kinds of document — diagrams (DSL) and markdown documents — and both
 * open into one mixed tab strip:
 *
 * - Selecting either kind opens (or activates) its tab; the editor edits the
 *   active tab's buffer, which is auto-saved back through {@link useTabs}, and
 *   the preview renders it — a diagram canvas for DSL, rendered markdown for a
 *   document.
 * - Activating a tab loads its document into the workspace, so the shell's active
 *   document (and therefore which editor is shown) follows the strip. Closing the
 *   active tab moves both to the neighbour the strip selects.
 * - A markdown document's `[[Diagram]]` links navigate back to a diagram.
 *
 * Two backends are supported and swapped through a single active repository:
 * in-browser projects (IndexedDB) when no folder is open, and a local folder the
 * user opens via the File System Access API. The explorer's context menus ask the
 * shell to rename, retitle, or delete a file; deletion always goes through a
 * confirmation dialog.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Editor from "./features/editor/Editor";
import {
  EVENT_FLOW_SNIPPETS,
  SEQUENCE_SNIPPETS,
} from "./features/editor/snippets";
import Preview from "./features/preview/Preview";
import Explorer, { type MenuPosition } from "./features/explorer/Explorer";
import WorkspaceSwitcher, {
  type WorkspaceMode,
} from "./features/explorer/WorkspaceSwitcher";
import type {
  ServerAdminUser,
  ServerWorkspace,
  ServerWorkspaceMember,
} from "./workspace/server/api-client";
import TabBar from "./features/tabs/TabBar";
import DocsPage from "./features/docs/DocsPage";
import ConfirmDialog from "./features/ui/ConfirmDialog";
import ContextMenu, { type ContextMenuItem } from "./features/ui/ContextMenu";
import PromptDialog from "./features/ui/PromptDialog";
import SaveConflictDialog from "./features/ui/SaveConflictDialog";
import HistoryPanel from "./features/history/HistoryPanel";
import ResourceActionBar from "./features/ui/ResourceActionBar";
import MarkdownEditor from "./features/notes/MarkdownEditor";
import MarkdownView from "./features/notes/MarkdownView";
import {
  useWorkspace,
  type DeleteScope,
} from "./features/explorer/use-workspace";
import { useWorkspaceRepository } from "./features/explorer/workspace-factory";
import { useVersionHistory } from "./features/history/version-history-factory";
import { useDiagramHistory } from "./features/history/use-diagram-history";
import { useServerTrajectory } from "./features/history/use-server-trajectory";
import type { DiagramFile, NoteFile, Project } from "./domain/workspace/types";
import {
  diagramResource,
  noteResource,
  type ProjectResource,
} from "./domain/workspace/resource";
import { resolveProjectLink } from "./domain/workspace/project-link";
import { isOk } from "./shared/result/result";
import {
  archiveSlug,
  exportProjectToZip,
  importProjectFromZip,
} from "./workspace/transfer/project-archive";
import { downloadBytes } from "./workspace/transfer/download";
import { readFileBytes } from "./workspace/transfer/read-file";
import { publishProject } from "./workspace/server/publish-project";
import { diagramDisplayName, diagramTitle } from "./language/diagram-title";
import { noteDisplayName, noteTitle } from "./language/markdown/note-title";
import type { DiagramVersion } from "./domain/workspace/version";
import { RESTORED_VERSION_LABEL } from "./domain/workspace/version";
import {
  createInMemoryHiddenPathStore,
  createLocalStorageHiddenPathStore,
} from "./workspace/hidden-paths";
import { useTabs } from "./features/tabs/use-tabs";
import {
  closeTab as closeTabInSet,
  getActiveTab,
  isDirty,
  tabDocumentOfDiagram,
  tabDocumentOfNote,
  type TabDocument,
} from "./features/tabs/tabs";
import { useDiagram } from "./features/preview/use-diagram";
import { useCommandPalette } from "./features/commands/use-command-palette";
import { useCommands } from "./features/commands/use-commands";
import { useShortcuts } from "./features/commands/use-shortcuts";
import {
  COMMAND_PALETTE_BINDING,
  bindingLabel,
} from "./features/commands/shortcuts";
import CommandPalette from "./features/commands/CommandPalette";
import SearchPanel from "./features/search/SearchPanel";
import { useProjectSearch } from "./features/search/use-project-search";
import { buildSearchDocuments } from "./features/search/search-documents";
import type { EditorReveal } from "./features/editor/reveal";
import type { SearchMatch } from "./domain/search/project-search";
import type { Command, CommandRegistry } from "./features/commands/command";
import OutlinePanel from "./features/outline/OutlinePanel";
import EventFlowPreview, {
  type EventFlowView,
} from "./features/preview/EventFlowPreview";
import { renderEventFlowDocument } from "./renderer/pipeline/eventflow-to-svg";
import { analyzeEventFlow } from "./language/eventflow/parser";
import {
  eventFlowNodeAtPosition,
  eventFlowNodeById,
} from "./domain/eventflow/node-lookup";
import {
  resourceRepresentationOfName,
  resourceTypeOfName,
} from "./domain/workspace/resource-id";
import ProblemsPanel from "./features/problems/ProblemsPanel";
import QuickOpen from "./features/quickopen/QuickOpen";
import type { QuickOpenItem } from "./features/quickopen/quick-open-model";
import { useProjectIndex } from "./features/project/use-project-index";
import ProjectOverview from "./features/project/ProjectOverview";
import {
  eventFlowOutline,
  markdownOutline,
  sequenceOutline,
  type OutlineNode,
} from "./domain/outline/outline";
import { completeAt, completeEventFlowAt } from "./domain/project/completion";
import { hoverAt, type HoverInfo } from "./domain/project/hover";
import {
  findSymbolReferences,
  planSymbolRename,
} from "./domain/project/references";
import {
  SYMBOL_KIND_LABELS,
  embedResourceType,
  isResourceSymbolKind,
} from "./domain/project/project-index";
import { nodeIdAtOffset, nodeRangeById } from "./domain/diagram/node-id";
import { messageStepNumbers } from "./domain/diagram/step-numbers";
import { collectParticipantMentions } from "./domain/diagram/participant-mentions";
import { collectEventFlowMentions } from "./domain/eventflow/mentions";
import type { SourceMention } from "./domain/source-mention";
import { isValid } from "./language/validator/validator";
import { offsetToPosition, rangeToOffsets } from "./language/source-position";
import { analyze } from "./language/analyze";
import { renderDiagramDocument } from "./renderer/pipeline/diagram-to-svg";
import ExportDialog from "./features/export/ExportDialog";
import {
  exportDiagramSvg,
  exportFileName,
  exportMimeType,
  normalizeScale,
  svgToPdf,
  svgToPng,
  type DiagramExportOptions,
} from "./features/export/diagram-export";
import { exportDocumentationSite } from "./features/export/site/site-export";
import { createZip } from "./workspace/transfer/zip";
import {
  openFileSystemRepository,
  supportsFileSystemAccess,
  type OpenedFolder,
} from "./workspace/fs-access/create-file-system-repository";
import type { WorkspaceRepository } from "./workspace/WorkspaceRepository";
import { ServerApiClient } from "./workspace/server/api-client";
import { useAuth } from "./features/server/use-auth";
import { useServerWorkspaces } from "./features/server/use-server-workspaces";
import AgentsAndTokens from "./features/server/AgentsAndTokens";
import PlatformAdministration from "./features/server/PlatformAdministration";
import LoginScreen from "./features/server/LoginScreen";
import { RevisionConflictError } from "./workspace/server/api-errors";
import { supportsForcedWrite } from "./workspace/server/server-workspace-repository";
import ResourceMetadataEditor from "./features/resource/ResourceMetadataEditor";
import ComplementaryViews from "./features/resource/ComplementaryViews";
import { ProposalReviewPanel } from "./features/proposals/ProposalReview";
import ChangesInbox from "./features/proposals/ChangesInbox";
import {
  useProjectProposalCount,
  useProjectResourceProposalCounts,
  useResourceProposalCount,
} from "./features/proposals/project-proposals";
import type { ResourceMetadata } from "./domain/workspace/resource-metadata";

const PRODUCT_NAME = "Software Docs Manager";

/** Which panel the editor pane shows. */
type EditorView =
  "code" | "outline" | "problems" | "overview" | "history" | "changes";

/**
 * Which page the shell shows. The editor, explorer and preview make up the
 * workspace; the documentation is a page of its own rather than a panel inside
 * the editor pane, because it is reference material about the tools rather than
 * something you edit alongside a diagram. Access tokens and workspace settings
 * are separate pages because they are account administration rather than editing
 * tools.
 */
type AppPage = "workspace" | "docs" | "tokens" | "settings";

/**
 * A destructive action waiting for confirmation. The dialog is opened when the
 * user asks to delete; nothing is removed until they choose a scope.
 */
type PendingDelete =
  | { kind: "project"; id: string; name: string }
  | { kind: "diagram"; id: string; projectId: string; name: string }
  | { kind: "note"; id: string; projectId: string; name: string };

/** The file or project a context menu was opened over, and where to place it. */
type MenuTarget =
  | ({ kind: "diagram"; diagram: DiagramFile } & MenuPosition)
  | ({ kind: "note"; note: NoteFile } & MenuPosition)
  | ({ kind: "project"; project: Project } & MenuPosition)
  | ({ kind: "project-add"; project: Project } & MenuPosition);

/** The rename/title prompt currently open, if any. */
type PromptTarget =
  | { kind: "rename-symbol"; name: string }
  | { kind: "rename-project"; project: Project }
  | { kind: "rename-diagram"; diagram: DiagramFile }
  | { kind: "rename-note"; note: NoteFile }
  | { kind: "title-diagram"; diagram: DiagramFile }
  | { kind: "title-note"; note: NoteFile };

/** Find the diagram a `[[Name]]` link points at, by display name or file name. */
function findDiagramByLink(
  diagrams: DiagramFile[],
  target: string,
): DiagramFile | null {
  const needle = target.trim().toLowerCase();
  if (needle === "") return null;
  return (
    diagrams.find(
      (diagram) =>
        diagramDisplayName(diagram.name, diagram.source).toLowerCase() ===
          needle || diagram.name.toLowerCase() === needle,
    ) ?? null
  );
}

/** Rough word count for the status bar while a note is open. */
function wordCount(markdown: string): number {
  const trimmed = markdown.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

export default function App() {
  const defaultRepo = useWorkspaceRepository();
  const [openedFolder, setOpenedFolder] = useState<OpenedFolder | null>(null);
  // The API client is stateless and shared: one instance keeps the cookie
  // handling, error mapping and base URL in one place for every feature.
  const apiClient = useMemo(() => new ServerApiClient(), []);
  const auth = useAuth(apiClient);
  const [selectedServerWorkspaceId, setSelectedServerWorkspaceId] = useState<
    string | null
  >(null);
  const server = useServerWorkspaces(
    apiClient,
    auth,
    selectedServerWorkspaceId,
  );
  const [adminUsers, setAdminUsers] = useState<ServerAdminUser[]>([]);
  const [serverWorkspaces, setServerWorkspaces] = useState<ServerWorkspace[]>(
    [],
  );
  const [workspaceMembersByWorkspaceId, setWorkspaceMembersByWorkspaceId] =
    useState<Record<string, ServerWorkspaceMember[]>>({});
  const refreshServerWorkspaces = useCallback(() => {
    void apiClient
      .listWorkspaces()
      .then((workspaces) => {
        setServerWorkspaces(workspaces);
        setSelectedServerWorkspaceId((selected) =>
          workspaces.some((workspace) => workspace.id === selected)
            ? selected
            : (workspaces[0]?.id ?? null),
        );
        return Promise.all(
          workspaces.map(async (workspace) => {
            try {
              return [
                workspace.id,
                await apiClient.listWorkspaceMembers(workspace.id),
              ] as const;
            } catch {
              return [workspace.id, []] as const;
            }
          }),
        );
      })
      .then((entries) => {
        if (entries)
          setWorkspaceMembersByWorkspaceId(Object.fromEntries(entries));
      })
      .catch(() => {
        setServerWorkspaces([]);
        setWorkspaceMembersByWorkspaceId({});
        setSelectedServerWorkspaceId(null);
      });
  }, [apiClient]);
  useEffect(() => {
    if (auth.user?.platformAdmin !== true) {
      setAdminUsers([]);
      return;
    }
    void apiClient
      .listAdminUsers()
      .then(setAdminUsers)
      .catch(() => setAdminUsers([]));
  }, [apiClient, auth.user?.platformAdmin]);
  useEffect(() => {
    if (auth.status !== "authenticated") {
      setServerWorkspaces([]);
      setWorkspaceMembersByWorkspaceId({});
      setSelectedServerWorkspaceId(null);
      return;
    }
    refreshServerWorkspaces();
  }, [auth.status, refreshServerWorkspaces]);
  const setAdminUserStatus = useCallback(
    (userId: string, status: ServerAdminUser["status"]) => {
      void apiClient.setUserStatus(userId, status).then((updated) => {
        setAdminUsers((users) =>
          users.map((user) => (user.id === updated.id ? updated : user)),
        );
      });
    },
    [apiClient],
  );
  const setWorkspaceMemberRole = useCallback(
    (
      workspaceId: string,
      userId: string,
      role: ServerWorkspaceMember["role"],
    ) => {
      void apiClient
        .setWorkspaceMemberRole(workspaceId, userId, role)
        .then((updated) => {
          setWorkspaceMembersByWorkspaceId((membersByWorkspace) => ({
            ...membersByWorkspace,
            [workspaceId]: (membersByWorkspace[workspaceId] ?? []).map(
              (member) => (member.userId === updated.userId ? updated : member),
            ),
          }));
        });
    },
    [apiClient],
  );
  const removeWorkspaceMember = useCallback(
    (workspaceId: string, userId: string) => {
      void apiClient.removeWorkspaceMember(workspaceId, userId).then(() => {
        setWorkspaceMembersByWorkspaceId((membersByWorkspace) => ({
          ...membersByWorkspace,
          [workspaceId]: (membersByWorkspace[workspaceId] ?? []).filter(
            (member) => member.userId !== userId,
          ),
        }));
      });
    },
    [apiClient],
  );
  const createServerWorkspace = useCallback(
    (name: string) => {
      void apiClient.createWorkspace(name).then(refreshServerWorkspaces);
    },
    [apiClient, refreshServerWorkspaces],
  );
  const renameServerWorkspace = useCallback(
    (workspaceId: string, name: string) => {
      void apiClient
        .renameWorkspace(workspaceId, name)
        .then(refreshServerWorkspaces);
    },
    [apiClient, refreshServerWorkspaces],
  );
  const deleteServerWorkspace = useCallback(
    (workspaceId: string) => {
      void apiClient.deleteWorkspace(workspaceId).then(refreshServerWorkspaces);
    },
    [apiClient, refreshServerWorkspaces],
  );
  const [page, setPage] = useState<AppPage>("workspace");
  const [view, setView] = useState<EditorView>("code");
  const [historyResourceScoped, setHistoryResourceScoped] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [explorerWidth, setExplorerWidth] = useState(252);
  const [editorWidth, setEditorWidth] = useState<number | null>(null);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [previewMaximized, setPreviewMaximized] = useState(false);
  const [eventFlowView, setEventFlowView] = useState<EventFlowView>("flow");
  const eventFlowViewTouched = useRef(false);
  const [resizing, setResizing] = useState<"explorer" | "editor" | null>(null);
  // The source the preview is actually showing. While auto-update is on this
  // tracks the editor; while it is off it only moves when the user renders.
  const [renderedSource, setRenderedSource] = useState("");
  // The delete awaiting confirmation, the open context menu, and the open
  // rename/title prompt.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [prompt, setPrompt] = useState<PromptTarget | null>(null);
  // The source range an editor should select and scroll to, set when a search
  // result is opened and cleared implicitly by the next reveal token.
  const [reveal, setReveal] = useState<EditorReveal | null>(null);
  // The last failure from exporting or importing a project, shown in the status
  // bar. These cross the repository boundary, so they are reported rather than
  // thrown.
  const [transferError, setTransferError] = useState<string | null>(null);
  // The hidden file input the Import Project command clicks.
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // Whether the conflict dialog's "copy my changes" has just succeeded, so the
  // button can say so instead of looking inert.
  const [conflictCopied, setConflictCopied] = useState(false);
  // Quick open, and the caret/preview-sync state that drives the outline
  // highlight, hover cards and source↔diagram selection.
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [caretOffset, setCaretOffset] = useState(0);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  // A find-references result, shown in the same overlay the project search uses
  // so there is one result surface rather than two.
  const [referenceMatches, setReferenceMatches] = useState<
    SearchMatch[] | null
  >(null);
  const [referenceTitle, setReferenceTitle] = useState("");
  // The diagram export dialog, opened from the palette or the toolbar.
  const [exportDiagramOpen, setExportDiagramOpen] = useState(false);
  // A restore that has to open another diagram's tab first; applied once that
  // document is the one on screen.
  const [pendingRestore, setPendingRestore] = useState<{
    diagramId: string;
    source: string;
  } | null>(null);
  const [proposalReviewOpen, setProposalReviewOpen] = useState(false);
  const [reviewProposalId, setReviewProposalId] = useState<string | null>(null);
  const [reviewReadOnly, setReviewReadOnly] = useState(false);
  const [proposalRefreshKey, setProposalRefreshKey] = useState(0);

  const resizePane = useCallback(
    (pane: "explorer" | "editor", clientX: number): void => {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      const bounds = workspace.getBoundingClientRect();
      const splitterWidth = 8;
      const previewMinimum = 280;
      if (pane === "explorer") {
        const maximum = Math.max(
          180,
          bounds.width - 280 - previewMinimum - 2 * splitterWidth,
        );
        setExplorerWidth(
          Math.min(maximum, Math.max(180, clientX - bounds.left)),
        );
        return;
      }
      const explorerSpace = explorerCollapsed
        ? 30
        : explorerWidth + splitterWidth;
      const maximum = Math.max(
        280,
        bounds.width - explorerSpace - previewMinimum - splitterWidth,
      );
      setEditorWidth(
        Math.min(maximum, Math.max(280, clientX - bounds.left - explorerSpace)),
      );
    },
    [explorerCollapsed, explorerWidth],
  );

  const startResize = useCallback(
    (pane: "explorer" | "editor", event: ReactPointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(pane);
      resizePane(pane, event.clientX);
    },
    [resizePane],
  );

  const moveResize = useCallback(
    (pane: "explorer" | "editor", event: ReactPointerEvent<HTMLDivElement>) => {
      if (resizing === pane) resizePane(pane, event.clientX);
    },
    [resizePane, resizing],
  );

  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(null);
  }, []);

  const resizeWithKeyboard = useCallback(
    (
      pane: "explorer" | "editor",
      event: ReactKeyboardEvent<HTMLDivElement>,
    ) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const workspace = workspaceRef.current;
      if (!workspace) return;
      event.preventDefault();
      const bounds = workspace.getBoundingClientRect();
      const delta = event.key === "ArrowLeft" ? -16 : 16;
      if (pane === "explorer") {
        resizePane(pane, bounds.left + explorerWidth + delta);
        return;
      }
      const explorerSpace = explorerCollapsed ? 30 : explorerWidth + 8;
      const currentWidth =
        editorWidth ?? Math.max(280, (bounds.width - explorerSpace - 8) * 0.42);
      resizePane(pane, bounds.left + explorerSpace + currentWidth + delta);
    },
    [editorWidth, explorerCollapsed, explorerWidth, resizePane],
  );

  useEffect(() => {
    if (!previewMaximized) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewMaximized(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewMaximized]);

  /**
   * Open a local folder (replacing the active repository) or, when a folder is
   * already open, close it and return to in-browser projects. A cancelled picker
   * leaves the current repository untouched by resetting to `null`. Opening a
   * folder also closes any server project, so the editor is only ever bound to
   * one source.
   */
  const openFolder = useCallback(async () => {
    if (openedFolder) {
      setOpenedFolder(null);
      return;
    }
    server.close();
    try {
      setOpenedFolder(await openFileSystemRepository());
    } catch {
      setOpenedFolder(null);
    }
  }, [openedFolder, server.close]);

  /** Return to the in-browser projects. */
  const openLocalWorkspace = useCallback(() => {
    server.close();
    setOpenedFolder(null);
  }, [server.close]);

  const activeRepo: WorkspaceRepository =
    server.active?.repository ?? openedFolder?.repository ?? defaultRepo;

  /** Which source the editor is bound to, for the switcher's own rendering. */
  const workspaceMode: WorkspaceMode = server.active
    ? "server"
    : openedFolder
      ? "folder"
      : "local";

  // Paths the user "removed from the app" are remembered per opened folder, so
  // hiding a file never touches the disk and is scoped to that folder's tree.
  // In-browser projects have no second copy, so a session-local store suffices,
  // and a server project gets its own so switching projects starts clean.
  const hiddenStore = useMemo(
    () =>
      openedFolder
        ? createLocalStorageHiddenPathStore(openedFolder.folderName)
        : createInMemoryHiddenPathStore(),
    // A new store per server project is the point: hide state must not leak
    // between projects.
    [openedFolder, server.active?.project.id],
  );

  const workspace = useWorkspace(activeRepo, hiddenStore);
  const {
    projects,
    diagrams,
    notes,
    allDiagrams,
    allNotes,
    selectedProjectId,
    selectedDiagramId,
    selectedNoteId,
    selectedDiagram,
    selectedNote,
    isLoading,
    error,
    refresh: refreshWorkspace,
    loadDiagram,
    loadNote,
    createProject,
    applyDiagramEdit,
    applyNoteEdit,
    metadata,
    resourceIdForFile,
    hiddenPaths,
    unhidePath,
  } = workspace;

  // The document the workspace has selected, in the shape the tab strip speaks.
  // A project holds diagrams and markdown documents; exactly one is loaded at a
  // time, and either kind opens into the same tab strip and the same editor pane.
  const selectedDocument = useMemo<TabDocument | null>(() => {
    if (selectedNote) return tabDocumentOfNote(selectedNote);
    if (selectedDiagram) return tabDocumentOfDiagram(selectedDiagram);
    return null;
  }, [selectedDiagram, selectedNote]);

  /** Fold an auto-saved buffer back into the workspace's in-memory lists. */
  const onDocumentEdit = useCallback(
    (document: TabDocument): void => {
      if (document.kind === "note") {
        applyNoteEdit({
          id: document.id,
          name: document.name,
          markdown: document.source,
          projectId: document.projectId,
          metadata: document.metadata,
        });
      } else {
        applyDiagramEdit({
          id: document.id,
          name: document.name,
          source: document.source,
          projectId: document.projectId,
          metadata: document.metadata,
        });
      }
    },
    [applyNoteEdit, applyDiagramEdit],
  );

  // Tabs own the open documents (and auto-save them), so the editor and preview
  // derive from the active tab rather than from the workspace hook.
  const tabsHook = useTabs(activeRepo, selectedDocument, onDocumentEdit);
  const {
    tabs,
    activeTabId,
    activeTab,
    source,
    activateTab,
    closeTab,
    updateActiveSource,
  } = tabsHook;

  const syncServerWorkspace = useCallback(async (): Promise<void> => {
    if (workspaceMode !== "server" || !server.active) return;
    await server.refresh();
    const refreshed = await refreshWorkspace();
    if (tabsHook.activeTab && isDirty(tabsHook.activeTab)) return;
    const diagram = refreshed.diagrams.find((file) => file.id === selectedDiagramId);
    const note = refreshed.notes.find((file) => file.id === selectedNoteId);
    if (diagram) tabsHook.applyExternalDiagram(diagram);
    if (note) tabsHook.applyExternalNote(note);
  }, [refreshWorkspace, selectedDiagramId, selectedNoteId, server, tabsHook, workspaceMode]);

  useEffect(() => {
    const revalidate = () => {
      void syncServerWorkspace();
    };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [syncServerWorkspace]);

  const metadataWritable =
    workspaceMode !== "server" || server.active?.writable === true;
  const saveResourceMetadata = useCallback(
    async (next: ResourceMetadata): Promise<ResourceMetadata | Error> => {
      if (!selectedProjectId || (!selectedNote && !selectedDiagram)) {
        return new Error("No resource is selected.");
      }
      if (selectedNote) {
        const current = await activeRepo.saveNoteFile(selectedProjectId, {
          ...selectedNote,
          markdown: source,
          metadata: next,
        });
        if (!isOk(current)) return current.error;
        applyNoteEdit(current.value);
        tabsHook.applyExternalNote(current.value);
        return current.value.metadata ?? {};
      }
      const current = await activeRepo.saveDiagramFile(selectedProjectId, {
        ...selectedDiagram!,
        source,
        metadata: next,
      });
      if (!isOk(current)) return current.error;
      applyDiagramEdit(current.value);
      tabsHook.applyExternalDiagram(current.value);
      return current.value.metadata ?? {};
    },
    [
      activeRepo,
      applyDiagramEdit,
      applyNoteEdit,
      selectedDiagram,
      selectedNote,
      selectedProjectId,
      source,
      tabsHook,
    ],
  );

  // A failed auto-save is surfaced rather than swallowed. A revision conflict is
  // the one failure that needs a decision from the user; everything else is
  // reported with a retry. In both cases the buffer stays in the editor and the
  // tab stays dirty, because the user's work must survive a failed write.
  const saveFailure = tabsHook.saveError;
  const conflict =
    saveFailure !== null && saveFailure.error instanceof RevisionConflictError
      ? saveFailure
      : null;
  const retryableSaveFailure =
    saveFailure !== null &&
    !(saveFailure.error instanceof RevisionConflictError)
      ? saveFailure
      : null;

  // A new failure belongs to a new decision, so the "copied" confirmation resets.
  useEffect(() => {
    setConflictCopied(false);
  }, [saveFailure]);

  /** Take the server's version, discarding the local buffer for that document. */
  const resolveConflictByReload = useCallback(async (): Promise<void> => {
    if (conflict === null) return;
    const document = conflict.document;
    if (document.kind === "note") {
      const read = await activeRepo.getNoteFile(
        document.projectId,
        document.id,
      );
      if (isOk(read) && read.value !== null) {
        tabsHook.applyExternalNote(read.value);
      }
    } else {
      const read = await activeRepo.getDiagramFile(
        document.projectId,
        document.id,
      );
      if (isOk(read) && read.value !== null) {
        tabsHook.applyExternalDiagram(read.value);
      }
    }
    tabsHook.dismissSaveError();
  }, [conflict, activeRepo, tabsHook]);

  /**
   * Overwrite the server's version with the local buffer.
   *
   * Only offered when the server told us its current revision *and* the active
   * repository can write against an explicitly named revision. Local mode has no
   * revisions and therefore never reaches this dialog at all.
   */
  const resolveConflictByKeepingMine = useCallback(async (): Promise<void> => {
    if (conflict === null) return;
    const document = conflict.document;
    const current =
      conflict.error instanceof RevisionConflictError
        ? conflict.error.currentRevision
        : null;
    if (current === null || !supportsForcedWrite(activeRepo)) return;
    if (document.kind === "note") {
      const written = await activeRepo.forceSaveNoteFile(
        document.projectId,
        {
          id: document.id,
          name: document.name,
          markdown: document.source,
          projectId: document.projectId,
        },
        current,
      );
      if (isOk(written)) {
        tabsHook.markActiveSaved();
        applyNoteEdit({
          id: document.id,
          name: document.name,
          markdown: document.source,
          projectId: document.projectId,
        });
        return;
      }
    } else {
      const written = await activeRepo.forceSaveDiagramFile(
        document.projectId,
        {
          id: document.id,
          name: document.name,
          source: document.source,
          projectId: document.projectId,
        },
        current,
      );
      if (isOk(written)) {
        tabsHook.markActiveSaved();
        applyDiagramEdit({
          id: document.id,
          name: document.name,
          source: document.source,
          projectId: document.projectId,
        });
        return;
      }
    }
    // Someone wrote again between the conflict and the confirmation. Re-running
    // the normal save replaces this dialog's information with the newest revision
    // rather than pretending the overwrite landed.
    tabsHook.retrySave();
  }, [conflict, activeRepo, tabsHook, applyNoteEdit, applyDiagramEdit]);

  /** Put the local buffer on the clipboard so it can be pasted by hand. */
  const copyConflictBuffer = useCallback((): void => {
    if (conflict === null) return;
    const clipboard = navigator.clipboard;
    if (clipboard !== undefined) {
      void clipboard.writeText(conflict.document.source).catch(() => undefined);
    }
    setConflictCopied(true);
  }, [conflict]);

  /**
   * Create a project in whichever source is active.
   *
   * The explorer's "new project" form is about the workspace the user is looking
   * at, not about a storage backend, so this is the one place that has to know
   * which of the two it means.
   */
  const createProjectHere = useCallback(
    (name: string): void => {
      if (workspaceMode === "server") {
        void server.createProject(name);
        return;
      }
      void createProject(name);
    },
    [workspaceMode, server.createProject, createProject],
  );

  // The project index: every symbol, reference and problem in the selected
  // project, derived from the files and rebuilt incrementally. Everything below
  // reads it rather than recomputing project facts, and it is built here — before
  // the document helpers — because link resolution needs it too.
  const index = useProjectIndex(selectedProjectId, diagrams, notes, metadata);
  const complementaryResources = (index?.resources ?? []).map((resource) => ({
    id: resource.id,
    title: resource.title,
  }));

  // Version history ("Trajectory") only applies to a diagram, and only while the
  // tab showing it is the one on screen.
  const historySource =
    activeTab && selectedDiagram && activeTab.documentId === selectedDiagram.id
      ? activeTab.source
      : null;

  // Version history ("Trajectory") for the selected diagram and the project it
  // lives in. Recording is automatic (debounced) and content-aware; the panel
  // shows the project as a tree of per-diagram branches.
  const versionStore = useVersionHistory();
  const history = useDiagramHistory(
    versionStore,
    selectedDiagram,
    historySource,
    selectedProjectId,
  );
  const serverTrajectory = useServerTrajectory(
    apiClient,
    selectedProjectId,
    historyResourceScoped ? selectedDiagram?.id ?? null : null,
    workspaceMode === "server",
  );

  const { ast, diagnostics } = useDiagram(source);
  const noteMode = selectedNote !== null;

  // Keep the displayed source in step with the editor while auto-update is on.
  // Seeding from an empty string means the first render always syncs.
  useEffect(() => {
    if (autoUpdate) setRenderedSource(source);
  }, [autoUpdate, source]);

  const isStale = renderedSource !== source;

  // Counts for the status bar, derived from the same analysis the panes use.
  const counts = useMemo(() => {
    if (!ast) return { participants: 0, messages: 0 };
    return {
      participants: ast.participants.length,
      messages: ast.statements.filter((s) => s.type === "message").length,
    };
  }, [ast]);

  // Resolve `[[Diagram]]` links in a note against the workspace's diagrams.
  const resolveWikiLink = useCallback(
    (target: string): string | null => {
      const found = findDiagramByLink(allDiagrams, target);
      return found ? `#diagram/${encodeURIComponent(found.id)}` : null;
    },
    [allDiagrams],
  );

  const openDiagramLink = useCallback(
    (target: string): void => {
      const found = findDiagramByLink(allDiagrams, target);
      if (found) loadDiagram(found);
    },
    [allDiagrams, loadDiagram],
  );

  // Every resource a document may link to, in the shared shape the project-link
  // resolver understands. Links written as ordinary relative paths
  // (`[Payment flow](../diagrams/pay.seq)`) resolve through this list, so a
  // markdown document can point at diagrams and sibling documents alike.
  const resources = useMemo<ProjectResource[]>(
    () => [...allDiagrams.map(diagramResource), ...allNotes.map(noteResource)],
    [allDiagrams, allNotes],
  );

  /**
   * Where a link written in a document points.
   *
   * Two tiers, in the order documentation should prefer them: a stable scheme
   * (`diagram://diagram-checkout`) is looked up by resource id through the index,
   * so it keeps working after a rename; a bare path or `[[name]]` is resolved
   * against the current file tree, which is what documents written before ids
   * existed use. The result is the target *file*, so the caller can open it.
   */
  const findResourceLink = useCallback(
    (href: string): { kind: "diagram" | "note"; path: string } | null => {
      const scheme = /^(resource|diagram|doc):\/\/(.+)$/i.exec(href.trim());
      if (scheme) {
        const id = decodeURIComponent(scheme[2].split("#")[0].split("?")[0]);
        const resource = index?.resources.find((entry) => entry.id === id);
        if (!resource) return null;
        return {
          kind: resource.type === "sequence-diagram" ? "diagram" : "note",
          path: resource.path,
        };
      }
      const resolved = resolveProjectLink(href, {
        fromId: selectedNote?.id ?? selectedDiagram?.id ?? "",
        projectId: selectedNote?.projectId ?? selectedProjectId ?? "",
        resources,
      });
      if (!resolved) return null;
      return {
        kind: resolved.kind === "note" ? "note" : "diagram",
        path: resolved.name,
      };
    },
    [index, resources, selectedNote, selectedDiagram, selectedProjectId],
  );

  const resolveResourceLink = useCallback(
    (href: string): string | null => {
      const found = findResourceLink(href);
      return found
        ? `#resource/${found.kind}/${encodeURIComponent(found.path)}`
        : null;
    },
    [findResourceLink],
  );

  const openResourceLink = useCallback(
    (href: string): void => {
      setView("code");
      const found = findResourceLink(href);
      if (!found) return;
      if (found.kind === "note") {
        const note = allNotes.find((entry) => entry.name === found.path);
        if (note) loadNote(note);
      } else {
        const diagram = allDiagrams.find((entry) => entry.name === found.path);
        if (diagram) loadDiagram(diagram);
      }
    },
    [findResourceLink, allNotes, allDiagrams, loadNote, loadDiagram],
  );

  /**
   * Write one project to a portable ZIP: a manifest plus one
   * human-readable file per diagram and markdown document.
   */
  const exportProject = useCallback(
    async (project: Project): Promise<void> => {
      const [diagramsResult, notesResult] = await Promise.all([
        activeRepo.listDiagramFiles(project.id),
        activeRepo.listNoteFiles(project.id),
      ]);
      if (!isOk(diagramsResult) || !isOk(notesResult)) {
        setTransferError("Could not read the project's files.");
        return;
      }
      const bytes = exportProjectToZip(
        project,
        diagramsResult.value,
        notesResult.value,
      );
      downloadBytes(
        bytes,
        `${archiveSlug(project.name)}.zip`,
        "application/zip",
      );
      setTransferError(null);
    },
    [activeRepo],
  );

  const exportActiveProject = useCallback((): Promise<void> => {
    const project = projects.find((entry) => entry.id === selectedProjectId);
    if (!project) {
      setTransferError("Select a project before exporting it.");
      return Promise.resolve();
    }
    return exportProject(project);
  }, [projects, selectedProjectId, exportProject]);

  /** Read a chosen archive and recreate it as a project in this workspace. */
  const importProjectFile = useCallback(
    async (file: File): Promise<void> => {
      let bytes: Uint8Array;
      try {
        bytes = await readFileBytes(file);
      } catch (error) {
        setTransferError(
          `Could not read “${file.name}”: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      const parsed = importProjectFromZip(bytes);
      if (!isOk(parsed)) {
        setTransferError(parsed.error.message);
        return;
      }
      const created = await workspace.importProject(parsed.value);
      setTransferError(created ? null : "Could not import the project.");
    },
    [workspace.importProject],
  );

  const beginImportProject = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const publishProjectToServer = useCallback(
    async (project: Project): Promise<void> => {
      try {
        const published = await publishProject(apiClient, activeRepo, project);
        await server.refresh();
        await server.openProject(published);
        setTransferError(null);
      } catch (error) {
        setTransferError(
          `Could not publish “${project.name}”: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    [apiClient, activeRepo, server],
  );

  const createNote = useCallback(
    async (projectId: string): Promise<NoteFile | null> => {
      // A new note becomes the active document, so make sure the middle pane is
      // showing the editor rather than Docs or History.
      setView("code");
      const note = await workspace.createEmptyNote(projectId);
      // A note is a tab-backed document like any other, so open it in the strip.
      if (note) tabsHook.openNote(note);
      return note;
    },
    [workspace.createEmptyNote, tabsHook.openNote],
  );

  const createDiagram = useCallback(
    async (projectId: string): Promise<DiagramFile | null> => {
      setView("code");
      const diagram = await workspace.createEmptyDiagram(projectId);
      // A new diagram is a tab-backed document, so open it so the editor shows it.
      if (diagram) tabsHook.openDiagram(diagram);
      return diagram;
    },
    [workspace.createEmptyDiagram, tabsHook.openDiagram],
  );

  const createEventFlow = useCallback(
    async (projectId: string): Promise<DiagramFile | null> => {
      setView("code");
      const flow = await workspace.createEmptyEventFlow(projectId);
      if (flow) tabsHook.openDiagram(flow);
      return flow;
    },
    [workspace.createEmptyEventFlow, tabsHook.openDiagram],
  );

  /** Copy a diagram in place and open the copy, leaving the original untouched. */
  const duplicateDiagram = useCallback(
    async (diagram: DiagramFile): Promise<void> => {
      setView("code");
      const copy = await workspace.duplicateDiagram(diagram);
      if (copy) tabsHook.openDiagram(copy);
    },
    [workspace.duplicateDiagram, tabsHook.openDiagram],
  );

  /** Copy a note in place; the copy becomes the active note. */
  const duplicateNote = useCallback(
    async (note: NoteFile): Promise<void> => {
      setView("code");
      const copy = await workspace.duplicateNote(note);
      if (copy) tabsHook.openNote(copy);
    },
    [workspace.duplicateNote, tabsHook.openNote],
  );

  // Selecting a tab must also load its document into the workspace, so the
  // shell's active document (and therefore which editor is shown) follows the
  // tab the user clicked — whichever kind it is.
  const activateTabAndDocument = useCallback(
    (documentId: string) => {
      const tab = tabs.find((entry) => entry.id === documentId);
      if (tab?.kind === "note") {
        const note = allNotes.find((entry) => entry.id === documentId);
        if (note) loadNote(note);
      } else {
        const diagram = allDiagrams.find((entry) => entry.id === documentId);
        if (diagram) loadDiagram(diagram);
      }
      activateTab(documentId);
    },
    [tabs, allNotes, allDiagrams, loadNote, loadDiagram, activateTab],
  );

  /**
   * Close a tab and keep the editor on the document that replaces it. The strip
   * activates a neighbour when the active tab closes; loading that neighbour here
   * means the workspace selection follows the strip instead of pointing at the
   * document that just went away.
   */
  const closeTabAndFollow = useCallback(
    (documentId: string) => {
      const wasActive = activeTabId === documentId;
      const nextActive = getActiveTab(
        closeTabInSet({ tabs, activeTabId }, documentId),
      );
      closeTab(documentId);
      if (!wasActive || !nextActive) return;
      if (nextActive.kind === "note") {
        const note = allNotes.find(
          (entry) => entry.id === nextActive.documentId,
        );
        if (note) loadNote(note);
      } else {
        const diagram = allDiagrams.find(
          (entry) => entry.id === nextActive.documentId,
        );
        if (diagram) loadDiagram(diagram);
      }
    },
    [tabs, activeTabId, closeTab, allNotes, allDiagrams, loadNote, loadDiagram],
  );

  const closeActiveDocument = useCallback(() => {
    if (activeTabId) closeTabAndFollow(activeTabId);
  }, [activeTabId, closeTabAndFollow]);

  const exportProjectCommand = useCallback(() => {
    void exportActiveProject();
  }, [exportActiveProject]);

  // Project-wide search. The searchable set is built only while the overlay is
  // open, so editing a diagram never pays for indexing the whole workspace.
  const buildDocuments = useCallback(
    () => buildSearchDocuments(projects, allDiagrams, allNotes),
    [projects, allDiagrams, allNotes],
  );
  const {
    isOpen: searchOpen,
    query: searchQuery,
    matches: searchMatches,
    open: openSearch,
    close: closeSearch,
    setQuery: setSearchQuery,
  } = useProjectSearch(buildDocuments);
  // A fresh token per request, so revealing the same range twice still fires.
  const revealToken = useRef(0);

  /**
   * Open the document a search hit belongs to and select the hit itself.
   *
   * The range is handed to whichever editor is about to render; the document load
   * and the reveal land in the same update, so the caret is already on the match
   * when the editor appears.
   */
  const openSearchMatch = useCallback(
    (match: SearchMatch) => {
      closeSearch();
      setPage("workspace");
      setView("code");
      if (match.kind === "note") {
        const note = allNotes.find((entry) => entry.id === match.id);
        if (note) loadNote(note);
      } else {
        const diagram = allDiagrams.find((entry) => entry.id === match.id);
        if (diagram) loadDiagram(diagram);
      }
      revealToken.current += 1;
      setReveal({
        start: match.offset,
        end: match.offset + match.length,
        text: match.text,
        line: match.line,
        token: revealToken.current,
      });
    },
    [closeSearch, allNotes, allDiagrams, loadNote, loadDiagram],
  );

  // The stable id of the document on screen, which is what the index keys on.
  const activeResourceId = selectedDiagram
    ? resourceIdForFile(selectedDiagram)
    : selectedNote
      ? resourceIdForFile(selectedNote)
      : null;
  const canReviewProposals =
    workspaceMode === "server" &&
    activeResourceId !== null &&
    selectedProjectId !== null;
  const canReviewProjectProposals =
    workspaceMode === "server" && selectedProjectId !== null;
  const openProposalCount = useProjectProposalCount(
    apiClient,
    canReviewProjectProposals ? selectedProjectId : null,
    proposalRefreshKey,
  );
  const openProposalCounts = useProjectResourceProposalCounts(
    apiClient,
    canReviewProjectProposals ? selectedProjectId : null,
    proposalRefreshKey,
  );
  const resourceProposalCount = useResourceProposalCount(
    apiClient,
    canReviewProposals ? selectedProjectId : null,
    canReviewProposals ? activeResourceId : null,
    proposalRefreshKey,
  );

  // Which language the active document is written in. A project holds three, and
  // the extension is what says so — the same rule a folder project uses.
  const activeRepresentation = selectedDiagram
    ? resourceRepresentationOfName(selectedDiagram.name)
    : selectedNote
      ? "markdown"
      : "sequence";
  const isEventFlow = activeRepresentation === "event-flow";

  // An event flow is parsed once per edit and its diagnostics and AST are derived
  // from that single analysis, so the two can never disagree.
  const eventFlowAnalysis = useMemo(
    () => (isEventFlow ? analyzeEventFlow(source) : null),
    [isEventFlow, source],
  );
  const eventFlow = eventFlowAnalysis?.flow ?? null;
  const canExportActiveDiagram =
    !noteMode && (isEventFlow ? eventFlow !== null : ast !== null && isValid(ast));

  // Causal is the investigation default only when entering a new causal flow;
  // a later view click remains the user's choice while that document is open.
  const autoCausalDocument = useRef<string | null>(null);
  useEffect(() => {
    if (!isEventFlow || selectedDiagram?.id === undefined) return;
    if (autoCausalDocument.current !== selectedDiagram.id) {
      autoCausalDocument.current = selectedDiagram.id;
      eventFlowViewTouched.current = false;
      setEventFlowView(eventFlow?.causal ? "causal" : "flow");
      return;
    }
    if (eventFlow?.causal && !eventFlowViewTouched.current) setEventFlowView("causal");
  }, [eventFlow?.causal, isEventFlow, selectedDiagram?.id]);

  const changeEventFlowView = useCallback((next: EventFlowView) => {
    eventFlowViewTouched.current = true;
    setEventFlowView(next);
  }, []);

  // The circled step numbers the canvas prints, keyed by source line, so the
  // editor gutter can show the same number beside the message that wrote it.
  // The preview draws nothing for a semantically invalid or absent diagram, so
  // the gutter claims no numbers either; an event flow numbers nothing this way.
  const lineBadges = useMemo(
    () =>
      isEventFlow || ast === null || !isValid(ast)
        ? new Map<number, number>()
        : messageStepNumbers(ast),
    [isEventFlow, ast],
  );

  // Every name the editor can bold and rename live, from whichever language is
  // open: participants in a sequence diagram, events/brokers/channels/services
  // in an event flow. The editor never sees the AST; it receives these spans.
  const mentions = useMemo<SourceMention[]>(() => {
    if (noteMode) return [];
    if (isEventFlow) {
      return eventFlow ? collectEventFlowMentions(eventFlow, source) : [];
    }
    return ast ? collectParticipantMentions(ast, source) : [];
  }, [noteMode, isEventFlow, eventFlow, ast, source]);

  const editorDiagnostics = useMemo(() => {
    if (!isEventFlow) {
      return diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        code: String(diagnostic.code),
        range: diagnostic.range,
      }));
    }
    return (eventFlowAnalysis?.diagnostics ?? []).map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
      code: String(diagnostic.code),
      range: diagnostic.range,
    }));
  }, [isEventFlow, diagnostics, eventFlowAnalysis]);

  /**
   * The active document's own problems. A markdown note has no DSL to diagnose,
   * and an event flow must be diagnosed by its own parser — counting the
   * sequence analysis of event-flow text is what made the status bar report
   * problems the editor and the Problems panel did not have.
   */
  const activeDiagnostics = useMemo(
    () => (noteMode ? [] : editorDiagnostics),
    [noteMode, editorDiagnostics],
  );
  const errorCount = activeDiagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;

  // The outline of the active document: a statement tree for a sequence diagram,
  // a declaration-and-flow tree for an event flow, headings for a document.
  const outlineNodes = useMemo<OutlineNode[]>(() => {
    if (noteMode) return markdownOutline(source);
    if (isEventFlow) return eventFlowOutline(eventFlow);
    return sequenceOutline(ast);
  }, [noteMode, isEventFlow, eventFlow, source, ast]);

  // Semantic completion and hover, both answered from the index. Handing these
  // to the editor as functions keeps the editor free of project knowledge.
  const complete = useCallback(
    (request: { source: string; offset: number }) => {
      if (!isEventFlow) {
        return completeAt({
          source: request.source,
          offset: request.offset,
          ast,
          symbols: index?.participants ?? [],
          resources: index?.resources ?? [],
        });
      }
      // Event-flow completion draws on this document's declarations *and* the
      // rest of the project, because naming an event another flow declares is
      // the normal case.
      const projectNames = {
        events: (index?.participants ?? [])
          .filter((symbol) => symbol.kind === "event")
          .map((symbol) => symbol.name),
        services: (index?.participants ?? [])
          .filter((symbol) => symbol.kind === "service")
          .map((symbol) => symbol.name),
        channels: (index?.participants ?? [])
          .filter((symbol) => symbol.kind === "channel")
          .map((symbol) => symbol.name),
        brokers: (index?.participants ?? [])
          .filter((symbol) => symbol.kind === "broker")
          .map((symbol) => symbol.name),
      };
      return completeEventFlowAt({
        source: request.source,
        offset: request.offset,
        flow: eventFlow,
        projectNames,
      });
    },
    [isEventFlow, eventFlow, ast, index],
  );

  const describe = useCallback(
    (offset: number): HoverInfo | null => {
      if (isEventFlow) {
        if (!eventFlow) return null;
        const node = eventFlowNodeAtPosition(
          eventFlow,
          offsetToPosition(source, offset),
        );
        if (!node) return null;
        const declared = node.range.start.line + 1;
        return {
          title: node.label,
          rows: [
            { label: "Kind", value: node.kind },
            {
              label: "Declared",
              value: `${activeRepresentation === "event-flow" ? "this flow" : ""}:${declared}`,
            },
          ],
        };
      }
      return hoverAt({
        source,
        offset,
        ast,
        index,
        resourceId: activeResourceId,
      });
    },
    [
      isEventFlow,
      eventFlow,
      source,
      ast,
      index,
      activeResourceId,
      activeRepresentation,
    ],
  );

  // Editor → preview: the caret's statement is highlighted on the canvas.
  const onCaretChange = useCallback(
    (offset: number) => {
      setCaretOffset(offset);
      if (noteMode) {
        setActiveNodeId(null);
        return;
      }
      if (isEventFlow) {
        setActiveNodeId(
          eventFlow
            ? (eventFlowNodeAtPosition(
                eventFlow,
                offsetToPosition(source, offset),
              )?.id ?? null)
            : null,
        );
        return;
      }
      setActiveNodeId(ast ? nodeIdAtOffset(source, ast, offset) : null);
    },
    [noteMode, isEventFlow, eventFlow, source, ast],
  );

  // Preview → editor: clicking a rendered element selects its source range. The
  // mapping is by node id, never by matching text.
  const onNodeSelect = useCallback(
    (nodeId: string) => {
      const range = isEventFlow
        ? eventFlow
          ? eventFlowNodeById(eventFlow, nodeId)?.range
          : undefined
        : ast
          ? nodeRangeById(ast, nodeId)
          : null;
      if (!range) return;
      const offsets = rangeToOffsets(source, range);
      revealToken.current += 1;
      setReveal({
        start: offsets.start,
        end: offsets.end,
        text: source.slice(offsets.start, offsets.end),
        line: range.start.line + 1,
        token: revealToken.current,
      });
      // Selecting the range programmatically does not fire the editor's caret
      // handler, so the highlight is set here too — the caret really is on this
      // node now, and the canvas should say so.
      setActiveNodeId(nodeId);
    },
    [isEventFlow, eventFlow, ast, source],
  );

  /** The participant name the caret is on, for find-references and rename. */
  const symbolAtCaret = useCallback((): string | null => {
    if (!index || !activeResourceId) return null;
    const position = offsetToPosition(source, caretOffset);
    const contains = (range?: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    }): boolean => {
      if (!range) return false;
      if (position.line < range.start.line || position.line > range.end.line) {
        return false;
      }
      if (
        position.line === range.start.line &&
        position.column < range.start.column
      ) {
        return false;
      }
      if (
        position.line === range.end.line &&
        position.column > range.end.column
      ) {
        return false;
      }
      return true;
    };
    const usage = index.usages.find(
      (entry) => entry.resourceId === activeResourceId && contains(entry.range),
    );
    if (usage) return usage.name;
    const symbol = index.participants.find(
      (entry) =>
        entry.resourceId === activeResourceId && contains(entry.sourceRange),
    );
    return symbol?.name ?? null;
  }, [index, activeResourceId, source, caretOffset]);

  /** The project's problems, as the index already computed them. */
  const projectDiagnostics = index?.diagnostics ?? [];

  /**
   * A problem's human-readable home: the project and the document it lives in.
   *
   * A project can hold two files with the same name, so a bare path is not
   * enough to say which diagram a problem belongs to.
   */
  const resourceLabel = useCallback(
    (resourceId: string): string => {
      const resource = index?.resources.find(
        (entry) => entry.id === resourceId,
      );
      if (!resource) return resourceId;
      const project = projects.find((entry) => entry.id === resource.projectId);
      const name = resource.title || resource.path;
      return project ? `${project.name} › ${name}` : name;
    },
    [index, projects],
  );

  /**
   * Open the document a problem or reference points at, and reveal it.
   *
   * The resource's own project picks the file: matching by name alone would open
   * the wrong document as soon as two projects hold a file with the same name.
   */
  const openProjectLocation = useCallback(
    (resourceId: string, position?: { line: number; column: number }) => {
      const resource = index?.resources.find(
        (entry) => entry.id === resourceId,
      );
      if (!resource) return;
      const inProject = (entry: { projectId: string; name: string }): boolean =>
        entry.projectId === resource.projectId && entry.name === resource.path;
      const note =
        resource.type === "markdown-document"
          ? allNotes.find(inProject)
          : undefined;
      const diagram = note ? undefined : allDiagrams.find(inProject);
      if (note) loadNote(note);
      if (diagram) loadDiagram(diagram);
      if (!position) return;
      // The target document's own text is needed to turn a line/column into the
      // offset the editor selects; take it from whichever list holds the file.
      const content = diagram?.source ?? note?.markdown ?? "";
      const offsets = rangeToOffsets(content, {
        start: position,
        end: position,
      });
      revealToken.current += 1;
      setReveal({
        start: offsets.start,
        end: offsets.end,
        text: "",
        line: position.line + 1,
        token: revealToken.current,
      });
    },
    [index, allDiagrams, allNotes, loadDiagram, loadNote],
  );

  /** Quick open: resources, participant symbols and document headings. */
  const quickOpenItems = useMemo<QuickOpenItem[]>(() => {
    if (!index) return [];
    const items: QuickOpenItem[] = [];
    for (const resource of index.resources) {
      items.push({
        id: resource.id,
        label: resource.title,
        detail: resource.path,
        group:
          resource.type === "sequence-diagram"
            ? "Diagrams"
            : resource.type === "event-flow"
              ? "Event flows"
              : "Documents",
        search: `${resource.title} ${resource.path}`,
      });
    }
    for (const symbol of index.participants) {
      // A resource is already in the list above; only symbols declared inside
      // one belong under "Symbols".
      if (isResourceSymbolKind(symbol.kind)) continue;
      const owner = index.resources.find(
        (entry) => entry.id === symbol.resourceId,
      );
      items.push({
        id: `${symbol.resourceId}#${symbol.id}`,
        label: symbol.name,
        detail: `${SYMBOL_KIND_LABELS[symbol.kind]} · ${owner?.path ?? ""}`,
        group: "Symbols",
        search: `${symbol.name} ${owner?.path ?? ""}`,
      });
    }
    for (const document of index.documents) {
      for (const heading of document.headings) {
        items.push({
          id: `${document.id}#line-${heading.line}`,
          label: heading.text,
          detail: `${document.path}:${heading.line}`,
          group: "Headings",
          search: `${heading.text} ${document.path}`,
        });
      }
    }
    return items;
  }, [index]);

  /** Open whatever quick open pointed at. */
  const openQuickOpenItem = useCallback(
    (item: QuickOpenItem) => {
      setQuickOpenOpen(false);
      setPage("workspace");
      setView("code");
      const [resourceId, fragment] = item.id.split("#");
      const resource = index?.resources.find(
        (entry) => entry.id === resourceId,
      );
      if (!resource) return;
      const diagram = allDiagrams.find((entry) => entry.name === resource.path);
      const note = allNotes.find((entry) => entry.name === resource.path);
      const content = diagram?.source ?? note?.markdown ?? "";
      if (diagram) loadDiagram(diagram);
      if (note) loadNote(note);
      if (!fragment) return;

      const heading = /^line-(\d+)$/.exec(fragment);
      const symbol = index?.participants.find((entry) => entry.id === fragment);
      const position = heading
        ? { line: Number(heading[1]) - 1, column: 0 }
        : symbol?.sourceRange?.start;
      if (!position) return;
      const offsets = rangeToOffsets(content, {
        start: position,
        end: position,
      });
      revealToken.current += 1;
      setReveal({
        start: offsets.start,
        end: offsets.end,
        text: "",
        line: position.line + 1,
        token: revealToken.current,
      });
    },
    [index, allDiagrams, allNotes, loadDiagram, loadNote],
  );

  /** Find every use of the symbol under the caret. */
  const findReferences = useCallback(() => {
    if (!index) return;
    const name = symbolAtCaret();
    if (!name) return;
    const result = findSymbolReferences(index, name);
    const matches: SearchMatch[] = result.sites.map((site) => {
      const resource = index.resources.find(
        (entry) => entry.id === site.resourceId,
      );
      const content =
        allDiagrams.find((entry) => entry.name === resource?.path)?.source ??
        allNotes.find((entry) => entry.name === resource?.path)?.markdown ??
        "";
      const offsets = rangeToOffsets(content, {
        start: { line: site.line - 1, column: site.column - 1 },
        end: { line: site.line - 1, column: site.column - 1 + name.length },
      });
      return {
        kind: resource?.type === "sequence-diagram" ? "diagram" : "note",
        id: site.resourceId,
        projectId: resource?.projectId ?? "",
        projectName:
          projects.find((p) => p.id === resource?.projectId)?.name ?? "",
        name: site.resourcePath,
        title: site.resourceTitle,
        line: site.line,
        column: site.column,
        offset: offsets.start,
        length: name.length,
        text: name,
        excerpt: `${site.role} · ${site.context}`,
        matchedFields: ["content"],
      };
    });
    setReferenceTitle(`References to ${name}`);
    setReferenceMatches(matches);
  }, [index, symbolAtCaret, allDiagrams, allNotes, projects]);

  /** Rename the symbol under the caret across the project. */
  const applySymbolRename = useCallback(
    async (from: string, to: string): Promise<void> => {
      setPrompt(null);
      if (!index || !selectedProjectId || from === to) return;
      const contents = new Map<string, string>();
      for (const diagram of allDiagrams) {
        const id = resourceIdForFile(diagram);
        if (id) contents.set(id, diagram.source);
      }
      const plan = planSymbolRename(index, contents, from, to);
      for (const edit of plan.edits) {
        const file = allDiagrams.find((entry) => entry.name === edit.path);
        if (!file) continue;
        const saved = await activeRepo.saveDiagramFile(selectedProjectId, {
          ...file,
          source: edit.content,
        });
        if (!isOk(saved)) {
          setTransferError(saved.error.message);
          continue;
        }
        applyDiagramEdit(saved.value);
        tabsHook.applyExternalDiagram(saved.value);
      }
      setTransferError(null);
    },
    [
      index,
      selectedProjectId,
      allDiagrams,
      resourceIdForFile,
      activeRepo,
      applyDiagramEdit,
      tabsHook,
    ],
  );

  /** Render an embedded diagram in a markdown document, from current source. */
  const renderEmbed = useCallback(
    (kind: string, target: string): string | null => {
      if (embedResourceType(kind) !== "sequence-diagram") return null;
      const resource = index?.resources.find(
        (entry) =>
          entry.id === target ||
          entry.path === target ||
          entry.title.toLowerCase() === target.toLowerCase(),
      );
      if (!resource || resource.type !== "sequence-diagram") return null;
      const file = allDiagrams.find((entry) => entry.name === resource.path);
      if (!file) return null;
      const { ast: embedded } = analyze(file.source);
      return renderDiagramDocument(embedded).svg;
    },
    [index, allDiagrams],
  );

  // Rendered once for the export dialog's preview and its size, rather than
  // three times in the markup.
  const exportPreview = useMemo(
    () =>
      isEventFlow
        ? renderEventFlowDocument(eventFlow)
        : renderDiagramDocument(ast),
    [ast, eventFlow, isEventFlow],
  );

  /** The file name stem for an export: the active document's own name. */
  const activeDocumentName = noteMode
    ? (selectedNote?.name ?? "document")
    : (selectedDiagram?.name ?? "diagram");

  /**
   * Produce the chosen artefact from the canonical SVG.
   *
   * Every format starts from the same render, so PNG and PDF cannot disagree
   * with the SVG about what the diagram looks like — and a failure to rasterize
   * is reported in the status bar rather than swallowed.
   */
  const runDiagramExport = useCallback(
    async (options: DiagramExportOptions): Promise<void> => {
      setExportDiagramOpen(false);
      // One export path for both languages: an event flow renders through its own
      // pipeline, and PNG/PDF derive from whatever SVG that produced.
      const rendered = isEventFlow
        ? renderEventFlowDocument(eventFlow, {
            theme: options.theme,
            background: options.background,
            includeTitle: options.includeTitle,
            padding: options.padding,
          })
        : exportDiagramSvg(ast, options);
      const filename = exportFileName({
        ...options,
        title: options.title ?? activeDocumentName,
      });
      try {
        const bytes =
          options.format === "svg"
            ? new TextEncoder().encode(rendered.svg)
            : options.format === "png"
              ? await svgToPng(
                  rendered.svg,
                  rendered.width,
                  rendered.height,
                  normalizeScale(options.scale),
                )
              : await svgToPdf(
                  rendered.svg,
                  rendered.width,
                  rendered.height,
                  normalizeScale(options.scale),
                );
        downloadBytes(bytes, filename, exportMimeType(options.format));
        setTransferError(null);
      } catch (error) {
        setTransferError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [isEventFlow, eventFlow, ast, activeDocumentName],
  );

  /** Write the project's documentation as a self-contained site, zipped. */
  const runSiteExport = useCallback((): void => {
    if (!index || !selectedProjectId) {
      setTransferError("Open a project before exporting its documentation.");
      return;
    }
    const project = projects.find((entry) => entry.id === selectedProjectId);
    const contents = new Map<string, string>();
    for (const diagram of diagrams) {
      const id = resourceIdForFile(diagram);
      if (id) contents.set(id, diagram.source);
    }
    for (const note of notes) {
      const id = resourceIdForFile(note);
      if (id) contents.set(id, note.markdown);
    }
    const result = exportDocumentationSite(
      {
        projectName: project?.name ?? selectedProjectId,
        index,
        contents,
        renderDiagram: (resourceId) => {
          const resource = index.resources.find(
            (entry) => entry.id === resourceId,
          );
          const file = diagrams.find((entry) => entry.name === resource?.path);
          if (!file) return null;
          const { ast: embedded } = analyze(file.source);
          return renderDiagramDocument(embedded).svg;
        },
      },
      { includeProblems: true },
    );
    const bytes = createZip(
      result.files.map((file) => ({ path: file.path, data: file.data })),
    );
    downloadBytes(
      bytes,
      `${archiveSlug(project?.name ?? "project")}-docs.zip`,
      "application/zip",
    );
    setTransferError(null);
  }, [index, selectedProjectId, projects, diagrams, notes, resourceIdForFile]);

  // Command palette: open state/shortcut, and the registry built from current
  // workspace + tab state. `runCommand` runs the selected command through the
  // registry (single choke point) and dismisses the palette.
  const { isOpen, open, close } = useCommandPalette();
  /**
   * Return to the workspace and show one of the editor pane's panels.
   *
   * Every command that reveals a panel goes through here, so running "Toggle
   * Outline" from a chord while the documentation page is open cannot act on a
   * pane the user cannot see.
   */
  const showView = useCallback((next: EditorView): void => {
    setPage("workspace");
    setView(next);
  }, []);

  /** Open the documentation page. */
  const openDocs = useCallback((): void => setPage("docs"), []);

  /** Open the agents/access-token page (only meaningful while signed in). */
  const openTokens = useCallback((): void => setPage("tokens"), []);

  /** Open workspace and account settings. */
  const openSettings = useCallback((): void => setPage("settings"), []);

  const registry = useCommands({
    createEmptyDiagram: workspace.createEmptyDiagram,
    createEmptyNote: createNote,
    selectedProjectId,
    openDiagram: tabsHook.openDiagram,
    createEventFlow,
    closeActiveTab: closeActiveDocument,
    openSearch,
    openQuickOpen: () => setQuickOpenOpen(true),
    showView,
    openDocs,
    findReferences,
    renameSymbol: () => {
      const name = symbolAtCaret();
      if (name) setPrompt({ kind: "rename-symbol", name });
    },
    exportDiagram: () => setExportDiagramOpen(true),
    exportSite: runSiteExport,
    exportProject: exportProjectCommand,
    importProject: beginImportProject,
    openFolder,
    folderOpen: openedFolder !== null,
    folderSupported: supportsFileSystemAccess(),
  });

  /**
   * The registry the palette and the shortcut listener actually run.
   *
   * Running any command except opening the documentation first returns to the
   * workspace, so a chord pressed over the docs page acts on something the user
   * can see. `open-docs` sets the page itself; both updates batch, so the last
   * one wins.
   */
  const runnableRegistry = useMemo<CommandRegistry>(
    () => ({
      commands: registry.commands,
      filter: (query) => registry.filter(query),
      run: (id) => {
        if (id !== "open-docs") setPage("workspace");
        return registry.run(id);
      },
    }),
    [registry],
  );

  // Every command's shortcut is honoured from one listener. While a modal owns
  // the screen (the palette, quick open, project search, a prompt/confirm, or the
  // export dialog) the listener stands down, so a chord cannot act on the
  // document behind it.
  useShortcuts(
    runnableRegistry,
    !isOpen &&
      !quickOpenOpen &&
      !searchOpen &&
      !prompt &&
      !pendingDelete &&
      !exportDiagramOpen,
  );

  const runCommand = useCallback(
    (command: Command) => {
      runnableRegistry.run(command.id);
      close();
    },
    [runnableRegistry, close],
  );

  // Deletes never fire straight from a click: the request opens a confirmation
  // dialog and only a scope choice there performs the removal.
  const requestDeleteDiagram = useCallback((diagram: DiagramFile) => {
    setPendingDelete({
      kind: "diagram",
      id: diagram.id,
      projectId: diagram.projectId,
      name: diagramDisplayName(diagram.name, diagram.source),
    });
  }, []);

  const requestDeleteNote = useCallback((note: NoteFile) => {
    setPendingDelete({
      kind: "note",
      id: note.id,
      projectId: note.projectId,
      name: noteDisplayName(note.name, note.markdown),
    });
  }, []);

  const requestDeleteProject = useCallback(
    (id: string) => {
      const project = projects.find((candidate) => candidate.id === id);
      setPendingDelete({ kind: "project", id, name: project?.name ?? id });
    },
    [projects],
  );

  /** Carry out the confirmed delete at the chosen scope. */
  const confirmDelete = useCallback(
    async (scope: DeleteScope): Promise<void> => {
      const target = pendingDelete;
      if (!target) return;
      if (target.kind === "diagram") {
        await workspace.deleteDiagram(target.projectId, target.id, scope);
        closeTabAndFollow(target.id);
        if (scope === "disk") await history.clearDiagram(target.id);
      } else if (target.kind === "note") {
        await workspace.deleteNote(target.projectId, target.id, scope);
        closeTabAndFollow(target.id);
      } else {
        // Close every tab backed by the project before its files disappear.
        for (const tab of tabs) {
          if (tab.projectId === target.id) closeTab(tab.id);
        }
        await workspace.deleteProject(target.id, scope);
        if (scope === "disk") await history.clearProject(target.id);
      }
      setPendingDelete(null);
    },
    [pendingDelete, workspace, tabs, closeTab, closeTabAndFollow, history],
  );

  /** Apply a rename or title edit submitted in the prompt dialog. */
  const confirmPrompt = useCallback(
    async (value: string): Promise<void> => {
      const target = prompt;
      setPrompt(null);
      if (!target) return;

      if (target.kind === "rename-symbol") {
        await applySymbolRename(target.name, value);
        return;
      }

      if (target.kind === "rename-project") {
        const previousId = target.project.id;
        // A folder rename moves the project directory, so every file path — and
        // therefore every tab and version timeline key — changes with it. Capture
        // the files before the workspace re-prefixes them.
        const movedDiagrams = allDiagrams.filter(
          (diagram) => diagram.projectId === previousId,
        );
        const renamed = await workspace.renameProject(previousId, value);
        if (!renamed) return;
        if (renamed.id !== previousId) {
          for (const tab of tabs) {
            if (tab.projectId === previousId) closeTab(tab.id);
          }
          for (const diagram of movedDiagrams) {
            await history.renameDiagram(
              diagram.id,
              `${renamed.id}/${diagram.name}`,
            );
          }
        }
        return;
      }

      if (target.kind === "rename-diagram") {
        const previousId = target.diagram.id;
        const renamed = await workspace.renameDiagram(
          target.diagram.projectId,
          previousId,
          value,
        );
        if (!renamed) return;
        if (renamed.id !== previousId) {
          // A local-folder rename changes the file's path (its id): move the
          // open tab and the version timeline to the new id.
          closeTab(previousId);
          await history.renameDiagram(previousId, renamed.id);
          loadDiagram(renamed);
        } else {
          tabsHook.applyExternalDiagram(renamed);
        }
        return;
      }

      if (target.kind === "rename-note") {
        const previousId = target.note.id;
        const renamed = await workspace.renameNote(
          target.note.projectId,
          previousId,
          value,
        );
        if (!renamed) return;
        if (renamed.id !== previousId) {
          // A local-folder rename changes the file's path (its id), so move the
          // open tab to the renamed document rather than leaving a stale tab.
          closeTab(previousId);
          loadNote(renamed);
        } else {
          tabsHook.applyExternalNote(renamed);
        }
        return;
      }

      if (target.kind === "title-diagram") {
        const updated = await workspace.setDiagramTitle(target.diagram, value);
        if (updated) tabsHook.applyExternalDiagram(updated);
        return;
      }

      const updatedNote = await workspace.setNoteTitle(target.note, value);
      if (updatedNote) tabsHook.applyExternalNote(updatedNote);
    },
    [
      prompt,
      workspace,
      closeTab,
      history,
      loadDiagram,
      loadNote,
      tabsHook,
      applySymbolRename,
      tabs,
      allDiagrams,
    ],
  );

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    if (menu.kind === "project") {
      const { project } = menu;
      return [
        ...(workspaceMode === "local" && auth.status === "authenticated"
          ? [
              {
                id: "publish-project",
                label: "Publish to server",
                onSelect: () => {
                  void publishProjectToServer(project);
                },
              },
            ]
          : []),
        {
          id: "download-project",
          label: "Download local copy (.zip)",
          onSelect: () => {
            void exportProject(project);
          },
        },
        {
          id: "copy-project-id",
          label: "Copy project ID",
          onSelect: () => {
            void navigator.clipboard
              ?.writeText(project.id)
              .catch(() => undefined);
          },
        },
        {
          id: "rename-project",
          label: "Rename project…",
          onSelect: () => setPrompt({ kind: "rename-project", project }),
        },
        {
          id: "delete-project",
          label: "Delete project",
          danger: true,
          onSelect: () => requestDeleteProject(project.id),
        },
      ];
    }
    if (menu.kind === "project-add") {
      const { project } = menu;
      return [
        {
          id: "new-diagram",
          label: "New diagram",
          onSelect: () => {
            void createDiagram(project.id);
          },
        },
        {
          id: "new-note",
          label: "New note",
          onSelect: () => {
            void createNote(project.id);
          },
        },
        {
          id: "new-event-flow",
          label: "New event flow",
          onSelect: () => {
            void createEventFlow(project.id);
          },
        },
      ];
    }
    if (menu.kind === "diagram") {
      const { diagram } = menu;
      return [
        {
          id: "rename",
          label: "Rename…",
          onSelect: () => setPrompt({ kind: "rename-diagram", diagram }),
        },
        {
          id: "title",
          label: "Change title…",
          onSelect: () => setPrompt({ kind: "title-diagram", diagram }),
        },
        {
          id: "duplicate",
          label: "Duplicate",
          onSelect: () => {
            void duplicateDiagram(diagram);
          },
        },
        {
          id: "delete",
          label: "Delete",
          danger: true,
          onSelect: () => requestDeleteDiagram(diagram),
        },
      ];
    }
    const { note } = menu;
    return [
      {
        id: "rename",
        label: "Rename…",
        onSelect: () => setPrompt({ kind: "rename-note", note }),
      },
      {
        id: "title",
        label: "Change title…",
        onSelect: () => setPrompt({ kind: "title-note", note }),
      },
      {
        id: "duplicate",
        label: "Duplicate",
        onSelect: () => {
          void duplicateNote(note);
        },
      },
      {
        id: "delete",
        label: "Delete",
        danger: true,
        onSelect: () => requestDeleteNote(note),
      },
    ];
  }, [
    menu,
    workspaceMode,
    auth.status,
    publishProjectToServer,
    requestDeleteDiagram,
    requestDeleteNote,
    createDiagram,
    createNote,
    createEventFlow,
    duplicateDiagram,
    duplicateNote,
    requestDeleteProject,
  ]);

  /**
   * Load a version back into the editor and record the restore itself.
   *
   * A version may belong to a different diagram in the project, so the document
   * is opened first and the source applied once its tab is active — the buffer,
   * the tab and the saved file then all agree on the restored content.
   */
  const restoreVersion = useCallback(
    (version: DiagramVersion): void => {
      if (selectedDiagram?.id !== version.diagramId) {
        const target = allDiagrams.find(
          (diagram) => diagram.id === version.diagramId,
        );
        if (!target) return;
        setPendingRestore({
          diagramId: version.diagramId,
          source: version.source,
        });
        loadDiagram(target);
        return;
      }
      updateActiveSource(version.source);
      void history.saveVersion(version.source, RESTORED_VERSION_LABEL);
    },
    [selectedDiagram, allDiagrams, loadDiagram, updateActiveSource, history],
  );

  // Apply a restore that had to switch documents first.
  useEffect(() => {
    if (!pendingRestore) return;
    if (selectedDiagram?.id !== pendingRestore.diagramId) return;
    const restored = pendingRestore.source;
    setPendingRestore(null);
    updateActiveSource(restored);
    void history.saveVersion(restored, RESTORED_VERSION_LABEL);
  }, [pendingRestore, selectedDiagram, updateActiveSource, history]);

  /** The name and kind a history branch header shows for its diagram. */
  const diagramLabel = useCallback(
    (diagramId: string): string => {
      const resource = index?.resources.find((entry) => entry.id === diagramId);
      if (resource) return resource.title || resource.path;
      const file = allDiagrams.find((entry) => entry.id === diagramId);
      return file ? diagramDisplayName(file.name, file.source) : diagramId;
    },
    [index, allDiagrams],
  );

  const diagramKind = useCallback(
    (diagramId: string): string => {
      const resource = index?.resources.find((entry) => entry.id === diagramId);
      if (resource) return resource.type;
      const file = allDiagrams.find((entry) => entry.id === diagramId);
      return resourceTypeOfName(file?.name ?? "");
    },
    [index, allDiagrams],
  );

  const unhideAll = useCallback((): void => {
    for (const path of hiddenPaths) unhidePath(path);
  }, [hiddenPaths, unhidePath]);

  const folderOpen = openedFolder !== null;

  const hasAppAccess =
    auth.status === "authenticated" &&
    (auth.user?.platformAdmin === true ||
      auth.user?.accountStatus === undefined ||
      auth.user?.accountStatus === "ACTIVE");

  if (!hasAppAccess) return <LoginScreen auth={auth} />;

  return (
    <div className="app" data-testid="app-shell">
      <header className="app__toolbar">
        <span className="app__brand">
          <span className="app__brand-mark" aria-hidden="true">
            {"</>"}
          </span>
          {PRODUCT_NAME}
        </span>

        {page === "workspace" ? (
          <>
            <div
              className="segmented"
              role="tablist"
              aria-label="Editor view"
              data-testid="editor-view-toggle"
            >
              <button
                type="button"
                role="tab"
                className={`segmented__option${view === "code" ? " segmented__option--active" : ""}`}
                data-testid="view-code"
                aria-selected={view === "code"}
                onClick={() => setView("code")}
              >
                <span aria-hidden="true">{"</>"}</span> Code
              </button>
              <button
                type="button"
                role="tab"
                className={`segmented__option${view === "outline" ? " segmented__option--active" : ""}`}
                data-testid="view-outline"
                aria-selected={view === "outline"}
                onClick={() => setView("outline")}
              >
                <span aria-hidden="true">≡</span> Outline
              </button>
              <button
                type="button"
                role="tab"
                className={`segmented__option${view === "problems" ? " segmented__option--active" : ""}`}
                data-testid="view-problems"
                aria-selected={view === "problems"}
                onClick={() => setView("problems")}
              >
                <span aria-hidden="true">⚠</span> Problems
                {projectDiagnostics.length > 0
                  ? ` (${projectDiagnostics.length})`
                  : ""}
              </button>
              <button
                type="button"
                role="tab"
                className={`segmented__option${view === "overview" ? " segmented__option--active" : ""}`}
                data-testid="view-overview"
                aria-selected={view === "overview"}
                onClick={() => setView("overview")}
              >
                <span aria-hidden="true">◫</span> Overview
              </button>
              <button
                type="button"
                role="tab"
                className={`segmented__option${view === "history" ? " segmented__option--active" : ""}`}
                data-testid="view-history"
                aria-selected={view === "history"}
                onClick={() => {
                  setHistoryResourceScoped(false);
                  setView("history");
                }}
              >
                <span aria-hidden="true">⟲</span> History
              </button>
              {canReviewProjectProposals && (
                <button
                  type="button"
                  role="tab"
                  className={`segmented__option${view === "changes" ? " segmented__option--active" : ""}`}
                  data-testid="view-changes"
                  aria-selected={view === "changes"}
                  onClick={() => {
                    setView("changes");
                    setProposalReviewOpen(false);
                  }}
                >
                  <span aria-hidden="true">⇢</span> Changes
                  {openProposalCount > 0 ? ` (${openProposalCount})` : ""}
                </button>
              )}
            </div>

            <button
              type="button"
              className="button app__docs-button"
              data-testid="open-docs"
              title="Open the documentation page"
              onClick={openDocs}
            >
              <span aria-hidden="true">▤</span> Docs
            </button>

            {auth.status === "authenticated" ? (
              <button
                type="button"
                className="button app__tokens-button"
                data-testid="open-agents"
                title="Manage agents and their access tokens for remote MCP clients"
                onClick={openTokens}
              >
                <span aria-hidden="true">⚿</span> Agents
              </button>
            ) : null}

            <label className="switch" title="Re-render the diagram as you type">
              <input
                type="checkbox"
                className="switch__input"
                data-testid="auto-update-toggle"
                checked={autoUpdate}
                onChange={(event) => setAutoUpdate(event.target.checked)}
              />
              <span
                className="switch__track"
                data-testid="auto-update-switch"
                aria-hidden="true"
              >
                <span className="switch__thumb" />
              </span>
              <span className="switch__label">Auto-update</span>
            </label>
          </>
        ) : (
          <span className="app__page-title" data-testid="docs-page-title">
            {page === "tokens"
              ? "Agents & access tokens"
              : page === "settings"
                ? "Workspace settings"
                : "Documentation"}
          </span>
        )}

        <div className="app__toolbar-actions">
          {auth.status === "authenticated" ? (
            <div className="app__account" data-testid="toolbar-account">
              <span>
                {auth.user?.displayName || auth.user?.id || "Signed in"}
              </span>
              <button
                type="button"
                className="app__sign-out"
                data-testid="toolbar-sign-out"
                onClick={() => {
                  void auth.signOut();
                }}
              >
                Sign out
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="button app__command-button"
            data-testid="command-palette-button"
            aria-label="Open command palette"
            title={`Open command palette (${bindingLabel(COMMAND_PALETTE_BINDING)})`}
            onClick={open}
          >
            Commands…
            <kbd className="app__command-shortcut" data-testid="palette-hint">
              {bindingLabel(COMMAND_PALETTE_BINDING)}
            </kbd>
          </button>
          {page === "workspace" ? (
            <button
              type="button"
              className="icon-button app__settings-button"
              data-testid="workspace-settings"
              aria-label="Open workspace settings"
              title="Workspace settings"
              onClick={openSettings}
            >
              ⚙
            </button>
          ) : null}
        </div>
      </header>

      {page === "docs" ? (
        <DocsPage onBack={() => setPage("workspace")} />
      ) : page === "tokens" ? (
        <AgentsAndTokens
          client={apiClient}
          auth={auth}
          onBack={() => setPage("workspace")}
        />
      ) : page === "settings" ? (
        <PlatformAdministration
          auth={auth}
          adminUsers={adminUsers}
          onSetUserStatus={setAdminUserStatus}
          workspaces={serverWorkspaces}
          workspaceMembersByWorkspaceId={workspaceMembersByWorkspaceId}
          onSetWorkspaceMemberRole={setWorkspaceMemberRole}
          onRemoveWorkspaceMember={removeWorkspaceMember}
          onCreateWorkspace={createServerWorkspace}
          onRenameWorkspace={renameServerWorkspace}
          onDeleteWorkspace={deleteServerWorkspace}
          onBack={() => setPage("workspace")}
        />
      ) : (
        <>
          <main
            ref={workspaceRef}
            className={`app__workspace${previewMaximized ? " app__workspace--preview-maximized" : ""}`}
          >
            {explorerCollapsed ? (
              <button
                type="button"
                className="app__explorer-restore"
                aria-label="Expand project explorer"
                title="Expand project explorer"
                onClick={() => setExplorerCollapsed(false)}
              >
                ›
              </button>
            ) : (
              <section
                className="app__pane app__pane--explorer"
                aria-label="Project explorer"
                style={{ flexBasis: explorerWidth }}
              >
                <Explorer
                  projects={projects}
                  diagrams={diagrams}
                  notes={notes}
                  allDiagrams={allDiagrams}
                  allNotes={allNotes}
                  selectedProjectId={selectedProjectId}
                  selectedDiagramId={selectedDiagramId}
                  selectedNoteId={selectedNoteId}
                  openProposalCounts={openProposalCounts}
                  isLoading={isLoading}
                  onCreateProject={createProjectHere}
                  switcher={
                    <WorkspaceSwitcher
                      mode={workspaceMode}
                      folderName={openedFolder?.folderName ?? null}
                      folderSupported={supportsFileSystemAccess()}
                      serverProjects={server.projects}
                      serverWorkspaces={serverWorkspaces}
                      selectedServerWorkspaceId={selectedServerWorkspaceId}
                      serverProjectsLoading={server.projectsLoading}
                      serverProjectsError={server.projectsError}
                      activeServerProjectId={server.active?.project.id ?? null}
                      serverOpenError={server.openError}
                      onOpenLocal={openLocalWorkspace}
                      onOpenFolder={openFolder}
                      onOpenServerProject={(project) => {
                        void server.openProject(project);
                      }}
                      onCreateServerProject={(name) => {
                        void server.createProject(name);
                      }}
                      onSelectServerWorkspace={setSelectedServerWorkspaceId}
                      onReloadServerProjects={() => {
                        void syncServerWorkspace();
                      }}
                    />
                  }
                  onAddMenu={(project, position) =>
                    setMenu({ kind: "project-add", project, ...position })
                  }
                  onLoadDiagram={loadDiagram}
                  onLoadNote={loadNote}
                  onDiagramMenu={(diagram, position) =>
                    setMenu({ kind: "diagram", diagram, ...position })
                  }
                  onNoteMenu={(note, position) =>
                    setMenu({ kind: "note", note, ...position })
                  }
                  onProjectMenu={(project, position) =>
                    setMenu({ kind: "project", project, ...position })
                  }
                  hiddenCount={hiddenPaths.size}
                  onUnhideAll={unhideAll}
                  onOpenFolder={openFolder}
                  folderName={openedFolder?.folderName ?? null}
                  workspaceLabel={
                    server.active
                      ? `Server project: ${server.active.project.name}`
                      : openedFolder
                        ? `Local folder: ${openedFolder.folderName}`
                        : undefined
                  }
                  folderSupported={supportsFileSystemAccess()}
                />
                <button
                  type="button"
                  className="app__explorer-collapse"
                  aria-label="Collapse project explorer"
                  title="Collapse project explorer"
                  onClick={() => setExplorerCollapsed(true)}
                >
                  ‹
                </button>
              </section>
            )}

            {!explorerCollapsed ? (
              <div
                className="app__splitter"
                role="separator"
                tabIndex={0}
                aria-label="Resize project explorer"
                aria-orientation="vertical"
                onPointerDown={(event) => startResize("explorer", event)}
                onPointerMove={(event) => moveResize("explorer", event)}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onKeyDown={(event) => resizeWithKeyboard("explorer", event)}
              />
            ) : null}

            <section
              className="app__pane app__pane--editor"
              aria-label={
                noteMode
                  ? "Markdown note editor"
                  : isEventFlow
                    ? "Event flow editor"
                    : "DSL editor"
              }
              style={
                editorWidth === null ? undefined : { flexBasis: editorWidth }
              }
            >
              {proposalReviewOpen && canReviewProjectProposals ? (
                <ProposalReviewPanel
                  client={apiClient}
                  projectId={selectedProjectId}
                  // A project-level proposal selection is authoritative. Do not
                  // let the editor's last resource filter an inbox selection.
                  resourceId={
                    reviewProposalId
                      ? undefined
                      : canReviewProposals
                        ? activeResourceId
                        : undefined
                  }
                  initialProposalId={reviewProposalId}
                   onBack={() => {
                     setProposalReviewOpen(false);
                     setReviewProposalId(null);
                     setReviewReadOnly(false);
                   }}
                   canMerge={metadataWritable}
                   readOnly={reviewReadOnly}
                   onMerged={() => {
                     setProposalRefreshKey((key) => key + 1);
                     void syncServerWorkspace();
                   }}
                 />
              ) : view === "changes" && canReviewProjectProposals ? (
                <ChangesInbox
                  client={apiClient}
                  projectId={selectedProjectId}
                  onOpen={(proposalId) => {
                    setReviewProposalId(proposalId);
                    setReviewReadOnly(false);
                    setProposalReviewOpen(true);
                  }}
                />
              ) : view === "outline" ? (
                <OutlinePanel
                  nodes={outlineNodes}
                  activeLine={offsetToPosition(source, caretOffset).line + 1}
                  onNavigate={(node) => {
                    if (!node.range) return;
                    setView("code");
                    const offsets = rangeToOffsets(source, node.range);
                    revealToken.current += 1;
                    setReveal({
                      start: offsets.start,
                      end: offsets.end,
                      text: source.slice(offsets.start, offsets.end),
                      line: node.range.start.line + 1,
                      token: revealToken.current,
                    });
                  }}
                  emptyHint={
                    noteMode
                      ? "This document has no headings."
                      : "This diagram has nothing to outline."
                  }
                />
              ) : view === "problems" ? (
                <ProblemsPanel
                  diagnostics={projectDiagnostics}
                  labelFor={resourceLabel}
                  onOpen={(diagnostic) =>
                    openProjectLocation(
                      diagnostic.resourceId,
                      diagnostic.sourceRange?.start,
                    )
                  }
                />
              ) : view === "overview" ? (
                <ProjectOverview index={index} />
              ) : view === "history" ? (
                <HistoryPanel
                  trajectoryEntries={
                    workspaceMode === "server" ? serverTrajectory.entries : undefined
                  }
                  versions={
                    historyResourceScoped
                      ? history.versions
                      : history.projectVersions
                  }
                  isLoading={workspaceMode === "server" ? serverTrajectory.isLoading : history.isLoading}
                  hasDiagram={selectedDiagram !== null}
                  currentSource={historySource ?? ""}
                  activeDiagramId={selectedDiagram?.id ?? null}
                  labelForDiagram={diagramLabel}
                  kindForDiagram={diagramKind}
                  projectName={
                    projects.find((project) => project.id === selectedProjectId)
                      ?.name ?? null
                  }
                  resourceScoped={historyResourceScoped}
                  onShowProjectHistory={() => setHistoryResourceScoped(false)}
                  onShowResourceHistory={() => setHistoryResourceScoped(true)}
                  onViewProposal={(proposalId) => {
                    setReviewProposalId(proposalId);
                    setReviewReadOnly(true);
                    setProposalReviewOpen(true);
                  }}
                  onSaveVersion={() => {
                    void history.saveVersion(source);
                  }}
                  onRestore={restoreVersion}
                  onDeleteVersion={(versionId) => {
                    void history.removeVersion(versionId);
                  }}
                />
              ) : error ? (
                <p className="editor__error" data-testid="workspace-error">
                  Could not load your local projects: {error.message}
                </p>
              ) : noteMode && selectedNote ? (
                <>
                  <TabBar
                    tabs={tabs}
                    activeTabId={activeTabId}
                    onActivateTab={activateTabAndDocument}
                    onCloseTab={closeTabAndFollow}
                  />
                  <div
                    className="resource-header"
                    data-testid="resource-header"
                  >
                    <span className="note-header__icon" aria-hidden="true">
                      ¶
                    </span>
                    <span
                      className="note-header__title"
                      data-testid="note-title"
                    >
                      {noteDisplayName(selectedNote.name, source)}
                    </span>
                    <span
                      className="note-header__name"
                      data-testid="note-filename"
                    >
                      {selectedNote.name}
                    </span>
                    <ResourceMetadataEditor
                      metadata={selectedNote.metadata}
                      writable={metadataWritable}
                      onSave={saveResourceMetadata}
                    />
                    <ComplementaryViews
                      resourceId={activeResourceId}
                      relationships={metadata?.relationships ?? []}
                      resources={complementaryResources}
                      onNavigate={(id) => {
                        const target = index?.resources.find((resource) => resource.id === id);
                        const file = target && [...diagrams, ...notes].find((item) => item.name === target.path);
                        if (file) {
                          if (target.type === "markdown-document") loadNote(file as NoteFile);
                          else loadDiagram(file as DiagramFile);
                        }
                      }}
                    />
                  </div>
                  <ResourceActionBar
                    proposalCount={resourceProposalCount}
                    onHistory={() => {
                      setHistoryResourceScoped(true);
                      setView("history");
                    }}
                    onChanges={
                      canReviewProposals
                        ? () => {
                            setReviewProposalId(null);
                            setProposalReviewOpen(true);
                          }
                        : undefined
                    }
                  />
                  <MarkdownEditor
                    value={source}
                    onChange={updateActiveSource}
                    reveal={reveal}
                  />
                </>
              ) : (
                <>
                  <TabBar
                    tabs={tabs}
                    activeTabId={activeTabId}
                    onActivateTab={activateTabAndDocument}
                    onCloseTab={closeTabAndFollow}
                  />
                  <div
                    className="resource-header"
                    data-testid="resource-header"
                  >
                    <span className="resource-header__icon" aria-hidden="true">
                      {isEventFlow ? "↝" : "◌"}
                    </span>
                    <span className="resource-header__title">
                      {diagramDisplayName(
                        selectedDiagram?.name ?? "Untitled",
                        source,
                      )}
                    </span>
                    <span className="resource-header__name">
                      {selectedDiagram?.name}
                    </span>
                    <ResourceMetadataEditor
                      metadata={selectedDiagram?.metadata}
                      writable={metadataWritable}
                      onSave={saveResourceMetadata}
                    />
                    <ComplementaryViews
                      resourceId={activeResourceId}
                      relationships={metadata?.relationships ?? []}
                      resources={complementaryResources}
                      onNavigate={(id) => {
                        const target = index?.resources.find((resource) => resource.id === id);
                        const file = target && [...diagrams, ...notes].find((item) => item.name === target.path);
                        if (file) {
                          if (target.type === "markdown-document") loadNote(file as NoteFile);
                          else loadDiagram(file as DiagramFile);
                        }
                      }}
                    />
                  </div>
                  <ResourceActionBar
                    proposalCount={resourceProposalCount}
                    onHistory={() => {
                      setHistoryResourceScoped(true);
                      setView("history");
                    }}
                    onChanges={
                      canReviewProposals
                        ? () => {
                            setReviewProposalId(null);
                            setProposalReviewOpen(true);
                          }
                        : undefined
                    }
                    onExport={canExportActiveDiagram ? () => setExportDiagramOpen(true) : undefined}
                  />
                  <Editor
                    value={source}
                    onChange={updateActiveSource}
                    diagnostics={editorDiagnostics}
                    reveal={reveal}
                    complete={complete}
                    describe={describe}
                    onCaretChange={onCaretChange}
                    snippets={
                      isEventFlow ? EVENT_FLOW_SNIPPETS : SEQUENCE_SNIPPETS
                    }
                    lineBadges={lineBadges}
                    mentions={mentions}
                  />
                </>
              )}
            </section>

            {!proposalReviewOpen && (
              <>
                <div
                  className="app__splitter"
                  role="separator"
                  tabIndex={0}
                  aria-label="Resize editor"
                  aria-orientation="vertical"
                  onPointerDown={(event) => startResize("editor", event)}
                  onPointerMove={(event) => moveResize("editor", event)}
                  onPointerUp={endResize}
                  onPointerCancel={endResize}
                  onKeyDown={(event) => resizeWithKeyboard("editor", event)}
                />

                <section
                  className="app__pane app__pane--preview"
                  aria-label={
                    noteMode
                      ? "Note preview"
                      : isEventFlow
                        ? "Event flow preview"
                        : "Diagram preview"
                  }
                >
                  {noteMode ? (
                    <MarkdownView
                      markdown={source}
                      resolveWikiLink={resolveWikiLink}
                      resolveResourceLink={resolveResourceLink}
                      renderEmbed={renderEmbed}
                      onOpenDiagramLink={openDiagramLink}
                      onOpenResourceLink={openResourceLink}
                    />
                  ) : isEventFlow ? (
                    <EventFlowPreview
                      source={source}
                      flow={eventFlow}
                      view={eventFlowView}
                      onViewChange={changeEventFlowView}
                      onNodeSelect={onNodeSelect}
                      activeNodeId={activeNodeId}
                      maximized={previewMaximized}
                      onToggleMaximize={() =>
                        setPreviewMaximized((value) => !value)
                      }
                    />
                  ) : (
                    <Preview
                      source={renderedSource || source}
                      autoUpdate={autoUpdate}
                      isStale={isStale}
                      onRender={() => setRenderedSource(source)}
                      onNodeSelect={onNodeSelect}
                      activeNodeId={activeNodeId}
                      maximized={previewMaximized}
                      onToggleMaximize={() =>
                        setPreviewMaximized((value) => !value)
                      }
                    />
                  )}
                </section>
              </>
            )}
          </main>

          <footer className="app__statusbar">
            <span className="app__status-item">{PRODUCT_NAME}</span>
            {noteMode ? (
              <>
                <span
                  className="app__status-item"
                  data-testid="status-participants"
                >
                  {wordCount(source)} words
                </span>
                <span
                  className="app__status-item"
                  data-testid="status-messages"
                >
                  Markdown note
                </span>
              </>
            ) : isEventFlow ? (
              <>
                <span
                  className="app__status-item"
                  data-testid="status-participants"
                >
                  {index?.eventFlows.find(
                    (entry) => entry.id === activeResourceId,
                  )?.events ?? 0}{" "}
                  event
                  {(index?.eventFlows.find(
                    (entry) => entry.id === activeResourceId,
                  )?.events ?? 0) === 1
                    ? ""
                    : "s"}
                </span>
                <span
                  className="app__status-item"
                  data-testid="status-messages"
                >
                  Event flow
                </span>
              </>
            ) : (
              <>
                <span
                  className="app__status-item"
                  data-testid="status-participants"
                >
                  {counts.participants} participant
                  {counts.participants === 1 ? "" : "s"}
                </span>
                <span
                  className="app__status-item"
                  data-testid="status-messages"
                >
                  {counts.messages} message{counts.messages === 1 ? "" : "s"}
                </span>
              </>
            )}
            <span
              className={`app__status-item app__status-item--${errorCount > 0 ? "error" : "ok"}`}
              data-testid="status-diagnostics"
            >
              {errorCount === 0
                ? "No problems"
                : `${errorCount} problem${errorCount === 1 ? "" : "s"}`}
            </span>
            {transferError && (
              <span
                className="app__status-item app__status-item--error"
                data-testid="transfer-error"
              >
                {transferError}
              </span>
            )}
            {retryableSaveFailure && (
              <span
                className="app__status-item app__status-item--error"
                data-testid="save-error"
              >
                {retryableSaveFailure.error.message}
                <button
                  type="button"
                  className="app__status-action"
                  data-testid="save-error-retry"
                  onClick={tabsHook.retrySave}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="app__status-action"
                  data-testid="save-error-dismiss"
                  onClick={tabsHook.dismissSaveError}
                >
                  Dismiss
                </button>
              </span>
            )}
            <span className="app__status-spacer" />
            <span className="app__status-item app__status-item--muted">
              {noteMode ? "Note" : autoUpdate ? "Live" : "Paused"}
            </span>
          </footer>
        </>
      )}

      {isOpen && (
        <CommandPalette
          registry={runnableRegistry}
          onRun={runCommand}
          onClose={close}
          openShortcut={bindingLabel(COMMAND_PALETTE_BINDING)}
        />
      )}

      {searchOpen && (
        <SearchPanel
          query={searchQuery}
          onQueryChange={setSearchQuery}
          matches={searchMatches}
          onOpenMatch={openSearchMatch}
          onClose={closeSearch}
        />
      )}

      {exportDiagramOpen && (
        <ExportDialog
          svg={exportPreview.svg}
          width={exportPreview.width}
          height={exportPreview.height}
          name={activeDocumentName}
          onExport={(options) => {
            void runDiagramExport(options);
          }}
          onClose={() => setExportDiagramOpen(false)}
        />
      )}

      {quickOpenOpen && (
        <QuickOpen
          items={quickOpenItems}
          onPick={openQuickOpenItem}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}

      {referenceMatches && (
        <SearchPanel
          query={referenceTitle}
          onQueryChange={() => {
            /* A reference list is not a live query; clearing closes it. */
          }}
          matches={referenceMatches}
          onOpenMatch={(match) => {
            setReferenceMatches(null);
            openSearchMatch(match);
          }}
          onClose={() => setReferenceMatches(null)}
        />
      )}

      {/* The Import Project command clicks this; the input is never shown. */}
      <input
        ref={importInputRef}
        className="visually-hidden"
        data-testid="import-file-input"
        type="file"
        accept=".zip,application/zip"
        aria-label="Import project archive"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first, so choosing the same file again still fires `change`.
          event.target.value = "";
          if (file) void importProjectFile(file);
        }}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
          label={
            menu.kind === "diagram"
              ? "Diagram actions"
              : menu.kind === "note"
                ? "Note actions"
                : menu.kind === "project"
                  ? "Project actions"
                  : "Add to project"
          }
        />
      )}

      {conflict && (
        <SaveConflictDialog
          documentName={conflict.document.name}
          message={conflict.error.message}
          copied={conflictCopied}
          onReload={() => {
            void resolveConflictByReload();
          }}
          onKeepMine={() => {
            void resolveConflictByKeepingMine();
          }}
          onCopyMine={copyConflictBuffer}
          onCancel={tabsHook.dismissSaveError}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.kind} “${pendingDelete.name}”?`}
          message={deleteMessage(pendingDelete.kind, folderOpen)}
          confirmLabel={folderOpen ? "Delete from disk" : "Delete"}
          alternativeLabel={folderOpen ? "Remove from app" : undefined}
          onAlternative={() => {
            void confirmDelete("app");
          }}
          onConfirm={() => {
            void confirmDelete("disk");
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {prompt && (
        <PromptDialog
          title={promptTitle(prompt)}
          label={promptLabel(prompt)}
          initialValue={promptInitial(prompt)}
          confirmLabel={prompt.kind.startsWith("rename") ? "Rename" : "Save"}
          onConfirm={(value) => {
            void confirmPrompt(value);
          }}
          onCancel={() => setPrompt(null)}
        />
      )}
    </div>
  );
}

/** The heading for a rename/title prompt. */
function promptTitle(target: PromptTarget): string {
  switch (target.kind) {
    case "rename-symbol":
      return `Rename ${target.name}`;
    case "rename-project":
      return "Rename project";
    case "rename-diagram":
      return "Rename diagram";
    case "rename-note":
      return "Rename note";
    case "title-diagram":
      return "Change diagram title";
    case "title-note":
      return "Change note title";
  }
}

/** The input label for a rename/title prompt. */
function promptLabel(target: PromptTarget): string {
  if (target.kind === "rename-symbol") return "New name";
  if (target.kind === "rename-project") return "Project name";
  return target.kind.startsWith("rename") ? "File name" : "Title";
}

/** The input's starting value for a rename/title prompt. */
function promptInitial(target: PromptTarget): string {
  switch (target.kind) {
    case "rename-symbol":
      return target.name;
    case "rename-project":
      return target.project.name;
    case "rename-diagram":
      return target.diagram.name;
    case "rename-note":
      return target.note.name;
    case "title-diagram":
      return diagramTitle(target.diagram.source) ?? "";
    case "title-note":
      return noteTitle(target.note.markdown) ?? "";
  }
}

/**
 * The consequence text for a delete confirmation. When a folder is open the two
 * scopes are genuinely different (disk vs app-only), so the message spells both
 * out; in-browser projects have a single permanent delete.
 */
function deleteMessage(
  kind: PendingDelete["kind"],
  folderOpen: boolean,
): string {
  const thing =
    kind === "diagram"
      ? "diagram"
      : kind === "note"
        ? "note"
        : "project and its diagrams and notes";
  if (folderOpen) {
    return `Remove the ${thing} from the app but keep the file on disk, or delete it from disk for good. Deleting from disk cannot be undone.`;
  }
  return `This deletes the ${thing} from this browser. This cannot be undone.`;
}
