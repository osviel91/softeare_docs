/**
 * The filesystem boundary (ADR-040).
 *
 * These are the security tests the mission's "Filesystem tests" list asks for:
 * `../` traversal, absolute paths, percent-encoded traversal, and a symlink
 * escape. They run against the pure path helper *and* against a real temporary
 * directory, because a helper that normalises perfectly and a store that then
 * follows a link would still be a hole.
 */
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidResourcePathError,
  MAX_RESOURCE_PATH_LENGTH,
  isSafeResourcePath,
  normalizeResourcePath,
  resourceExtension,
  resourceFileName,
} from "../../src/persistence/resource-path";
import { createFsProjectStorage } from "../../src/persistence/fs-project-storage";
import { isOk } from "../../src/shared/result/result";

describe("normalizeResourcePath", () => {
  it("accepts an ordinary project-relative path", () => {
    expect(normalizeResourcePath("diagrams/checkout.seq")).toBe(
      "diagrams/checkout.seq",
    );
    expect(normalizeResourcePath("README.md")).toBe("README.md");
  });

  it("accepts a file name that merely contains a percent sign", () => {
    expect(normalizeResourcePath("docs/50%-done.md")).toBe("docs/50%-done.md");
  });

  it("rejects a parent-directory segment", () => {
    for (const candidate of [
      "../etc/passwd",
      "docs/../../etc/passwd",
      "..",
      "docs/..",
      "a/../b",
    ]) {
      expect(() => normalizeResourcePath(candidate)).toThrow(
        InvalidResourcePathError,
      );
      expect(isSafeResourcePath(candidate)).toBe(false);
    }
  });

  it("rejects a current-directory segment", () => {
    expect(() => normalizeResourcePath("./secret.md")).toThrow(
      InvalidResourcePathError,
    );
    expect(() => normalizeResourcePath("docs/./a.md")).toThrow(
      InvalidResourcePathError,
    );
  });

  it("rejects an absolute path", () => {
    for (const candidate of [
      "/etc/passwd",
      "/data/projects/x/y.seq",
      "C:/Windows/system32",
      "c:secret",
      "~/.ssh/id_rsa",
      "~",
    ]) {
      expect(() => normalizeResourcePath(candidate)).toThrow(
        InvalidResourcePathError,
      );
    }
  });

  it("rejects a backslash separator rather than translating it", () => {
    expect(() => normalizeResourcePath("docs\\a.md")).toThrow(
      InvalidResourcePathError,
    );
    expect(() => normalizeResourcePath("..\\..\\etc")).toThrow(
      InvalidResourcePathError,
    );
  });

  it("rejects percent-encoded traversal", () => {
    for (const candidate of [
      "%2e%2e/etc/passwd",
      "docs/%2e%2e/%2e%2e/etc",
      "%2E%2E%2Fetc",
      "docs/%2e%2e%5cetc",
      "docs/%00hidden.md",
    ]) {
      expect(() => normalizeResourcePath(candidate)).toThrow(
        InvalidResourcePathError,
      );
    }
  });

  it("rejects NUL and other control characters", () => {
    expect(() => normalizeResourcePath("docs/a\u0000.md")).toThrow(
      InvalidResourcePathError,
    );
    expect(() => normalizeResourcePath("docs/a\n.md")).toThrow(
      InvalidResourcePathError,
    );
  });

  it("rejects empty segments, an empty path, and an over-long path", () => {
    expect(() => normalizeResourcePath("")).toThrow(InvalidResourcePathError);
    expect(() => normalizeResourcePath("a//b")).toThrow(
      InvalidResourcePathError,
    );
    expect(() => normalizeResourcePath("/")).toThrow(InvalidResourcePathError);
    expect(() =>
      normalizeResourcePath("a/".repeat(MAX_RESOURCE_PATH_LENGTH)),
    ).toThrow(InvalidResourcePathError);
  });

  it("keeps a path that merely looks percent-encoded but is not", () => {
    // `%zz` is not an escape sequence, so it is an ordinary character pair.
    expect(normalizeResourcePath("docs/%zz.md")).toBe("docs/%zz.md");
  });

  it("keeps a nested path canonical, so two spellings cannot diverge", () => {
    expect(normalizeResourcePath("a/b/c.seq")).toBe("a/b/c.seq");
  });
});

describe("path helpers", () => {
  it("reads the file name and extension", () => {
    expect(resourceFileName("diagrams/checkout.seq")).toBe("checkout.seq");
    expect(resourceFileName("README.md")).toBe("README.md");
    expect(resourceExtension("a/b/Notes.MD")).toBe(".md");
    expect(resourceExtension("a/b/flow.eventseq")).toBe(".eventseq");
    expect(resourceExtension("no-extension")).toBe("");
  });
});

describe("createFsProjectStorage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sd-storage-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes, reads, lists and removes a resource", async () => {
    const storage = createFsProjectStorage({ root });
    const written = await storage.write(
      "diagrams/checkout.seq",
      "participant A",
    );
    expect(isOk(written)).toBe(true);

    const read = await storage.read("diagrams/checkout.seq");
    expect(read.ok && read.value?.content).toBe("participant A");
    expect(read.ok && read.value?.type).toBe("sequence-diagram");

    const listed = await storage.list();
    expect(listed.ok && listed.value.map((entry) => entry.path)).toEqual([
      "diagrams/checkout.seq",
    ]);

    await storage.remove("diagrams/checkout.seq");
    expect(await storage.exists("diagrams/checkout.seq")).toBe(false);
  });

  it("derives the resource kind from the extension, not the caller", async () => {
    const storage = createFsProjectStorage({ root });
    await storage.write("flow.eventseq", "event A");
    await storage.write("docs/readme.md", "# Readme");
    const listed = await storage.list();
    const byPath = new Map(
      listed.ok ? listed.value.map((entry) => [entry.path, entry.type]) : [],
    );
    expect(byPath.get("flow.eventseq")).toBe("event-flow");
    expect(byPath.get("docs/readme.md")).toBe("markdown-document");
  });

  it("refuses a traversal write and writes nothing outside the root", async () => {
    const storage = createFsProjectStorage({ root });
    const outside = path.join(root, "..", "escaped.seq");
    const result = await storage.write("../escaped.seq", "nope");
    expect(result.ok).toBe(false);
    expect(await storage.exists(outside)).toBe(false);
  });

  it("refuses an absolute write", async () => {
    const storage = createFsProjectStorage({ root });
    const result = await storage.write("/tmp/absolute.seq", "nope");
    expect(result.ok).toBe(false);
  });

  it("refuses a percent-encoded traversal write", async () => {
    const storage = createFsProjectStorage({ root });
    const result = await storage.write("%2e%2e%2fescaped.seq", "nope");
    expect(result.ok).toBe(false);
    expect(await storage.exists(path.join(root, "..", "escaped.seq"))).toBe(
      false,
    );
  });

  it("refuses to read or write through a symlink that leaves the project", async () => {
    const storage = createFsProjectStorage({ root });
    const outside = await mkdtemp(path.join(tmpdir(), "sd-outside-"));
    await writeFile(path.join(outside, "secret.md"), "# Secret", "utf8");
    try {
      await symlink(outside, path.join(root, "linked"), "dir");
      const read = await storage.read("linked/secret.md");
      expect(read.ok).toBe(false);
      const write = await storage.write("linked/new.md", "# New");
      expect(write.ok).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not list hidden files", async () => {
    const storage = createFsProjectStorage({ root });
    await storage.write("visible.md", "# Visible");
    await writeFile(path.join(root, ".hidden.md"), "# Hidden", "utf8");
    await writeFile(path.join(root, ".project.json"), "{}", "utf8");
    const listed = await storage.list();
    expect(listed.ok && listed.value.map((entry) => entry.path)).toEqual([
      "visible.md",
    ]);
  });

  it("refuses to read or write through a symlinked file that leaves the project", async () => {
    const storage = createFsProjectStorage({ root });
    const outside = await mkdtemp(path.join(tmpdir(), "sd-outside-file-"));
    await writeFile(path.join(outside, "secret.md"), "# Secret", "utf8");
    try {
      // The link sits directly in the project root, so no *ancestor* of the
      // target leaves the project — only the final component does.
      await symlink(
        path.join(outside, "secret.md"),
        path.join(root, "linked.md"),
        "file",
      );
      const read = await storage.read("linked.md");
      expect(read.ok).toBe(false);
      const write = await storage.write("linked.md", "# Replaced");
      expect(write.ok).toBe(false);
      expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe(
        "# Secret",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a move that would overwrite a sibling", async () => {
    const storage = createFsProjectStorage({ root });
    await storage.write("a.seq", "A");
    await storage.write("b.seq", "B");
    const moved = await storage.move({ from: "a.seq", to: "b.seq" });
    expect(moved.ok).toBe(false);
    const b = await storage.read("b.seq");
    expect(b.ok && b.value?.content).toBe("B");
  });

  it("moves a resource without losing its bytes", async () => {
    const storage = createFsProjectStorage({ root });
    await storage.write("old/name.seq", "A -> B");
    const moved = await storage.move({ from: "old/name.seq", to: "new.seq" });
    expect(moved.ok && moved.value.path).toBe("new.seq");
    const after = await storage.read("new.seq");
    expect(after.ok && after.value?.content).toBe("A -> B");
  });

  it("replaces a file's bytes in place rather than appending", async () => {
    const storage = createFsProjectStorage({ root });
    await storage.write("a.seq", "first, and longer");
    await storage.write("a.seq", "second");
    expect(await readFile(path.join(root, "a.seq"), "utf8")).toBe("second");
  });

  it("reports a missing resource as null, not as a failure", async () => {
    const storage = createFsProjectStorage({ root });
    const read = await storage.read("absent.seq");
    expect(read.ok).toBe(true);
    expect(read.ok && read.value).toBeNull();
  });

  it("treats a removed resource as already gone", async () => {
    const storage = createFsProjectStorage({ root });
    const removed = await storage.remove("never-existed.seq");
    expect(removed.ok).toBe(true);
  });

  it("creates the project directory lazily, so a fresh project works", async () => {
    const fresh = path.join(root, "not", "created", "yet");
    const storage = createFsProjectStorage({ root: fresh });
    const listed = await storage.list();
    expect(listed.ok).toBe(true);
    await mkdir(path.join(root, "not"), { recursive: true });
  });
});
