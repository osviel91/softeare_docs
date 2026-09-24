import { useEffect, useState } from "react";
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

export interface ProposalReviewProps {
  proposal: ServerChangeProposal;
  diff: ServerChangeProposalDiff;
  current: ServerResource;
  onBack: () => void;
  canMerge: boolean;
  onMerge: () => void;
}

export function ProposalReviewPanel({
  client,
  projectId,
  resourceId,
  onBack,
  canMerge,
}: {
  client: ServerApiClient;
  projectId: string;
  resourceId: string;
  onBack: () => void;
  canMerge: boolean;
}) {
  const [proposals, setProposals] = useState<ServerChangeProposal[]>([]);
  const [selected, setSelected] = useState<ServerChangeProposal | null>(null);
  const [diff, setDiff] = useState<ServerChangeProposalDiff | null>(null);
  const [current, setCurrent] = useState<ServerResource | null>(null);
  const [analysis, setAnalysis] = useState<MergeAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    } catch {
      setError(
        "Could not merge this proposal. Refresh the analysis and try again.",
      );
    }
  };

  useEffect(() => {
    void client
      .listChangeProposals(projectId, resourceId)
      .then((items) => {
        setProposals(items);
        setSelected(items[0] ?? null);
      })
      .catch(() => setError("Could not load change proposals."));
  }, [client, projectId, resourceId]);

  useEffect(() => {
    if (!selected) return;
    setDiff(null);
    setAnalysis(null);
    void Promise.all([
      client.getChangeProposalDiff(selected.id),
      client.getChangeProposalMergeAnalysis(selected.id),
      client.readResource(projectId, resourceId),
    ])
      .then(([nextDiff, nextAnalysis, read]) => {
        setDiff(nextDiff);
        setAnalysis(nextAnalysis);
        setCurrent(read.resource);
      })
      .catch(() => setError("Could not load this proposal review."));
  }, [client, projectId, resourceId, selected]);

  return (
    <div className="proposal-review-panel">
      <aside
        className="proposal-review-panel__list"
        aria-label="Change proposals"
      >
        <button type="button" className="button button--ghost" onClick={onBack}>
          Back to resource
        </button>
        <h1>Change proposals</h1>
        {proposals.length === 0 && !error && (
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
            onBack={onBack}
            canMerge={canMerge}
            onMerge={() => void merge()}
          />
        ) : (
          <p>Loading proposal review…</p>
        )}
      </main>
    </div>
  );
}

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  modified: "Modified",
};

function authorLabel(author: ServerChangeProposal["author"]): string {
  if (author.kind === "agent") return `Agent ${author.agentId}`;
  if (author.kind === "user") return "Human author";
  return "System";
}

function ChangeList({ changes }: { changes: SemanticChange[] }) {
  return changes.length === 0 ? (
    <p className="proposal-review__empty">No semantic changes.</p>
  ) : (
    <ul className="proposal-review__changes">
      {changes.map((change, index) => (
        <li
          className={`proposal-review__change proposal-review__change--${change.kind}`}
          key={`${change.identity}-${index}`}
        >
          <span className="proposal-review__kind">
            {KIND_LABEL[change.kind]}
          </span>
          <strong>{change.entity}</strong>
          <span>{change.identity}</span>
          {change.details && <code>{JSON.stringify(change.details)}</code>}
        </li>
      ))}
    </ul>
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
  onBack,
  canMerge,
  onMerge,
}: ProposalReviewProps & { analysis: MergeAnalysis }) {
  const [view, setView] = useState<"changes" | "side-by-side" | "source">(
    "changes",
  );
  const [eventFlowView, setEventFlowView] = useState<EventFlowView>("flow");
  const representation = resourceRepresentationOfType(diff.type);

  useEffect(() => setView("changes"), [proposal.id]);

  const artifact = (label: string, content: string) => (
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
        />
      ) : (
        <Preview source={content} />
      )}
    </section>
  );

  return (
    <div className="proposal-review" data-testid="proposal-review">
      <header className="proposal-review__header">
        <button type="button" className="button button--ghost" onClick={onBack}>
          Back to resource
        </button>
        <p className="proposal-review__eyebrow">Change proposal</p>
        <h1>{proposal.title}</h1>
        {proposal.description && <p>{proposal.description}</p>}
        <dl className="proposal-review__facts">
          <div>
            <dt>Status</dt>
            <dd>{proposal.status}</dd>
          </div>
          <div>
            <dt>Proposed by</dt>
            <dd>{authorLabel(proposal.author)}</dd>
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
          {analysis.status !== "ok"
            ? `Merge analysis unavailable: ${analysis.status}.`
            : analysis.autoMergeable
              ? analysis.stale
                ? "Canonical changed since this proposal was created. No semantic conflicts detected."
                : "Ready for merge analysis. No concurrent canonical changes."
              : `${analysis.conflicts.length} conflict${analysis.conflicts.length === 1 ? "" : "s"} require resolution.`}
        </p>
        {canMerge && proposal.status === "open" && analysis.autoMergeable && (
          <button type="button" className="button" onClick={onMerge}>
            Merge proposal
          </button>
        )}
        {proposal.status === "merged" &&
          proposal.mergedRevision !== undefined && (
            <p role="status">
              Merged into canonical revision r{proposal.mergedRevision}.
            </p>
          )}
      </header>
      <nav className="proposal-review__tabs" aria-label="Proposal review views">
        {(
          [
            ["changes", "Changes"],
            ["side-by-side", "Side by side"],
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
      {view === "changes" && (
        <div className="proposal-review__changes-view">
          <section>
            <h2>Resource metadata</h2>
            <ChangeList
              changes={diff.metadata.changes.map((change) => ({
                ...change,
                entity: change.field,
              }))}
            />
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
              <ChangeList changes={diff.content.changes} />
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
        </div>
      )}
      {view === "side-by-side" && (
        <div className="proposal-review__artifacts">
          {artifact("Base", diff.baseContent)}
          {artifact("Proposed", diff.proposedContent)}
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
    </div>
  );
}
