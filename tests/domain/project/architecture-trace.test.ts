import { describe, expect, it } from "vitest";
import { createProjectIndexer, type ProjectSourceFile } from "../../../src/domain/project/indexer";
import { traceArchitecture, traceArchitectureQuery } from "../../../src/domain/project/architecture-trace";
import type { ProjectMetadata } from "../../../src/domain/workspace/metadata";
import type { ResourceDescriptor } from "../../../src/domain/project/project-index";

const identities = [
  { id: "raised", name: "Raised", kind: "event" as const },
  { id: "next", name: "Next", kind: "event" as const },
  { id: "save", name: "SaveCommand", kind: "command" as const },
  { id: "retry", name: "RetryCommand", kind: "command" as const },
  { id: "a", name: "A", kind: "event" as const },
  { id: "b", name: "B", kind: "event" as const },
];

function descriptor(id: string, path: string, type: ResourceDescriptor["type"]): ResourceDescriptor {
  return { id, projectId: "p", path, type, title: path };
}

function project(files: ProjectSourceFile[], metadata: Partial<ProjectMetadata> = {}) {
  return createProjectIndexer().update("p", files, {
    format: "software-docs",
    version: 1,
    resources: files.map(({ descriptor: entry }) => ({ path: entry.path, type: entry.type, title: entry.title, id: entry.id })),
    semanticMessages: identities,
    ...metadata,
  });
}

function source(path: string, content: string, type: ResourceDescriptor["type"] = "event-flow"): ProjectSourceFile {
  return { descriptor: descriptor(path, path, type), content };
}

describe("traceArchitecture", () => {
  it("resolves an exact occurrence and preserves unbound starts as candidates", () => {
    const index = project([
      source("execution", [
        "participant API",
        "participant Worker",
        "API ->> Worker: Raised",
        "semantic event publish Raised messageRef raised",
      ].join("\n"), "sequence-diagram"),
    ]);
    const bound = traceArchitectureQuery(index, { resourceId: "execution", name: "Raised", step: 1 });
    expect(bound.resolution.status).toBe("authoritative");
    expect(bound.trace?.selected).toBe("identity:raised");

    const unbound = project([
      source("execution", [
        "participant API",
        "participant Worker",
        "API ->> Worker: Raised",
        "semantic event publish Raised",
      ].join("\n"), "sequence-diagram"),
    ]);
    const candidate = traceArchitectureQuery(unbound, { resourceId: "execution", name: "Raised", step: 1 });
    expect(candidate.resolution.status).toBe("candidate");
    expect(candidate.resolution.reason).toBe("unbound-start");
    expect(candidate.trace).toBeNull();
  });

  it("indexes authoritative fan-out, fan-in, effects, and sequence occurrences", () => {
    const index = project([
      source("flow", [
        "event Raised messageRef raised",
        "event Next messageRef next",
        "event SaveCommand { messageRef save",
        "  kind: command",
        "}",
        "handler Transactions",
        "handler Accounts",
        "Raised handled by Transactions",
        "Raised handled by Accounts",
        "Transactions causes Next",
        "Accounts causes SaveCommand",
        "effect persist on Transactions kind state: save",
      ].join("\n")),
      source("execution", [
        "participant API",
        "participant Worker",
        "API ->> Worker: Raised",
        "semantic event publish Raised messageRef raised",
      ].join("\n"), "sequence-diagram"),
    ]);

    expect(index.eventFlowCausality).toHaveLength(1);
    const trace = traceArchitecture(index, { messageId: "raised", direction: "downstream" });
    expect(trace.nodes.filter((node) => node.kind === "handler").map((node) => node.label)).toEqual(["Accounts", "Transactions"]);
    expect(trace.nodes.some((node) => node.kind === "effect" && node.label === "save")).toBe(true);
    expect(trace.nodes.some((node) => node.kind === "causal-message" && node.label === "Next")).toBe(true);
    expect(trace.nodes.some((node) => node.kind === "causal-message" && node.label === "SaveCommand")).toBe(true);
    expect(trace.nodes.some((node) => node.kind === "execution-occurrence")).toBe(true);
    expect(trace.edges.filter((edge) => edge.kind !== "unknown-continuation").every((edge) => edge.confidence === "authoritative")).toBe(true);
  });

  it("supports upstream traversal and convergence without manufacturing an orchestrator", () => {
    const index = project([source("flow", [
      "event A messageRef a", "event B messageRef b", "event Next messageRef next",
      "handler HA", "handler HB", "handler Delivery",
      "A handled by HA", "HA causes Next",
      "B handled by HB", "HB causes Next",
      "Next handled by Delivery",
    ].join("\n"))]);
    const trace = traceArchitecture(index, { messageId: "next", direction: "upstream" });
    expect(trace.nodes.filter((node) => node.kind === "handler").map((node) => node.label)).toEqual(["HA", "HB"]);
    expect(trace.nodes.filter((node) => node.kind === "causal-message").map((node) => node.label)).toEqual(["Next", "A", "B"]);
    expect(trace.nodes.filter((node) => node.kind === "handler" && node.label === "HA")).toHaveLength(1);
  });

  it("unions both directions and keeps effects as unordered siblings", () => {
    const index = project([source("flow", [
      "event A messageRef a", "event B messageRef b", "event C messageRef next",
      "handler H", "A handled by H", "H causes B", "B handled by H", "H causes C",
      "effect first on H: first", "effect second on H: second",
    ].join("\n"))]);
    const trace = traceArchitecture(index, { messageId: "b", direction: "both" });
    expect(trace.nodes.some((node) => node.kind === "causal-message" && node.label === "A")).toBe(true);
    expect(trace.nodes.some((node) => node.kind === "causal-message" && node.label === "C")).toBe(true);
    const effectIds = trace.nodes.filter((node) => node.kind === "effect").map((node) => node.id);
    expect(effectIds).toHaveLength(2);
    expect(trace.edges.some((edge) => effectIds.includes(edge.from) && effectIds.includes(edge.to))).toBe(false);
  });

  it("keeps cycles as back-edges with cycle-reference metadata", () => {
    const index = project([source("cycle", [
      "event A messageRef a", "event B messageRef b", "handler HA", "handler HB",
      "A handled by HA", "HA causes B", "B handled by HB", "HB causes A",
    ].join("\n"))]);
    const trace = traceArchitecture(index, { messageId: "a", direction: "downstream" });
    expect(trace.nodes.some((node) => (node.kind as string) === "cycle")).toBe(false);
    expect(trace.edges.some((edge) => edge.cycleReference)).toBe(true);
    expect(trace.truncated).toBe(false);
  });

  it("does not infer identity from names and keeps candidates terminal", () => {
    const relationship = { kind: "complementary-view" as const, sourceId: "authoritative", targetId: "execution" };
    const index = project([
      source("authoritative", "event Raised messageRef raised\nhandler H\nRaised handled by H\nH causes Next"),
      source("candidate", "event Raised\nhandler Candidate\nRaised handled by Candidate\nCandidate causes SaveCommand"),
      source("execution", "participant A\nparticipant B\nA ->> B: Raised\nsemantic event publish Raised", "sequence-diagram"),
    ], { relationships: [relationship] });
    const authoritative = traceArchitecture(index, { messageId: "raised" });
    expect(authoritative.nodes.filter((node) => node.confidence === "candidate")).toHaveLength(0);
    expect(authoritative.nodes.some((node) => node.label === "Candidate")).toBe(false);

    const enriched = traceArchitecture(index, { messageId: "raised", includeCandidates: true });
    const candidates = enriched.nodes.filter((node) => node.confidence === "candidate");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((node) => node.label === "Candidate")).toBe(false);
    for (const candidate of candidates) {
      expect(enriched.edges.some((edge) => edge.from === candidate.id && edge.confidence === "authoritative")).toBe(false);
    }
    expect(index.eventFlowCausality).toHaveLength(2);
    expect(index.resources).toHaveLength(3);
  });

  it("reports structured unknown boundaries and neutral resolution candidates", () => {
    const index = project([
      source("bound", "event Raised messageRef raised"),
      source("legacy", "event Raised\n"),
      source("execution", "participant A\nparticipant B\nA ->> B: Raised\nsemantic event publish Raised", "sequence-diagram"),
    ]);
    const trace = traceArchitecture(index, { messageId: "raised" });
    const boundary = trace.nodes.find((node) => node.kind === "unknown-boundary");
    expect(boundary).toMatchObject({ reason: "no-causal-representation" });
    expect(boundary && boundary.kind === "unknown-boundary" ? boundary.resolutionCandidates.length : 0).toBe(2);
    expect(JSON.stringify(boundary)).toContain("event-flow-message");
  });

  it("keeps unbound outputs unknown and exposes recovery only when requested", () => {
    const index = project([source("recovery", [
      "event Raised messageRef raised",
      "event RetryCommand { kind: command",
      "}",
      "handler H",
      "Raised handled by H",
      "H causes RetryCommand",
      "failure failed on handler H",
      "retry again for failed {",
      "  mechanism: handler",
      "  target: same-execution",
      "}",
    ].join("\n"))]);
    const normal = traceArchitecture(index, { messageId: "raised" });
    expect(normal.nodes.some((node) => node.kind === "failure" || node.kind === "retry")).toBe(false);
    expect(normal.nodes.some((node) => node.kind === "unknown-boundary" && node.reason === "unbound-output")).toBe(true);

    const recovery = traceArchitecture(index, { messageId: "raised", includeRecovery: true });
    expect(recovery.nodes.some((node) => node.kind === "failure")).toBe(true);
    expect(recovery.nodes.some((node) => node.kind === "retry")).toBe(true);
    expect(recovery.edges.some((edge) => edge.kind === "retry-initiates-causal-message")).toBe(false);
  });

  it("follows only an explicit structured retry continuation", () => {
    const index = project([source("recovery", [
      "event Raised messageRef raised",
      "event RetryCommand { messageRef retry",
      "  kind: command",
      "}",
      "handler H",
      "Raised handled by H",
      "H causes RetryCommand",
      "failure failed on handler H",
      "retry again for failed {",
      "  mechanism: scheduler",
      "  target: new-message",
      "  initiates: RetryCommand",
      "}",
    ].join("\n"))]);
    const trace = traceArchitecture(index, { messageId: "raised", includeRecovery: true });
    expect(trace.edges.some((edge) => edge.kind === "retry-initiates-causal-message" && edge.confidence === "authoritative")).toBe(true);
  });

  it.each([
    ["depth-limit", { maxDepth: 0 }],
    ["node-limit", { maxNodes: 2 }],
  ] as const)("uses a structured %s boundary", (reason, options) => {
    const index = project([source("flow", "event Raised messageRef raised\nhandler H\nRaised handled by H")]);
    const trace = traceArchitecture(index, { messageId: "raised", ...options });
    expect(trace.nodes.some((node) => node.kind === "unknown-boundary" && node.reason === reason)).toBe(true);
  });
});
