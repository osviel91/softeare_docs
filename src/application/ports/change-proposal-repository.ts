import type {
  ChangeProposal,
  ChangeProposalStatus,
} from "../../domain/workspace/change-proposal";
import type { ResourceAuthorship } from "../../domain/workspace/resource-revision";
import type { ResourceMetadata } from "../../domain/workspace/resource-metadata";

export interface NewChangeProposal {
  resourceId: string;
  baseRevision: number;
  proposedContent: string;
  proposedMetadata?: ResourceMetadata;
  title: string;
  description?: string;
  author: ResourceAuthorship;
}

export interface ChangeProposalChanges {
  proposedContent?: string;
  proposedMetadata?: ResourceMetadata;
  title?: string;
  description?: string;
}

export interface ChangeProposalRepository {
  create(input: NewChangeProposal): Promise<ChangeProposal>;
  get(id: string): Promise<ChangeProposal | null>;
  list(resourceId: string): Promise<ChangeProposal[]>;
  update(
    id: string,
    expectedVersion: number,
    changes: ChangeProposalChanges,
  ): Promise<ChangeProposal | null>;
  transition(
    id: string,
    expectedVersion: number,
    from: ChangeProposalStatus,
    to: ChangeProposalStatus,
  ): Promise<ChangeProposal | null>;
}
