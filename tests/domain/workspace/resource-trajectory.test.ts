import { describe, expect, it } from "vitest";
import {
  resourceTrajectoryOf,
  trajectoryActorLabel,
} from "../../../src/domain/workspace/resource-trajectory";

describe("resource trajectory", () => {
  it("projects merge provenance without inventing a revision", () => {
    const trajectory = resourceTrajectoryOf(
      "resource-1",
      [
        {
          resourceId: "resource-1",
          revision: 1,
          content: "old",
          type: "sequence-diagram",
          authoredBy: { kind: "system" },
          createdAt: new Date("2026-09-22T17:30:00Z"),
        },
      ],
      [
        {
          id: "proposal-1",
          resourceId: "resource-1",
          baseRevision: 1,
          proposedContent: "new",
          title: "Correct architecture",
          author: {
            kind: "agent",
            agentId: "agent-12345678",
            subjectUserId: "u1",
          },
          mergeActor: { kind: "user", userId: "u1", subjectUserId: "u1" },
          createdAt: new Date("2026-09-24T23:20:00Z"),
          updatedAt: new Date("2026-09-24T23:26:00Z"),
          mergedAt: new Date("2026-09-24T23:26:00Z"),
          mergedRevision: 2,
          status: "merged",
          version: 1,
        },
      ],
    );

    expect(trajectory.entries[0]).toMatchObject({
      operation: "MERGE",
      baseRevision: 1,
      resultingRevision: 2,
    });
    expect(trajectory.entries).toHaveLength(2);
    expect(trajectoryActorLabel(null)).toBe("Unknown");
    expect(
      trajectoryActorLabel({
        kind: "agent",
        agentId: "123456789",
        subjectUserId: "u",
      }),
    ).toBe("Agent 12345678…");
  });
});
