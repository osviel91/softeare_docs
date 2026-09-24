import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import ProposalReview from "../../../src/features/proposals/ProposalReview";
import { diffResources } from "../../../src/domain/diff/resource-diff";
import type { ServerChangeProposalDiff } from "../../../src/workspace/server/api-client";

const BASE = "title Flow\nparticipant A\nparticipant B\nA -> B: one";
const PROPOSED = "title Flow\nparticipant A\nparticipant C\nA -> C: two";

function makeDiff(): ServerChangeProposalDiff {
  const domain = diffResources(
    { content: BASE, type: "sequence-diagram" },
    { content: PROPOSED, type: "sequence-diagram" },
  );
  return {
    ...domain,
    proposalId: "proposal-1",
    resourceId: "resource-1",
    baseRevision: 1,
    currentRevision: 1,
    stale: false,
    type: "sequence-diagram",
    baseContent: BASE,
    proposedContent: PROPOSED,
  };
}

/** jsdom reports every element as 0x0; give the panes a real box. */
function stubPaneSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function renderCompare() {
  render(
    <ProposalReview
      proposal={{
        id: "proposal-1",
        resourceId: "resource-1",
        baseRevision: 1,
        proposedContent: PROPOSED,
        title: "Linked camera",
        author: { kind: "system" },
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
        status: "open",
        version: 1,
      }}
      diff={makeDiff()}
      analysis={{
        baseRevision: 1,
        currentRevision: 1,
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
      current={{
        id: "resource-1",
        projectId: "project-1",
        path: "review.seq",
        type: "sequence-diagram",
        revision: 1,
      }}
      onBack={vi.fn()}
      canMerge={false}
      onMerge={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  const [base, proposed] = screen.getAllByTestId("diagram-viewport");
  return { base, proposed };
}

const zoomOf = (viewport: HTMLElement) =>
  within(viewport).getByTestId("zoom-level").textContent;
const transformOf = (viewport: HTMLElement) =>
  within(viewport).getByTestId("preview-svg").style.transform;

describe("linked camera in proposal compare", () => {
  beforeEach(() => stubPaneSize(800, 600));
  afterEach(() => vi.restoreAllMocks());

  it("lets both panes drive each other while remaining interactive", () => {
    const { base, proposed } = renderCompare();
    // The two panes settle on the same camera once linking kicks in.
    expect(zoomOf(base)).toBe("100%");
    expect(zoomOf(proposed)).toBe("100%");

    // 1-4: manipulate BASE, PROPOSED follows.
    fireEvent.click(within(base).getByTestId("zoom-in"));
    expect(zoomOf(base)).not.toBe("100%");
    expect(zoomOf(proposed)).toBe(zoomOf(base));

    // 5-7: manipulate PROPOSED, BASE follows.
    const proposedBefore = zoomOf(proposed);
    fireEvent.click(within(proposed).getByTestId("zoom-in"));
    expect(zoomOf(proposed)).not.toBe(proposedBefore);
    expect(zoomOf(base)).toBe(zoomOf(proposed));

    // Panning follows too, so the link is a camera sync and not a zoom-only hack.
    const baseTransform = transformOf(base);
    const proposedTransform = transformOf(proposed);
    fireEvent.keyDown(within(base).getByTestId("viewport-pane"), {
      key: "ArrowRight",
    });
    expect(transformOf(base)).not.toBe(baseTransform);
    expect(transformOf(proposed)).not.toBe(proposedTransform);
  });

  it("keeps every viewport control usable while linked", () => {
    const { base, proposed } = renderCompare();

    fireEvent.click(within(base).getByTestId("zoom-in"));
    expect(zoomOf(base)).toBe(zoomOf(proposed));

    // 1:1 on BASE resets both cameras through synchronization.
    fireEvent.click(within(base).getByTestId("zoom-reset"));
    expect(zoomOf(base)).toBe("100%");
    expect(zoomOf(proposed)).toBe("100%");

    // Fit on PROPOSED also propagates, and does not throw or lock the pane.
    fireEvent.click(within(proposed).getByTestId("zoom-fit"));
    expect(zoomOf(base)).toBe(zoomOf(proposed));

    // Zoom out on PROPOSED after that still works.
    const proposedBefore = zoomOf(proposed);
    fireEvent.click(within(proposed).getByTestId("zoom-out"));
    expect(zoomOf(proposed)).not.toBe(proposedBefore);
    expect(zoomOf(base)).toBe(zoomOf(proposed));
  });

  it("stops synchronizing when unlinked and preserves both cameras", () => {
    const { base, proposed } = renderCompare();

    fireEvent.click(within(base).getByTestId("zoom-in"));
    const linkedZoom = zoomOf(base);
    expect(zoomOf(proposed)).toBe(linkedZoom);

    // 10: turn linking off; cameras must not move.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /link pan and zoom/i }),
    );
    expect(zoomOf(base)).toBe(linkedZoom);
    expect(zoomOf(proposed)).toBe(linkedZoom);

    // 11-12: manipulate one viewport; the other no longer follows.
    fireEvent.click(within(base).getByTestId("zoom-in"));
    expect(zoomOf(base)).not.toBe(linkedZoom);
    expect(zoomOf(proposed)).toBe(linkedZoom);

    // Re-enabling does not reset either camera; the next interaction leads.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /link pan and zoom/i }),
    );
    expect(zoomOf(base)).not.toBe(linkedZoom);
    expect(zoomOf(proposed)).toBe(linkedZoom);

    fireEvent.click(within(proposed).getByTestId("zoom-in"));
    expect(zoomOf(base)).toBe(zoomOf(proposed));
  });
});
