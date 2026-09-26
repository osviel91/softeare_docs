import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TraceExplorer from "../../../src/features/preview/TraceExplorer";
import { createProjectIndexer, type ProjectSourceFile } from "../../../src/domain/project/indexer";
import type { ProjectMetadata } from "../../../src/domain/workspace/metadata";
import type { ResourceDescriptor } from "../../../src/domain/project/project-index";

function resource(id: string, path: string, type: ResourceDescriptor["type"]): ProjectSourceFile {
  return { descriptor: { id, projectId: "p", path, type, title: path }, content: "" };
}

function project(files: ProjectSourceFile[], content: Record<string, string>): ReturnType<ReturnType<typeof createProjectIndexer>["update"]> {
  const metadata: ProjectMetadata = {
    format: "software-docs",
    version: 1,
    resources: files.map(({ descriptor }) => ({ id: descriptor.id, path: descriptor.path, type: descriptor.type, title: descriptor.title })),
    semanticMessages: [
      { id: "raised", name: "Raised", kind: "event" },
      { id: "next", name: "Next", kind: "event" },
    ],
  };
  return createProjectIndexer().update("p", files.map((file) => ({ ...file, content: content[file.descriptor.id] ?? file.content })), metadata);
}

describe("TraceExplorer", () => {
  it("renders authoritative, cycle, and unknown trace facts without duplicating nodes", () => {
    const index = project(
      [resource("flow", "cycle.eventseq", "event-flow"), resource("seq", "cycle.seq", "sequence-diagram")],
      {
        flow: "event Raised messageRef raised\nevent Next messageRef next\nhandler H\nRaised handled by H\nH causes Next\nNext handled by H\nH causes Raised",
        seq: "participant A\nparticipant B\nA ->> B: Raised\nsemantic event publish Raised messageRef raised",
      },
    );
    render(<TraceExplorer index={index} start={{ messageId: "raised" }} onClose={vi.fn()} onOpenResource={vi.fn()} />);
    expect(screen.getByTestId("trace-explorer")).toBeTruthy();
    expect(screen.getByText("sequence occurrence")).toBeTruthy();
    expect(screen.getByText("handler")).toBeTruthy();
    expect(document.querySelector(".trace-explorer__edge--cycle")).toBeTruthy();
  });

  it("keeps an unbound exact occurrence as candidate knowledge", () => {
    const index = project(
      [resource("seq", "candidate.seq", "sequence-diagram")],
      { seq: "participant A\nparticipant B\nA ->> B: Raised\nsemantic event publish Raised" },
    );
    render(<TraceExplorer index={index} start={{ resourceId: "seq", name: "Raised", step: 1 }} onClose={vi.fn()} onOpenResource={vi.fn()} />);
    expect(screen.getByTestId("trace-resolution")).toHaveTextContent("Candidate starting point");
    expect(screen.getByText(/no explicit semantic identity binding/i)).toBeTruthy();
  });
});
