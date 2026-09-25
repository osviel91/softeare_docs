import type { ChangeProposal } from "./change-proposal";
import type { ResourceRevision, ResourceAuthorship } from "./resource-revision";
import type { ResourceType } from "./resource-id";

export type ResourceTrajectoryKind =
  | "RESOURCE_CREATED"
  | "RESOURCE_UPDATED"
  | "CHECKPOINT_CREATED"
  | "PROPOSAL_MERGED";

/** @deprecated Use ResourceTrajectoryKind. */
export type TrajectoryOperation = "CREATED" | "EDIT" | "METADATA" | "PROPOSAL" | "MERGE";

export interface TrajectoryEntry {
  id: string;
  projectId?: string;
  resourceId: string;
  resourcePath?: string;
  resourceType?: ResourceType;
  kind: ResourceTrajectoryKind;
  /** Compatibility label for the earlier presentation-only trajectory model. */
  operation: TrajectoryOperation;
  occurredAt: Date;
  actor: ResourceAuthorship | null;
  previousRevision?: number;
  baseRevision?: number;
  resultingRevision?: number;
  proposalId?: string;
  proposalTitle?: string;
  proposedBy?: ResourceAuthorship;
  mergedBy?: ResourceAuthorship;
  /** Compatibility shape for callers from the presentation-only phase. */
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
  resource?: { projectId?: string; path?: string; type?: ResourceType },
): ResourceTrajectory {
  const mergedByRevision = new Map(
    proposals
      .filter((proposal) => proposal.status === "merged" && proposal.mergedRevision !== undefined)
      .map((proposal) => [proposal.mergedRevision!, proposal]),
  );
  const entries: TrajectoryEntry[] = revisions.map((revision) => {
    const proposal = mergedByRevision.get(revision.revision);
    return proposal
      ? {
          id: `${resourceId}:proposal:${proposal.id}`,
          resourceId,
          ...resource,
          kind: "PROPOSAL_MERGED",
          operation: "MERGE",
          occurredAt: proposal.mergedAt ?? revision.createdAt,
          actor: proposal.mergeActor ?? null,
          previousRevision: revision.revision > 1 ? revision.revision - 1 : undefined,
          baseRevision: proposal.baseRevision,
          resultingRevision: revision.revision,
          proposalId: proposal.id,
          proposalTitle: proposal.title,
          proposedBy: proposal.author,
          mergedBy: proposal.mergeActor,
          proposal: {
            id: proposal.id,
            title: proposal.title,
            author: proposal.author,
            mergeActor: proposal.mergeActor,
          },
        }
      : {
          id: `${resourceId}:revision:${revision.revision}`,
          resourceId,
          ...resource,
          kind: revision.revision === 1 ? "RESOURCE_CREATED" : "RESOURCE_UPDATED",
          operation: revision.revision === 1 ? "CREATED" : "EDIT",
          occurredAt: revision.createdAt,
          actor: revision.authoredBy,
          previousRevision: revision.revision > 1 ? revision.revision - 1 : undefined,
          resultingRevision: revision.revision,
        };
  });
  for (const proposal of proposals) {
    if (proposal.status !== "merged" || proposal.mergedRevision === undefined) continue;
    if (revisions.some((revision) => revision.revision === proposal.mergedRevision)) continue;
    entries.push({
      id: `${resourceId}:proposal:${proposal.id}`,
      resourceId,
      ...resource,
      kind: "PROPOSAL_MERGED",
      operation: "MERGE",
      occurredAt: proposal.mergedAt ?? proposal.updatedAt,
      actor: proposal.mergeActor ?? null,
      baseRevision: proposal.baseRevision,
      resultingRevision: proposal.mergedRevision,
      proposalId: proposal.id,
      proposalTitle: proposal.title,
      proposedBy: proposal.author,
      mergedBy: proposal.mergeActor,
      proposal: {
        id: proposal.id,
        title: proposal.title,
        author: proposal.author,
        mergeActor: proposal.mergeActor,
      },
    });
  }

  entries.sort(
    (a, b) =>
      b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id),
  );
  return { resourceId, entries };
}

export function trajectoryActorLabel(actor: ResourceAuthorship | null): string {
  if (!actor) return "Unknown";
  if (actor.kind === "agent") return `Agent ${actor.agentId.slice(0, 8)}…`;
  if (actor.kind === "user") return actor.userId === "" ? "Unknown" : "Human";
  return "System";
}
