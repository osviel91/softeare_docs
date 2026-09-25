import type { ChangeProposal } from "./change-proposal";
import type { ResourceRevision, ResourceAuthorship } from "./resource-revision";

export type TrajectoryOperation =
  "CREATED" | "EDIT" | "METADATA" | "PROPOSAL" | "MERGE";

export interface TrajectoryEntry {
  id: string;
  resourceId: string;
  operation: TrajectoryOperation;
  occurredAt: Date;
  actor: ResourceAuthorship | null;
  revision?: number;
  baseRevision?: number;
  resultingRevision?: number;
  proposal?: Pick<ChangeProposal, "id" | "title" | "author" | "mergeActor">;
}

export interface ResourceTrajectory {
  resourceId: string;
  entries: TrajectoryEntry[];
}

/** Project persisted revisions and proposals without manufacturing revisions. */
export function resourceTrajectoryOf(
  resourceId: string,
  revisions: readonly ResourceRevision[],
  proposals: readonly ChangeProposal[] = [],
): ResourceTrajectory {
  const entries: TrajectoryEntry[] = revisions.map((revision) => ({
    id: `${resourceId}:revision:${revision.revision}`,
    resourceId,
    operation: revision.revision === 1 ? "CREATED" : "EDIT",
    occurredAt: revision.createdAt,
    actor: revision.authoredBy,
    revision: revision.revision,
  }));

  for (const proposal of proposals) {
    entries.push({
      id: `${resourceId}:proposal:${proposal.id}`,
      resourceId,
      operation: proposal.status === "merged" ? "MERGE" : "PROPOSAL",
      occurredAt: proposal.mergedAt ?? proposal.createdAt,
      actor:
        proposal.status === "merged"
          ? (proposal.mergeActor ?? null)
          : proposal.author,
      baseRevision: proposal.baseRevision,
      resultingRevision: proposal.mergedRevision,
      proposal: {
        id: proposal.id,
        title: proposal.title,
        author: proposal.author,
        mergeActor: proposal.mergeActor,
      },
    });
  }

  entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return { resourceId, entries };
}

export function trajectoryActorLabel(actor: ResourceAuthorship | null): string {
  if (!actor) return "Unknown";
  if (actor.kind === "agent") return `Agent ${actor.agentId.slice(0, 8)}…`;
  if (actor.kind === "user") return actor.userId === "" ? "Unknown" : "Human";
  return "System";
}
