import { useCallback, useEffect, useMemo, useState } from "react";
import Preview from "../preview/Preview";
import EventFlowPreview, {
  type EventFlowView,
} from "../preview/EventFlowPreview";
import MarkdownView from "../notes/MarkdownView";
import type {
  ServerApiClient,
  ServerChangeProposal,
  ServerChangeProposalDiff,
  ServerResource,
} from "../../workspace/server/api-client";
import type {
  ChangeKind,
  SemanticChange,
} from "../../domain/diff/resource-diff";
import { resourceRepresentationOfType } from "../../domain/workspace/resource-id";
import type { MergeAnalysis } from "../../domain/diff/merge-analysis";
import { loadProjectProposals } from "./project-proposals";
import { ApiError, NetworkError } from "../../workspace/server/api-errors";
import type { DiagramViewportTransform } from "../preview/DiagramViewport";
import {
  reviewChangeTargets,
  type ReviewChangeTarget,
} from "./review-targets";

export interface ProposalReviewProps {
  proposal: ServerChangeProposal;
  diff: ServerChangeProposalDiff;
  current: ServerResource;
  currentContent?: string;
  onBack: () => void;
  canMerge: boolean;
  onMerge: () => void;
}

export function ProposalReviewPanel({
  client,
  projectId,
  resourceId,
  initialProposalId,
  onBack,
  canMerge,
}: {
  client: ServerApiClient;
  projectId: string;
  resourceId?: string;
  initialProposalId?: string | null;
  onBack: () => void;
  canMerge: boolean;
}) {
  const [proposals, setProposals] = useState<ServerChangeProposal[]>([]);
  const [selected, setSelected] = useState<ServerChangeProposal | null>(null);
  const [diff, setDiff] = useState<ServerChangeProposalDiff | null>(null);
  const [current, setCurrent] = useState<ServerResource | null>(null);
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<MergeAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposalState, setProposalState] = useState<
    "loading" | "loaded" | "failed"
  >("loading");

  const merge = async () => {
    if (!selected || !current || !analysis?.autoMergeable) return;
    const suffix = analysis.stale
      ? " Canonical has advanced; compatible canonical changes will be preserved."
      : "";
    if (!window.confirm(`Merge proposal ${selected.title}?${suffix}`)) return;
    try {
      const result = await client.mergeChangeProposal(selected.id);
      setSelected(result.proposal);
      setProposals((items) =>
        items.map((item) =>
          item.id === result.proposal.id ? result.proposal : item,
        ),
      );
      setCurrent(result.resource);
    } catch (caught) {
      setError(mergeErrorMessage(caught));
    }
  };

  useEffect(() => {
    let active = true;
    setError(null);
    setProposals([]);
    setSelected(null);
    setDiff(null);
    setAnalysis(null);
    setCurrent(null);
    setCurrentContent(null);
    setProposalState("loading");
    if (initialProposalId && !resourceId) {
      void client
        .getChangeProposal(initialProposalId)
        .then((proposal) => {
          if (!active) return;
          setProposalState("loaded");
          setProposals([proposal]);
          setSelected(proposal);
        })
        .catch(() => {
          if (active) setError("Proposal not found or unavailable.");
          if (active) setProposalState("failed");
        });
      return () => {
        active = false;
      };
    }
    void loadProjectProposals(client, projectId)
      .then((entries) => {
        if (!active) return;
        const items = entries
          .filter(({ resource }) => !resourceId || resource.id === resourceId)
          .map(({ proposal }) => proposal);
        setProposals(items);
        setProposalState("loaded");
        setSelected(
          items.find((item) => item.id === initialProposalId) ??
            items[0] ??
            null,
        );
      })
      .catch(() => {
        if (active) setError("Could not load change proposals.");
        if (active) setProposalState("failed");
      });
    return () => {
      active = false;
    };
  }, [client, projectId, resourceId, initialProposalId]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setDiff(null);
    setAnalysis(null);
    void Promise.all([
      client.getChangeProposalDiff(selected.id),
      client.getChangeProposalMergeAnalysis(selected.id),
      client.readResource(projectId, selected.resourceId),
      ])
      .then(([nextDiff, nextAnalysis, read]) => {
        if (!active) return;
        setDiff(nextDiff);
        setAnalysis(nextAnalysis);
        setCurrent(read.resource);
        setCurrentContent(read.content);
      })
      .catch(() => {
        if (active) setError("Could not load this proposal review.");
      });
    return () => {
      active = false;
    };
  }, [client, projectId, selected]);

  return (
    <div className="proposal-review-panel">
      <aside
        className="proposal-review-panel__list"
        aria-label="Change proposals"
      >
        <button type="button" className="button button--ghost" onClick={onBack}>
          Back to changes
        </button>
        <h1>{resourceId ? "Change proposals" : "Project changes"}</h1>
        {proposalState === "loaded" && proposals.length === 0 && !error && (
          <p>No proposals for this resource.</p>
        )}
        {proposals.map((item) => (
          <button
            type="button"
            className={selected?.id === item.id ? "is-active" : ""}
            key={item.id}
            onClick={() => setSelected(item)}
          >
            <strong>{item.title}</strong>
            <span>{item.status}</span>
          </button>
        ))}
        {error && <p role="alert">{error}</p>}
      </aside>
      <main className="proposal-review-panel__main">
        {selected && diff && current && analysis ? (
          <ProposalReview
            proposal={selected}
            diff={diff}
            analysis={analysis}
            current={current}
            currentContent={currentContent ?? undefined}
            onBack={onBack}
            canMerge={canMerge}
            onMerge={() => void merge()}
          />
        ) : (
          <p className="proposal-review__loading" role="status">
            {error ??
              (proposalState === "loading"
                ? initialProposalId
                  ? "Loading proposal…"
                  : "Loading changes…"
                : "No proposal review selected.")}
          </p>
        )}
      </main>
    </div>
  );
}

function mergeErrorMessage(error: unknown): string {
  if (error instanceof NetworkError)
    return "The server could not be reached. Check your connection and try again.";
  if (error instanceof ApiError) {
    if (error.code === "unauthorized") return "Sign in to merge this proposal.";
    if (error.code === "forbidden")
      return "You are not authorized to merge this proposal.";
    if (error.code === "not_found") return "This proposal or resource no longer exists.";
    if (error.code === "invalid") return error.message;
    if (error.code === "conflict") {
      if (error.details.reason === "proposal_changed")
        return "This proposal changed while you were reviewing it. Refresh the analysis.";
      if ("expectedRevision" in error.details)
        return "The canonical resource changed while you were reviewing it. Refresh the analysis.";
      return error.message;
    }
    return `The server could not merge this proposal: ${error.message}`;
  }
  return "Could not merge this proposal. Refresh the analysis and try again.";
}

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  modified: "Modified",
};

function authorLabel(author: ServerChangeProposal["author"]): string {
  if (author.kind === "agent") return `Agent\n${author.agentId.slice(0, 8)}…`;
  if (author.kind === "user") return "User";
  return "System";
}

function semanticLabel(change: SemanticChange): string {
  const labels: Record<string, string> = {
    event: "Event",
    "event-metadata": "Event metadata",
    channel: "Channel",
    publication: "Publication",
    subscription: "Subscription",
    participant: "Participant",
    interaction: "Interaction",
    "markdown-block": "Markdown section",
  };
  return labels[change.entity] ?? change.entity.replace(/-/g, " ");
}

function readableDetails(details?: Record<string, unknown>): string | null {
  if (!details) return null;
  const values = Object.entries(details)
    .filter(([key]) => key !== "event" && key !== "key")
    .map(
      ([key, value]) =>
        `${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    );
  return values.length > 0 ? values.join("; ") : null;
}

function ChangeList({ targets }: { targets: ReviewChangeTarget[] }) {
  return targets.length === 0 ? (
    <p className="proposal-review__empty">No semantic changes.</p>
  ) : (
    <ul className="proposal-review__changes">
      {targets.map((target) => {
        const change = target.change!;
        return (
          <li
            className={`proposal-review__change proposal-review__change--${change.kind}`}
            key={target.id}
            id={`review-target-${target.id}`}
            data-review-target={target.id}
            tabIndex={-1}
          >
            <span className="proposal-review__kind">
              {KIND_LABEL[change.kind]}
            </span>
            <strong>{semanticLabel(change)}</strong>
            <span>
              {change.identity.replace(/\|/g, " → ").replace(/:/g, " / ")}
            </span>
            {readableDetails(change.details) && (
              <span>{readableDetails(change.details)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The one navigator for review changes. It renders only when there is more
 * than one target, and every value it shows — position, total, and the
 * disabled state of both arrows — is derived from the same `targets` array.
 */
function ChangeNavigator({
  targets,
  currentIndex,
  onChange,
}: {
  targets: ReviewChangeTarget[];
  currentIndex: number;
  onChange: (index: number) => void;
}) {
  if (targets.length <= 1) return null;
  return (
    <div className="proposal-review__change-nav" aria-label="Change navigation">
      <button
        type="button"
        data-testid="change-previous"
        onClick={() => onChange(Math.max(0, currentIndex - 1))}
        disabled={currentIndex === 0}
      >
        ‹ Previous change
      </button>
      <span data-testid="change-position">
        {currentIndex + 1} of {targets.length}
      </span>
      <button
        type="button"
        data-testid="change-next"
        onClick={() => onChange(Math.min(targets.length - 1, currentIndex + 1))}
        disabled={currentIndex >= targets.length - 1}
      >
        Next change ›
      </button>
    </div>
  );
}

function SourceDiff({ diff }: { diff: ServerChangeProposalDiff }) {
  if (!diff.source.changed)
    return <p className="proposal-review__empty">No source changes.</p>;
  return (
    <div
      className="proposal-review__source"
      role="region"
      aria-label="Source diff"
    >
      {diff.source.hunks.map((hunk, index) => (
        <div
          className="proposal-review__hunk"
          key={`${hunk.oldStart}-${hunk.newStart}-${index}`}
        >
          <div className="proposal-review__hunk-heading">
            @@ {hunk.oldStart} / {hunk.newStart} @@
          </div>
          {hunk.oldLines.map((line, lineIndex) => (
            <div
              className="proposal-review__line proposal-review__line--removed"
              key={`old-${lineIndex}`}
            >
              <span>-</span>
              {line}
            </div>
          ))}
          {hunk.newLines.map((line, lineIndex) => (
            <div
              className="proposal-review__line proposal-review__line--added"
              key={`new-${lineIndex}`}
            >
              <span>+</span>
              {line}
            </div>
          ))}
        </div>
      ))}
      {diff.source.truncated && (
        <p className="proposal-review__notice">
          Source output is truncated. More hunks exist.
        </p>
      )}
    </div>
  );
}

export default function ProposalReview({
  proposal,
  diff,
  analysis,
  current,
  currentContent,
  onBack,
  canMerge,
  onMerge,
}: ProposalReviewProps & { analysis: MergeAnalysis }) {
  const [view, setView] = useState<"changes" | "compare" | "source">("changes");
  const [changeIndex, setChangeIndex] = useState(0);
  const [eventFlowView, setEventFlowView] = useState<EventFlowView>("flow");
  const [linkedNavigation, setLinkedNavigation] = useState(true);
  // The active linked camera plus which pane last moved it. A pane never
  // receives its own camera back, so synchronization can never echo between
  // the two views.
  const [linkedCamera, setLinkedCamera] = useState<{
    origin: "base" | "proposed";
    transform: DiagramViewportTransform;
  } | null>(null);
  const representation = resourceRepresentationOfType(diff.type);
  // The single source of truth for navigable review changes: position, total,
  // disabled states, and the focused target all derive from this one list.
  const reviewTargets = useMemo(
    () =>
      diff.content.available
        ? reviewChangeTargets(diff.metadata.changes, diff.content.changes)
        : reviewChangeTargets(diff.metadata.changes, []),
    [diff.metadata.changes, diff.content.changes, diff.content.available],
  );
  const metadataTargets = useMemo(
    () => reviewTargets.filter((target) => target.kind === "metadata"),
    [reviewTargets],
  );
  const semanticTargets = useMemo(
    () => reviewTargets.filter((target) => target.kind === "semantic"),
    [reviewTargets],
  );
  const semanticChanges = useMemo(
    () =>
      semanticTargets
        .map((target) => target.change)
        .filter((change): change is SemanticChange => change != null),
    [semanticTargets],
  );
  const currentTargetIndex =
    reviewTargets.length === 0
      ? -1
      : Math.min(changeIndex, reviewTargets.length - 1);
  const currentTarget = reviewTargets[currentTargetIndex] ?? null;

  useEffect(() => {
    setView("changes");
    setChangeIndex(0);
    setLinkedCamera(null);
  }, [proposal.id]);

  // A reloaded/regrouped target list invalidates the previous position.
  useEffect(() => {
    setChangeIndex(0);
  }, [reviewTargets]);

  useEffect(() => {
    if (!currentTarget) return;
    const element = document.getElementById(`review-target-${currentTarget.id}`);
    element?.scrollIntoView?.({ block: "nearest" });
    element?.focus();
  }, [currentTarget]);

  const handleBaseCamera = useCallback(
    (transform: DiagramViewportTransform) =>
      setLinkedCamera({ origin: "base", transform }),
    [],
  );
  const handleProposedCamera = useCallback(
    (transform: DiagramViewportTransform) =>
      setLinkedCamera({ origin: "proposed", transform }),
    [],
  );

  const artifact = (
    label: string,
    content: string,
    side: "base" | "proposed",
  ) => {
    // In linked mode a pane follows the *other* pane's camera and reports its
    // own; the origin pane never gets its own camera echoed back.
    const linkedTransform =
      linkedNavigation && linkedCamera && linkedCamera.origin !== side
        ? linkedCamera.transform
        : null;
    const onTransformChange = linkedNavigation
      ? side === "base"
        ? handleBaseCamera
        : handleProposedCamera
      : undefined;
    return (
      <section
        className="proposal-review__artifact"
        aria-labelledby={`proposal-${label.toLowerCase()}`}
      >
        <h2 id={`proposal-${label.toLowerCase()}`}>{label}</h2>
        {representation === "markdown" ? (
          <MarkdownView markdown={content} />
        ) : representation === "event-flow" ? (
          <EventFlowPreview
            source={content}
            view={eventFlowView}
            onViewChange={setEventFlowView}
            reviewChanges={semanticChanges}
            reviewMode
            reviewSide={side}
            linkedTransform={linkedTransform}
            onTransformChange={onTransformChange}
            activeReviewChange={currentTarget?.id}
          />
        ) : (
          <Preview
            source={content}
            reviewChanges={semanticChanges}
            reviewMode
            reviewSide={side}
            linkedTransform={linkedTransform}
            onTransformChange={onTransformChange}
            activeReviewChange={currentTarget?.id}
          />
        )}
      </section>
    );
  };

  return (
    <div className="proposal-review" data-testid="proposal-review">
      <header className="proposal-review__header">
        <button type="button" className="button button--ghost" onClick={onBack}>
          ← Changes
        </button>
        <p className="proposal-review__eyebrow">Change proposal</p>
        <h1>{proposal.title}</h1>
        <p className="proposal-review__resource">
          {current.path} · {resourceRepresentationOfType(diff.type)}
        </p>
        {proposal.description && <p>{proposal.description}</p>}
        <dl className="proposal-review__facts">
          <div>
            <dt>Status</dt>
            <dd>{proposal.status.toUpperCase()}</dd>
          </div>
          <div>
            <dt>Proposed by</dt>
            <dd className="proposal-review__author">
              {authorLabel(proposal.author)}
            </dd>
          </div>
          <div>
            <dt>Base revision</dt>
            <dd>r{diff.baseRevision}</dd>
          </div>
          <div>
            <dt>Current revision</dt>
            <dd>r{diff.currentRevision}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{new Date(proposal.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
        {diff.stale && (
          <p className="proposal-review__stale" role="status">
            Canonical resource has changed since this proposal was created.
          </p>
        )}
        <p className="proposal-review__merge-status" role="status">
          {analysis.status !== undefined && analysis.status !== "ok"
            ? "Invalid proposal"
            : analysis.autoMergeable
              ? analysis.stale
                ? "Stale but compatible"
                : "Ready to merge"
              : "Conflicts require attention"}
        </p>
        {proposal.status === "merged" &&
          proposal.mergedRevision !== undefined && (
            <p role="status">
              Merged into canonical revision r{proposal.mergedRevision}.
            </p>
          )}
      </header>
      <div className="proposal-review__toolbar">
        <nav className="proposal-review__tabs" aria-label="Proposal review views">
          {(
          [
            ["changes", "Changes"],
            ["compare", "Compare"],
            ["source", "Source"],
          ] as const
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              aria-pressed={view === key}
              className={view === key ? "is-active" : ""}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="proposal-review__decision" aria-label="Proposal decision">
          {canMerge && proposal.status === "open" && analysis.autoMergeable ? (
            <button type="button" className="button" onClick={onMerge}>
              Merge proposal
            </button>
          ) : proposal.status === "open" ? (
            <span>
              {analysis.conflicts.length > 0
                ? "Conflicts require attention"
                : "Not ready to merge"}
            </span>
          ) : (
            <span>Proposal is {proposal.status}.</span>
          )}
        </div>
      </div>
      {view === "changes" && (
        <div className="proposal-review__changes-view">
          <section>
            <h2>Resource metadata</h2>
            {metadataTargets.length === 0 ? (
              <p className="proposal-review__empty">No metadata changes.</p>
            ) : (
              <ul className="proposal-review__changes">
                {metadataTargets.map((target) => {
                  const change = target.metadata!;
                  return (
                    <li
                      className={`proposal-review__change proposal-review__change--${change.kind}`}
                      key={target.id}
                      id={`review-target-${target.id}`}
                      data-review-target={target.id}
                      tabIndex={-1}
                    >
                      <strong>
                        {change.field === "tag" ? "Tags" : "Description"}
                      </strong>
                      <span>
                        {change.kind === "removed" ? "−" : "+"}{" "}
                        {change.newValue ?? change.oldValue}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section>
            <h2>
              {representation === "markdown"
                ? "Markdown"
                : representation === "event-flow"
                  ? "Event Flow"
                  : "Sequence"}
            </h2>
            {diff.content.available ? (
              <ChangeList targets={semanticTargets} />
            ) : (
              <>
                <p>Semantic comparison unavailable.</p>
                <ul>
                  {diff.content.diagnostics.map((diagnostic, index) => (
                    <li key={index}>{String(diagnostic)}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {diff.content.truncated && (
            <p className="proposal-review__notice">
              Semantic changes are truncated. More changes exist.
            </p>
          )}
          <ChangeNavigator
            targets={reviewTargets}
            currentIndex={currentTargetIndex}
            onChange={setChangeIndex}
          />
        </div>
      )}
      {view === "compare" && (
        <div className="proposal-review__compare">
          <div className="proposal-review__compare-tools">
            <label>
              <input
                type="checkbox"
                checked={linkedNavigation}
                onChange={(event) => {
                  setLinkedNavigation(event.target.checked);
                  // Turning linking on/off never moves the cameras; the next
                  // pan or zoom on either pane establishes the leader.
                  setLinkedCamera(null);
                }}
              />{" "}
              Link pan and zoom
            </label>
          </div>
          <div className="proposal-review__artifacts">
          {artifact("BASE", diff.baseContent, "base")}
          {diff.stale &&
            currentContent !== undefined &&
            artifact("CURRENT", currentContent, "base")}
          {artifact("PROPOSED", diff.proposedContent, "proposed")}
          </div>
          <ChangeNavigator
            targets={reviewTargets}
            currentIndex={currentTargetIndex}
            onChange={setChangeIndex}
          />
        </div>
      )}
      {view === "source" && <SourceDiff diff={diff} />}
      {analysis.conflicts.length > 0 && (
        <section>
          <h2>Merge conflicts</h2>
          <ul>
            {analysis.conflicts.map((conflict) => (
              <li
                key={`${conflict.entity}:${conflict.identity}:${conflict.kind}`}
              >
                <strong>{conflict.kind}</strong> {conflict.entity}{" "}
                {conflict.identity}
              </li>
            ))}
          </ul>
        </section>
      )}
      {representation !== "markdown" &&
        current.revision !== diff.currentRevision && (
          <p className="proposal-review__notice">
            Current canonical revision changed while this review was open.
          </p>
        )}
      {diff.stale && (
        <p className="proposal-review__notice" role="status">
          CURRENT canonical context is r{diff.currentRevision}; BASE remains r
          {diff.baseRevision} for this review.
        </p>
      )}
    </div>
  );
}
