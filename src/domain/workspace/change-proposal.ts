import type { ResourceAuthorship } from "./resource-revision";
import type { ResourceMetadata } from "./resource-metadata";

export type ChangeProposalStatus = "draft" | "open" | "closed";

/** An isolated candidate resource state based on one immutable revision. */
export interface ChangeProposal {
  id: string;
  resourceId: string;
  baseRevision: number;
  proposedContent: string;
  proposedMetadata?: ResourceMetadata;
  title: string;
  description?: string;
  author: ResourceAuthorship;
  createdAt: Date;
  updatedAt: Date;
  status: ChangeProposalStatus;
  version: number;
}
