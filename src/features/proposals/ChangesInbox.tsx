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
  if (author.kind === "agent") return `Agent ${author.agentId.slice(0, 8)}`;
  if (author.kind === "user") return "User";
  return "System";
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
          <h1>Changes</h1>
          <p>
            Review proposed documentation changes across every resource in this
            project.
          </p>
        </div>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setShowHistory((value) => !value)}
        >
          {showHistory ? "Open changes" : "View history"}
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
                    {entry.proposal.status}
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
                <span>
                  {entry.analysis
                    ? entry.analysis.autoMergeable
                      ? "No merge conflicts detected"
                      : `${entry.analysis.conflicts.length} merge conflict${entry.analysis.conflicts.length === 1 ? "" : "s"}`
                    : "Merge analysis unavailable"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
