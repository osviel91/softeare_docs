import { useEffect, useState } from "react";
import type { ServerApiClient } from "../../workspace/server/api-client";
import { resourceRepresentationOfType } from "../../domain/workspace/resource-id";
import {
  loadProjectProposals,
  type ProjectProposalEntry,
} from "./project-proposals";

function age(value: string): string {
  return new Date(value).toLocaleString();
}

function author(author: ProjectProposalEntry["proposal"]["author"]): string {
  if (author.kind === "agent") return `Agent ${author.agentId.slice(0, 8)}…`;
  if (author.kind === "user") return "User";
  return "System";
}

function actor(author: ProjectProposalEntry["proposal"]["author"]): string {
  if (author.kind === "agent") return `Agent ${author.agentId.slice(0, 8)}…`;
  if (author.kind === "user") return "User";
  return "System";
}

function mergeStatus(entry: ProjectProposalEntry): string {
  if (entry.proposal.status === "merged") return "Merged";
  if (entry.proposal.status === "closed") return "Closed";
  if (entry.analysis === null) return "Analysis unavailable";
  if (entry.analysis.status !== undefined && entry.analysis.status !== "ok")
    return "Invalid proposal";
  if (entry.analysis.autoMergeable)
    return entry.analysis.stale ? "Stale but compatible" : "Ready to merge";
  return "Conflicts require attention";
}

function summary(entry: ProjectProposalEntry): string {
  if (!entry.diff) return "Analysis unavailable";
  const { summary: counts } = entry.diff;
  return `${counts.semanticChanges} semantic change${counts.semanticChanges === 1 ? "" : "s"}, ${counts.sourceHunks} source hunk${counts.sourceHunks === 1 ? "" : "s"}`;
}

export default function ChangesInbox({
  client,
  projectId,
  onOpen,
}: {
  client: ServerApiClient;
  projectId: string;
  onOpen: (proposalId: string) => void;
}) {
  const [entries, setEntries] = useState<ProjectProposalEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadProjectProposals(client, projectId, true)
      .then((items) => {
        if (active) setEntries(items);
      })
      .catch(() => {
        if (active) setError("Could not load project changes.");
      });
    return () => {
      active = false;
    };
  }, [client, projectId]);

  const visible = entries.filter(({ proposal }) =>
    showHistory ? proposal.status !== "open" : proposal.status === "open",
  );
  return (
    <main className="changes-inbox" data-testid="changes-inbox">
      <header className="changes-inbox__header">
        <div>
          <p className="proposal-review__eyebrow">Project collaboration</p>
          <h1>
            Changes{" "}
            <span className="changes-inbox__count">
              {
                entries.filter(({ proposal }) => proposal.status === "open")
                  .length
              }{" "}
              open
            </span>
          </h1>
          <p>
            Review proposed documentation changes across every resource in this
            project.
          </p>
        </div>
        <button
          type="button"
          className="button button--ghost"
          aria-label={showHistory ? "Open changes" : "View history"}
          onClick={() => setShowHistory((value) => !value)}
        >
          {showHistory ? "Open" : "History"}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {visible.length === 0 ? (
        <p className="changes-inbox__empty">
          {showHistory
            ? "No merged or closed changes yet."
            : "No open changes — Canonical documentation is up to date."}
        </p>
      ) : (
        <ul className="changes-inbox__list">
          {visible.map((entry) => (
            <li key={entry.proposal.id}>
              <button
                type="button"
                className="changes-inbox__item"
                onClick={() => onOpen(entry.proposal.id)}
              >
                <span className="changes-inbox__title">
                  <strong>{entry.proposal.title}</strong>
                  <span className="changes-inbox__status">
                    {mergeStatus(entry)}
                  </span>
                </span>
                <span>
                  {entry.resource.path} ·{" "}
                  {resourceRepresentationOfType(entry.resource.type)}
                </span>
                <span>
                  {author(entry.proposal.author)} · updated{" "}
                  {age(entry.proposal.updatedAt)}
                </span>
                <span>
                  {summary(entry)} · base r{entry.proposal.baseRevision} /
                  current r
                  {entry.diff?.currentRevision ?? entry.resource.revision}
                </span>
                <span>{mergeStatus(entry)}</span>
                {showHistory && entry.proposal.status === "merged" && (
                  <span>
                    Merged
                    {entry.proposal.mergeActor
                      ? ` by ${actor(entry.proposal.mergeActor)}`
                      : ""}
                    {entry.proposal.mergedRevision !== undefined
                      ? ` into r${entry.proposal.mergedRevision}`
                      : ""}
                    {entry.proposal.mergedAt
                      ? ` · ${age(entry.proposal.mergedAt)}`
                      : ""}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
