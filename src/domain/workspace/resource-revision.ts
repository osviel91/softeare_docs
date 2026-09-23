import type { ResourceMetadata } from "./resource-metadata";
import type { ResourceType } from "./resource-id";

/** Provenance of a server-side resource mutation. */
export type ResourceAuthorship =
  | { kind: "user"; userId: string; subjectUserId: string }
  | {
      kind: "agent";
      agentId: string;
      credentialId?: string;
      subjectUserId: string;
    }
  | { kind: "system"; subjectUserId?: string };

/** An immutable snapshot of a resource's logical document state. */
export interface ResourceRevision {
  resourceId: string;
  revision: number;
  content: string;
  type: ResourceType;
  metadata?: ResourceMetadata;
  authoredBy: ResourceAuthorship;
  createdAt: Date;
}
