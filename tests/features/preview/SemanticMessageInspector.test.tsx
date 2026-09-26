import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SemanticMessageInspector from "../../../src/features/preview/SemanticMessageInspector";
import { analyze } from "../../../src/language/analyze";
import { buildProjectIndex } from "../../../src/domain/project/project-index";
import { analyzeResource } from "../../../src/domain/project/resource-analysis";
import { createEmptyMetadata } from "../../../src/domain/workspace/metadata";
import { validateProject } from "../../../src/domain/project/validate";
import { nodeIdOf } from "../../../src/domain/diagram/node-id";
import { semanticMessagesOf } from "../../../src/domain/diagram/semantic-messages";

describe("SemanticMessageInspector", () => {
  it("shows only authoritative bindings and navigates to other resources", () => {
    const sequenceSource = "participant A\nparticipant B\nA -> B: Created\nsemantic event publish Created messageRef msg-created\n";
    const flowSource = "event Created messageRef msg-created\n";
    const metadata = {
      ...createEmptyMetadata(),
      resources: [
        { id: "seq", path: "created.seq", type: "sequence-diagram" as const },
        { id: "flow", path: "created.eventseq", type: "event-flow" as const },
      ],
      semanticMessages: [{ id: "msg-created", name: "Created", kind: "event" as const }],
    };
    const sequence = analyze(sequenceSource).ast!;
    const analyses = [
      analyzeResource({ id: "seq", projectId: "p", path: "created.seq", type: "sequence-diagram", title: "created.seq" }, sequenceSource),
      analyzeResource({ id: "flow", projectId: "p", path: "created.eventseq", type: "event-flow", title: "created.eventseq" }, flowSource),
    ];
    const index = buildProjectIndex("p", analyses, metadata, (core) => validateProject(core, analyses.flatMap((entry) => entry.diagnostics), metadata));
    const nodeId = nodeIdOf("message", semanticMessagesOf(sequence)[0].range);
    const open = vi.fn();
    render(<SemanticMessageInspector index={index} sequence={sequence} activeResourceId="seq" activeNodeId={nodeId} onOpenResource={open} />);
    expect(screen.getAllByText("Created").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "created.eventseq" }));
    expect(open).toHaveBeenCalledWith("flow", expect.any(String));
  });
});
