import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ProposalReview from "../../../src/features/proposals/ProposalReview";
import { diffResources } from "../../../src/domain/diff/resource-diff";
import type { ResourceState } from "../../../src/domain/diff/resource-state";
import {
  navigableTargets,
  reviewChangeTargets,
} from "../../../src/features/proposals/review-targets";
import type {
  ServerChangeProposal,
  ServerChangeProposalDiff,
  ServerResource,
} from "../../../src/workspace/server/api-client";

/**
 * Deterministic development fixture: one sequence proposal containing every
 * change category at once — a message text change, a direction swap, an
 * endpoint change, an added interaction, a removed interaction, and an added
 * and a removed participant. Use it to inspect review decoration and to drive
 * Previous/Next by hand as well as in the assertions below.
 */
const MULTI_BASE = [
  "participant A",
  "participant B",
  "participant C",
  "A -> B: one",
  "A -> B: editable text",
  "A -> B: reverse me",
  "A -> B: retarget me",
  "A -> B: keep",
  "A -> C: retiring call",
].join("\n");

const MULTI_PROPOSED = [
  "participant A",
  "participant B",
  "participant D",
  "A -> B: one",
  "A -> B: edited text",
  "B -> A: reverse me",
  "A -> D: retarget me",
  "A -> B: keep",
  "A -> D: fresh call",
].join("\n");

function state(content: string): ResourceState {
  return { content, type: "sequence-diagram" };
}

function makeDiff(base: string, proposed: string): ServerChangeProposalDiff {
  const domain = diffResources(state(base), state(proposed));
  return {
    ...domain,
    proposalId: "proposal-1",
    resourceId: "resource-1",
    baseRevision: 1,
    currentRevision: 1,
    stale: false,
    type: "sequence-diagram",
    baseContent: base,
    proposedContent: proposed,
  };
}

const proposal: ServerChangeProposal = {
  id: "proposal-1",
  resourceId: "resource-1",
  baseRevision: 1,
  proposedContent: MULTI_PROPOSED,
  title: "Multi-change sequence review",
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
      current={current}
      onBack={vi.fn()}
      canMerge={false}
      onMerge={vi.fn()}
    />,
  );
}

function compareTargetIds(diff: ServerChangeProposalDiff): string[] {
  return navigableTargets(
    "compare",
    reviewChangeTargets(diff.metadata.changes, diff.content.changes),
    diff.source,
    "sequence",
  ).map((target) => target.id);
}

describe("sequence proposal review fixture", () => {
  it("derives one navigable target per semantic change in Compare", () => {
    const diff = makeDiff(MULTI_BASE, MULTI_PROPOSED);
    expect(compareTargetIds(diff)).toEqual([
      "participant:C",
      "participant:D",
      "interaction:message:2-2",
      "interaction:message:3-3",
      "interaction:message:4-4",
      "interaction:message:6-0",
      "interaction:message:0-6",
    ]);
  });

  it("decorates every change in the side where it is rendered", () => {
    const diff = makeDiff(MULTI_BASE, MULTI_PROPOSED);
    const { container } = renderReview(diff);
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    const count = (id: string) =>
      container.querySelectorAll(`[data-review-change="${id}"]`).length;

    // Removed changes exist only in BASE, added only in PROPOSED.
    expect(count("participant:C")).toBe(1);
    expect(count("interaction:message:6-0")).toBe(1);
    expect(count("participant:D")).toBe(1);
    expect(count("interaction:message:0-6")).toBe(1);
    // Modifications are decorated on both sides.
    for (const id of [
      "interaction:message:2-2",
      "interaction:message:3-3",
      "interaction:message:4-4",
    ])
      expect(count(id)).toBe(2);
  });

  it("reveals each Compare target as the reviewer presses Next", () => {
    const diff = makeDiff(MULTI_BASE, MULTI_PROPOSED);
    const expected = compareTargetIds(diff);
    const { container } = renderReview(diff);
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    const activeId = () =>
      container
        .querySelector(".review-change--active")
        ?.getAttribute("data-review-change") ?? null;

    // The first target is revealed as soon as Compare opens.
    expect(activeId()).toBe(expected[0]);
    expect(
      container.querySelector(`[data-review-change="${expected[0]}"]`),
    ).not.toBeNull();

    for (let index = 1; index < expected.length; index += 1) {
      fireEvent.click(screen.getByTestId("change-next"));
      expect(screen.getByTestId("change-position")).toHaveTextContent(
        `${index + 1} of ${expected.length}`,
      );
      // Selection changed, and it resolves to a real rendered decoration.
      expect(activeId()).toBe(expected[index]);
      expect(
        container.querySelector(`[data-review-change="${expected[index]}"]`),
      ).not.toBeNull();
    }

    // The reveal API centered the viewport on a decoration; jsdom reports a
    // zero-size target and pane, so the centered transform is the observable
    // proof that focus ran rather than only the class toggle.
    const panes = container.querySelectorAll<HTMLElement>(
      '[data-testid="preview-svg"]',
    );
    expect(panes.length).toBeGreaterThan(0);
    expect(
      Array.from(panes).some((pane) =>
        pane.style.transform.startsWith("translate(0.5px, 0.5px)"),
      ),
    ).toBe(true);
  });

  it("navigates source hunks in Source mode", () => {
    const diff = makeDiff(MULTI_BASE, MULTI_PROPOSED);
    const { container } = renderReview(diff);
    fireEvent.click(screen.getByRole("button", { name: "Source" }));

    const activeId = () =>
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute("data-review-target")
        : null;
    const hunks = container.querySelectorAll("[data-review-target^='source:hunk:']");
    expect(hunks.length).toBeGreaterThan(0);
    expect(activeId()).toBe("source:hunk:0");

    if (hunks.length > 1) {
      fireEvent.click(screen.getByTestId("change-next"));
      expect(activeId()).toBe("source:hunk:1");
    }
  });
});
