import { describe, expect, it } from "vitest";
import {
  basenameOf,
  directoryOf,
  isExternalHref,
  normalizePath,
  resolveProjectLink,
  type ProjectLinkContext,
} from "../../../src/domain/workspace/project-link";
import type { ProjectResource } from "../../../src/domain/workspace/resource";

const resources: ProjectResource[] = [
  {
    kind: "note",
    id: "docs/overview.md",
    projectId: "docs",
    name: "overview.md",
  },
  {
    kind: "note",
    id: "docs/decisions/ADR-001.md",
    projectId: "docs/decisions",
    name: "ADR-001.md",
  },
  {
    kind: "diagram",
    id: "diagrams/payment.seq",
    projectId: "diagrams",
    name: "payment.seq",
  },
  {
    kind: "note",
    id: "note-2",
    projectId: "proj-a",
    name: "Untitled.md",
  },
  {
    kind: "note",
    id: "note-3",
    projectId: "proj-b",
    name: "Untitled.md",
  },
];

const context = (
  overrides: Partial<ProjectLinkContext> = {},
): ProjectLinkContext => ({
  fromId: "docs/architecture.md",
  projectId: "docs",
  resources,
  ...overrides,
});

describe("path helpers", () => {
  it("normalizes separators and dot segments", () => {
    expect(normalizePath("/a//b/./c")).toBe("a/b/c");
    expect(normalizePath("a/b/../c")).toBe("a/c");
    expect(normalizePath("a/../../c")).toBe("c");
    expect(normalizePath("")).toBe("");
  });

  it("splits a directory from a base name", () => {
    expect(directoryOf("docs/a.md")).toBe("docs");
    expect(directoryOf("a.md")).toBe("");
    expect(basenameOf("docs/a.md")).toBe("a.md");
    expect(basenameOf("a.md")).toBe("a.md");
  });
});

describe("isExternalHref", () => {
  it("treats schemes, fragments and absolute paths as external", () => {
    expect(isExternalHref("https://example.com")).toBe(true);
    expect(isExternalHref("mailto:a@b.c")).toBe(true);
    expect(isExternalHref("javascript:alert")).toBe(true);
    expect(isExternalHref("#section")).toBe(true);
    expect(isExternalHref("/root.md")).toBe(true);
    expect(isExternalHref("")).toBe(true);
  });

  it("treats a relative path as a project link", () => {
    expect(isExternalHref("../diagrams/payment.seq")).toBe(false);
    expect(isExternalHref("sibling.md")).toBe(false);
  });
});

describe("resolveProjectLink", () => {
  it("resolves a sibling in the same directory", () => {
    expect(resolveProjectLink("overview.md", context())?.id).toBe(
      "docs/overview.md",
    );
  });

  it("resolves a path that climbs out of the current directory", () => {
    expect(resolveProjectLink("../diagrams/payment.seq", context())?.id).toBe(
      "diagrams/payment.seq",
    );
  });

  it("resolves a path that descends into a subdirectory", () => {
    expect(resolveProjectLink("decisions/ADR-001.md", context())?.id).toBe(
      "docs/decisions/ADR-001.md",
    );
  });

  it("ignores a fragment when matching the resource", () => {
    expect(resolveProjectLink("overview.md#intro", context())?.id).toBe(
      "docs/overview.md",
    );
  });

  it("decodes a percent-encoded path", () => {
    const encoded: ProjectResource[] = [
      {
        kind: "note",
        id: "docs/decision records/ADR 1.md",
        projectId: "docs",
        name: "ADR 1.md",
      },
    ];
    expect(
      resolveProjectLink("decision%20records/ADR%201.md", {
        fromId: "docs/x.md",
        projectId: "docs",
        resources: encoded,
      })?.id,
    ).toBe("docs/decision records/ADR 1.md");
  });

  it("falls back to the file name for a flat (in-browser) project", () => {
    expect(
      resolveProjectLink("Untitled.md", {
        fromId: "note-1",
        projectId: "proj-a",
        resources,
      })?.id,
    ).toBe("note-2");
  });

  it("prefers a name match in the linking document's own project", () => {
    expect(
      resolveProjectLink("Untitled.md", {
        fromId: "note-9",
        projectId: "proj-b",
        resources,
      })?.id,
    ).toBe("note-3");
  });

  it("does not resolve an external link", () => {
    expect(resolveProjectLink("https://example.com", context())).toBeNull();
    expect(resolveProjectLink("#anchor", context())).toBeNull();
    expect(resolveProjectLink("", context())).toBeNull();
  });

  it("does not resolve a path that matches nothing", () => {
    expect(resolveProjectLink("nowhere.md", context())).toBeNull();
  });
});
