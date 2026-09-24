import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProposalReviewPanel } from "../../../src/features/proposals/ProposalReview";
import type {
  ServerApiClient,
  ServerChangeProposal,
} from "../../../src/workspace/server/api-client";

const proposal: ServerChangeProposal = {
  id: "proposal-1",
  resourceId: "resource-2",
  baseRevision: 2,
  proposedContent: "title Proposed",
  title: "Direct inbox proposal",
  author: { kind: "agent", agentId: "agent-12345678", subjectUserId: "user-1" },
  createdAt: "2026-09-24T10:00:00.000Z",
  updatedAt: "2026-09-24T10:00:00.000Z",
  status: "open",
  version: 1,
};

describe("ProposalReviewPanel", () => {
  it("resolves an inbox proposal without selected-resource context", async () => {
    const client = {
      getChangeProposal: vi.fn().mockResolvedValue(proposal),
      getChangeProposalDiff: vi.fn().mockResolvedValue({
        proposalId: proposal.id,
        resourceId: proposal.resourceId,
        type: "sequence-diagram",
        baseRevision: 2,
        currentRevision: 2,
        stale: false,
        baseContent: "title Base",
        proposedContent: proposal.proposedContent,
        changed: true,
        metadata: { changed: false, changes: [] },
        content: {
          available: true,
          changes: [],
          diagnostics: [],
          truncated: false,
          totalChanges: 0,
          returnedChanges: 0,
          representation: "sequence",
        },
        source: {
          changed: true,
          hunks: [],
          truncated: false,
          totalHunks: 0,
          returnedHunks: 0,
        },
        summary: {
          semanticChanges: 0,
          sourceHunks: 0,
          byKind: { added: 0, removed: 0, modified: 0 },
          byEntity: {},
        },
      }),
      getChangeProposalMergeAnalysis: vi
        .fn()
        .mockResolvedValue({ autoMergeable: true, conflicts: [] }),
      readResource: vi.fn().mockResolvedValue({
        resource: {
          id: "resource-2",
          projectId: "project-1",
          path: "target.seq",
          type: "sequence-diagram",
          revision: 2,
        },
        content: "title Current",
      }),
    } as unknown as ServerApiClient;

    render(
      <ProposalReviewPanel
        client={client}
        projectId="project-1"
        initialProposalId={proposal.id}
        onBack={vi.fn()}
        canMerge
      />,
    );

    expect(await screen.findByTestId("proposal-review")).toHaveTextContent(
      "Direct inbox proposal",
    );
    expect(client.getChangeProposal).toHaveBeenCalledWith(proposal.id);
    expect(screen.getByTestId("proposal-review")).toHaveTextContent(
      "target.seq",
    );
  });
});
