import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ChangesInbox from "../../../src/features/proposals/ChangesInbox";
import type {
  ServerApiClient,
  ServerChangeProposal,
  ServerResource,
} from "../../../src/workspace/server/api-client";

const resource: ServerResource = {
  id: "resource-1",
  projectId: "project-1",
  path: "checkout.eventseq",
  type: "event-flow",
  revision: 4,
};

function proposal(
  status: ServerChangeProposal["status"],
  id: string,
): ServerChangeProposal {
  return {
    id,
    resourceId: resource.id,
    baseRevision: 3,
    proposedContent: "event Checkout",
    title: status === "open" ? "Add checkout event" : "Closed checkout change",
    author: {
      kind: "agent",
      agentId: "agent-123456789",
      subjectUserId: "user-1",
    },
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-24T10:00:00.000Z",
    status,
    version: 1,
  };
}

function clientFor(items: ServerChangeProposal[]): ServerApiClient {
  return {
    listResources: vi.fn().mockResolvedValue([resource]),
    listChangeProposals: vi.fn().mockResolvedValue(items),
    getChangeProposalDiff: vi.fn().mockResolvedValue({
      summary: { semanticChanges: 2, sourceHunks: 1 },
      currentRevision: 4,
    }),
    getChangeProposalMergeAnalysis: vi.fn().mockResolvedValue({
      autoMergeable: true,
      conflicts: [],
    }),
  } as unknown as ServerApiClient;
}

describe("ChangesInbox", () => {
  it("discovers open changes across resources and exposes provenance and revision context", async () => {
    render(
      <ChangesInbox
        client={clientFor([
          proposal("open", "open-1"),
          proposal("closed", "closed-1"),
        ])}
        projectId="project-1"
        onOpen={vi.fn()}
      />,
    );

    expect(await screen.findByText("Add checkout event")).toBeInTheDocument();
    expect(screen.getByTestId("changes-inbox")).toHaveTextContent(
      "checkout.eventseq",
    );
    expect(screen.getByTestId("changes-inbox")).toHaveTextContent("event-flow");
    expect(screen.getByTestId("changes-inbox")).toHaveTextContent(
      "Agent agent-12",
    );
    expect(screen.getByTestId("changes-inbox")).toHaveTextContent(
      "base r3 / current r4",
    );
    expect(
      screen.queryByText("Closed checkout change"),
    ).not.toBeInTheDocument();
  });

  it("keeps historical proposals out of the review inbox", async () => {
    render(
      <ChangesInbox
        client={clientFor([proposal("closed", "closed-1")])}
        projectId="project-1"
        onOpen={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(
        "No open changes — Canonical documentation is up to date.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Closed checkout change")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View history" })).toBeNull();
  });
});
