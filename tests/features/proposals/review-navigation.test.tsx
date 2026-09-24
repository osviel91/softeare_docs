import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ProposalReview from "../../../src/features/proposals/ProposalReview";
import { diffResources } from "../../../src/domain/diff/resource-diff";
import type { ResourceState } from "../../../src/domain/diff/resource-state";
import { reviewChangeTargets } from "../../../src/features/proposals/review-targets";
import type { ResourceMetadata } from "../../../src/domain/workspace/resource-metadata";
import type {
  ServerChangeProposal,
  ServerChangeProposalDiff,
  ServerResource,
} from "../../../src/workspace/server/api-client";

type Type = ServerChangeProposalDiff["type"];

function state(
  type: Type,
  content: string,
  metadata?: ResourceMetadata,
): ResourceState {
  return { content, type, ...(metadata ? { metadata } : {}) };
}

/**
 * Build a server diff from the real diff engine so the navigable targets under
 * test are the ones production would actually produce, not a hand-written list.
 */
function makeDiff(
  type: Type,
  base: string,
  proposed: string,
  baseMeta?: ResourceMetadata,
  proposedMeta?: ResourceMetadata,
): ServerChangeProposalDiff {
  const domain = diffResources(
    state(type, base, baseMeta),
    state(type, proposed, proposedMeta),
  );
  return {
    ...domain,
    proposalId: "proposal-1",
    resourceId: "resource-1",
    baseRevision: 1,
    currentRevision: 1,
    stale: false,
    type,
    baseContent: base,
    proposedContent: proposed,
  };
}

const proposal: ServerChangeProposal = {
  id: "proposal-1",
  resourceId: "resource-1",
  baseRevision: 1,
  proposedContent: "",
  title: "Review navigation",
  author: { kind: "system" },
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
  status: "open",
  version: 1,
};

const current: ServerResource = {
  id: "resource-1",
  projectId: "project-1",
  path: "review.seq",
  type: "sequence-diagram",
  revision: 1,
};

function renderReview(diff: ServerChangeProposalDiff) {
  return render(
    <ProposalReview
      proposal={proposal}
      diff={diff}
      analysis={{
        baseRevision: diff.baseRevision,
        currentRevision: diff.currentRevision,
        proposalVersion: 1,
        stale: false,
        conflicted: false,
        status: "ok",
        autoMergeable: false,
        compatibleChanges: [],
        conflicts: [],
        diagnostics: [],
        summary: "",
      }}
      current={{ ...current, type: diff.type }}
      onBack={vi.fn()}
      canMerge={false}
      onMerge={vi.fn()}
    />,
  );
}

/** The stable target id the focused review row currently points at. */
function focusedTargetId(): string | null {
  const element = document.activeElement;
  return element instanceof HTMLElement
    ? element.getAttribute("data-review-target")
    : null;
}

/** The canonical ordered target list the UI is required to navigate. */
function expectedTargetIds(diff: ServerChangeProposalDiff): string[] {
  return reviewChangeTargets(diff.metadata.changes, diff.content.changes).map(
    (target) => target.id,
  );
}

/**
 * Walk the navigator to the end and back, recording the focused target id after
 * every step. Returns both the canonical list and both traversals so a caller
 * can assert identity, not just that a counter moved.
 */
function navigateAll(diff: ServerChangeProposalDiff) {
  const expected = expectedTargetIds(diff);
  const forward = [focusedTargetId()];
  for (let index = 1; index < expected.length; index += 1) {
    fireEvent.click(screen.getByTestId("change-next"));
    forward.push(focusedTargetId());
  }
  const backward = [focusedTargetId()];
  for (let index = expected.length - 2; index >= 0; index -= 1) {
    fireEvent.click(screen.getByTestId("change-previous"));
    backward.push(focusedTargetId());
  }
  return { expected, forward, backward };
}

describe("proposal review change navigation", () => {
  it("renders no navigator when there are zero targets", () => {
    const diff = makeDiff(
      "sequence-diagram",
      "participant A\nparticipant B\nA -> B: one",
      "participant A\nparticipant B\nA -> B: one",
    );
    expect(expectedTargetIds(diff)).toHaveLength(0);
    renderReview(diff);
    expect(screen.queryByTestId("change-position")).toBeNull();
    expect(screen.queryByTestId("change-next")).toBeNull();
    expect(screen.queryByTestId("change-previous")).toBeNull();
  });

  it("renders no previous/next pagination for a single target", () => {
    const diff = makeDiff(
      "markdown-document",
      "# One\n\nold",
      "# One\n\nnew",
    );
    expect(expectedTargetIds(diff)).toHaveLength(1);
    renderReview(diff);
    expect(screen.queryByTestId("change-position")).toBeNull();
    expect(screen.queryByTestId("change-next")).toBeNull();
  });

  it("shows the shared total and links every index to a real target", () => {
    const diff = makeDiff(
      "sequence-diagram",
      "participant A\nparticipant B\nA -> B: one",
      "participant A\nparticipant C\nA -> C: two\nA -> C: three",
    );
    renderReview(diff);
    const expected = expectedTargetIds(diff);
    // Metadata first, then the grouped semantic targets — a hand-checked set,
    // so a change to the canonical collection is caught here too.
    expect(expected).toEqual([
      "participant:B",
      "participant:C",
      "interaction:message:1-0",
      "interaction:message:0-1",
      "interaction:message:0-2",
    ]);
    expect(screen.getByTestId("change-position")).toHaveTextContent(
      `1 of ${expected.length}`,
    );
  });

  describe.each([
    [
      "sequence",
      makeDiff(
        "sequence-diagram",
        "participant A\nparticipant B\nA -> B: one",
        "participant A\nparticipant C\nA -> C: two\nA -> C: three",
        { description: "old" },
        { description: "new" },
      ),
    ],
    [
      "event flow",
      makeDiff(
        "event-flow",
        [
          "event OrderCreated",
          "event OrderDeleted",
          "producer Orders",
          "consumer Billing",
          "Orders publishes OrderCreated",
          "Billing consumes OrderDeleted",
        ].join("\n"),
        [
          "event OrderCreated",
          "event OrderShipped",
          "producer Orders",
          "consumer Billing",
          "Orders publishes OrderCreated",
          "Billing consumes OrderShipped",
        ].join("\n"),
      ),
    ],
    [
      "markdown",
      makeDiff(
        "markdown-document",
        "# One\n\nalpha\n\n# Two\n\nbeta",
        "# One\n\nALPHA\n\n# Two\n\nBETA",
      ),
    ],
  ])("%s", (_name, diff: ServerChangeProposalDiff) => {
    it("navigates 1 -> N and N -> 1 through the same target ids", () => {
      renderReview(diff);
      const expected = expectedTargetIds(diff);
      expect(expected.length).toBeGreaterThan(1);

      const { forward, backward } = navigateAll(diff);

      expect(forward).toEqual(expected);
      expect(backward).toEqual([...expected].reverse());
      // Ends back at the first target.
      expect(focusedTargetId()).toBe(expected[0]);
    });

    it("disables previous at the start and next at the end", () => {
      renderReview(diff);
      const expected = expectedTargetIds(diff);
      const previous = screen.getByTestId("change-previous");
      const next = screen.getByTestId("change-next");

      expect(previous).toBeDisabled();
      expect(next).not.toBeDisabled();

      for (let index = 1; index < expected.length; index += 1) {
        fireEvent.click(next);
      }

      expect(next).toBeDisabled();
      expect(previous).not.toBeDisabled();
      expect(screen.getByTestId("change-position")).toHaveTextContent(
        `${expected.length} of ${expected.length}`,
      );
    });
  });
});
