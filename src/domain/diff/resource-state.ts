import type { ChangeProposal } from "../workspace/change-proposal";
import type { ResourceMetadata } from "../workspace/resource-metadata";
import type { ResourceRevision } from "../workspace/resource-revision";
import type { ResourceType } from "../workspace/resource-id";

/** The complete logical state needed for a read-only comparison. */
export interface ResourceState {
  content: string;
  type: ResourceType;
  metadata?: ResourceMetadata;
}

export function resourceStateFromRevision(
  revision: ResourceRevision,
): ResourceState {
  return {
    content: revision.content,
    type: revision.type,
    ...(revision.metadata === undefined ? {} : { metadata: revision.metadata }),
  };
}

export function resourceStateFromProposal(
  proposal: ChangeProposal,
  type: ResourceType,
): ResourceState {
  return {
    content: proposal.proposedContent,
    type,
    ...(proposal.proposedMetadata === undefined
      ? {}
      : { metadata: proposal.proposedMetadata }),
  };
}
