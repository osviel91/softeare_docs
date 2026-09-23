import { describe, expect, it } from "vitest";
import type {
  DiagramFile,
  NoteFile,
  Project,
} from "../../../src/domain/workspace/types";
import {
  archiveSlug,
  buildProjectArchive,
  exportProjectToZip,
  importProjectFromZip,
  parseProjectArchive,
} from "../../../src/workspace/transfer/project-archive";
import type { ZipEntry } from "../../../src/workspace/transfer/zip";

const project: Project = {
  id: "payments-service",
  name: "Payments Service",
  datasetIds: ["diag-1", "diag-2"],
  noteIds: ["note-1"],
};

const diagrams: DiagramFile[] = [
  {
    id: "diag-1",
    name: "checkout",
    projectId: "payments-service",
    source: "title Checkout\nA -> B: pay",
  },
  {
    id: "diag-2",
    name: "settlement.seq",
    projectId: "payments-service",
    source: "title Settlement\nB -> C: settle",
  },
];

const notes: NoteFile[] = [
  {
    id: "note-1",
    name: "architecture.md",
    projectId: "payments-service",
    markdown: "# Architecture\n\nProse.",
  },
];

/** The archive entry with the given path. */
function entry(entries: ZipEntry[], path: string): ZipEntry | undefined {
  return entries.find((item) => item.path === path);
}

/** Decode an entry's bytes as UTF-8. */
function text(entries: ZipEntry[], path: string): string {
  const found = entry(entries, path);
  if (!found) throw new Error(`No entry at ${path}`);
  return new TextDecoder().decode(found.data);
}

describe("archiveSlug", () => {
  it("makes a filesystem-safe directory name", () => {
    expect(archiveSlug("Payments Service")).toBe("Payments-Service");
    expect(archiveSlug("a/b:c*d?e")).toBe("a-b-c-d-e");
    expect(archiveSlug("  spaced  ")).toBe("spaced");
  });

  it("falls back to a usable name when nothing survives", () => {
    expect(archiveSlug("///")).toBe("project");
    expect(archiveSlug("")).toBe("project");
  });
});

describe("buildProjectArchive", () => {
  it("lays the project out as a readable documentation tree", () => {
    const entries = buildProjectArchive(project, diagrams, notes);
    const paths = entries.map((item) => item.path);
    expect(paths).toEqual([
      "Payments-Service/project.json",
      "Payments-Service/diagrams/checkout.seq",
      "Payments-Service/diagrams/settlement.seq",
      "Payments-Service/docs/architecture.md",
    ]);
    expect(text(entries, "Payments-Service/diagrams/checkout.seq")).toBe(
      diagrams[0].source,
    );
    expect(text(entries, "Payments-Service/docs/architecture.md")).toBe(
      notes[0].markdown,
    );
  });

  it("records each resource's original name alongside its path", () => {
    const entries = buildProjectArchive(project, diagrams, notes);
    const manifest = JSON.parse(
      text(entries, "Payments-Service/project.json"),
    ) as { format: string; resources: unknown[] };
    expect(manifest.format).toBe("sequencediagrams-project");
    // Paths are relative to the project directory, so the archive survives a
    // rename of that directory.
    expect(manifest.resources).toEqual([
      {
        kind: "diagram",
        id: "diag-1",
        name: "checkout",
        path: "diagrams/checkout.seq",
      },
      {
        kind: "diagram",
        id: "diag-2",
        name: "settlement.seq",
        path: "diagrams/settlement.seq",
      },
      {
        kind: "note",
        id: "note-1",
        name: "architecture.md",
        path: "docs/architecture.md",
      },
    ]);
  });

  it("keeps the manifest first so the archive reads top-down", () => {
    const entries = buildProjectArchive(project, diagrams, notes);
    expect(entries[0].path.endsWith("project.json")).toBe(true);
  });

  it("disambiguates names that sanitize to the same path", () => {
    const clashing: DiagramFile[] = [
      { ...diagrams[0], id: "d1", name: "a/b" },
      { ...diagrams[0], id: "d2", name: "a:b" },
    ];
    const entries = buildProjectArchive(project, clashing, []);
    const paths = entries
      .map((item) => item.path)
      .filter((p) => p.endsWith(".seq"));
    expect(paths).toEqual([
      "Payments-Service/diagrams/a-b.seq",
      "Payments-Service/diagrams/a-b-2.seq",
    ]);
  });

  it("handles an empty project", () => {
    const entries = buildProjectArchive(project, [], []);
    expect(entries).toHaveLength(1);
    expect(parseProjectArchive(entries).ok).toBe(true);
  });
});

describe("parseProjectArchive", () => {
  it("round-trips optional resource metadata", () => {
    const parsed = parseProjectArchive(
      buildProjectArchive(
        project,
        [{ ...diagrams[0], metadata: { description: "Checkout", tags: ["flow"] } }],
        [{ ...notes[0], metadata: { tags: ["docs"] } }],
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.diagrams[0].metadata).toEqual({
      description: "Checkout",
      tags: ["flow"],
    });
    expect(parsed.value.notes[0].metadata).toEqual({ tags: ["docs"] });
  });

  it("round-trips a project exactly", () => {
    const entries = buildProjectArchive(project, diagrams, notes);
    const parsed = parseProjectArchive(entries);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      name: "Payments Service",
      diagrams: [
        { name: "checkout", source: diagrams[0].source },
        { name: "settlement.seq", source: diagrams[1].source },
      ],
      notes: [{ name: "architecture.md", markdown: notes[0].markdown }],
    });
  });

  it("finds the manifest under any single project directory", () => {
    const moved = buildProjectArchive(project, diagrams, notes).map((item) => ({
      ...item,
      path: item.path.replace("Payments-Service/", "somewhere-else/"),
    }));
    expect(parseProjectArchive(moved).ok).toBe(true);
  });

  it("rejects an archive with no manifest", () => {
    const result = parseProjectArchive([
      { path: "docs/a.md", data: new Uint8Array() },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("no project.json manifest");
  });

  it("rejects a manifest that is not JSON", () => {
    const result = parseProjectArchive([
      { path: "p/project.json", data: new TextEncoder().encode("{nope") },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("not valid JSON");
  });

  it("rejects an unknown format", () => {
    const result = parseProjectArchive([
      {
        path: "p/project.json",
        data: new TextEncoder().encode(
          JSON.stringify({
            format: "other",
            version: 1,
            project: { name: "x" },
          }),
        ),
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("unexpected format");
  });

  it("rejects an unsupported version", () => {
    const result = parseProjectArchive([
      {
        path: "p/project.json",
        data: new TextEncoder().encode(
          JSON.stringify({
            format: "sequencediagrams-project",
            version: 99,
            project: { name: "x" },
            resources: [],
          }),
        ),
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("unsupported archive version");
  });

  it("rejects a resource whose file is missing", () => {
    const entries = buildProjectArchive(project, diagrams, notes).filter(
      (item) => !item.path.endsWith("checkout.seq"),
    );
    const result = parseProjectArchive(entries);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("checkout.seq");
  });
});

describe("project ZIP round trip", () => {
  it("exports a ZIP that imports back to the same project", () => {
    const bytes = exportProjectToZip(project, diagrams, notes);
    const parsed = importProjectFromZip(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Payments Service");
    expect(parsed.value.diagrams).toHaveLength(2);
    expect(parsed.value.notes).toHaveLength(1);
  });

  it("reports a corrupt ZIP as an error rather than throwing", () => {
    const result = importProjectFromZip(new Uint8Array([1, 2, 3, 4]));
    expect(result.ok).toBe(false);
  });
});
