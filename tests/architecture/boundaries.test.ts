/**
 * The dependency rule (ADR-039), enforced by a test rather than by hope.
 *
 * The migration's core requirement is that the HTTP API and the MCP server are
 * two adapters over *one* application layer. That only holds while the imports
 * point that way, so this test reads the source tree and fails the moment an
 * arrow reverses: an application-layer module reaching for React, a host
 * reaching into another host, or a domain module importing a feature.
 *
 * It checks imports, not behaviour, which is why it can assert the rule for code
 * that does not exist yet — `apps/api` is covered the day its first file lands.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

/** Every `.ts`/`.tsx` file under a directory, recursively. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...(await filesUnder(full)));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** The module specifiers a TypeScript file imports or re-exports. */
function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** The dependency-layer of a repo-relative path. */
type Layer =
  | "domain"
  | "application"
  | "features"
  | "persistence"
  | "host"
  | "shared"
  | "other";

function layerOf(relative: string): Layer {
  if (relative.startsWith("src/domain/")) return "domain";
  if (relative.startsWith("src/application/")) return "application";
  if (relative.startsWith("src/features/")) return "features";
  if (relative.startsWith("src/persistence/")) return "persistence";
  if (relative.startsWith("mcp/") || relative.startsWith("apps/"))
    return "host";
  if (relative.startsWith("src/shared/")) return "shared";
  return "other";
}

/** The layer an import specifier points at, or `null` when it is external. */
function importedLayer(importer: string, specifier: string): Layer | null {
  if (!specifier.startsWith(".")) {
    if (specifier.startsWith("src/") || specifier.startsWith("apps/")) {
      return layerOf(specifier);
    }
    return null;
  }
  const resolved = path
    .relative(ROOT, path.resolve(path.dirname(importer), specifier))
    .split(path.sep)
    .join("/");
  return layerOf(resolved);
}

/** Modules that may not import the given layer. */
async function violations(
  files: string[],
  forbidden: (relative: string, specifier: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const source = await readFile(file, "utf8");
    for (const specifier of importsOf(source)) {
      if (forbidden(relative, specifier)) {
        found.push(`${relative} -> ${specifier}`);
      }
    }
  }
  return found;
}

describe("dependency rule (ADR-039)", () => {
  it("keeps the domain and application layers free of React and features", async () => {
    const files = [
      ...(await filesUnder(path.join(ROOT, "src/domain"))),
      ...(await filesUnder(path.join(ROOT, "src/application"))),
    ];
    const found = await violations(files, (relative, specifier) => {
      if (/^(react|react-dom)(\/|$)/.test(specifier)) return true;
      const imported = importedLayer(path.join(ROOT, relative), specifier);
      return imported === "features" || imported === "host";
    });
    expect(found).toEqual([]);
  });

  it("keeps the domain free of the application layer", async () => {
    const files = await filesUnder(path.join(ROOT, "src/domain"));
    const found = await violations(files, (relative, specifier) => {
      const imported = importedLayer(path.join(ROOT, relative), specifier);
      return imported === "application";
    });
    expect(found).toEqual([]);
  });

  it("stops the MCP host from importing the API host and vice versa", async () => {
    const hosts = [
      ...(await filesUnder(path.join(ROOT, "mcp"))),
      ...(await filesUnder(path.join(ROOT, "apps"))),
    ];
    const found = await violations(hosts, (relative, specifier) => {
      const target = path
        .relative(
          ROOT,
          path.resolve(path.dirname(path.join(ROOT, relative)), specifier),
        )
        .split(path.sep)
        .join("/");
      if (relative.startsWith("mcp/")) return target.startsWith("apps/");
      if (relative.startsWith("apps/")) return target.startsWith("mcp/");
      return false;
    });
    expect(found).toEqual([]);
  });

  it("keeps the hosts out of the React feature layer", async () => {
    const hosts = [
      ...(await filesUnder(path.join(ROOT, "mcp"))),
      ...(await filesUnder(path.join(ROOT, "apps"))),
    ];
    const found = await violations(hosts, (relative, specifier) => {
      if (/^react(-dom)?(\/|$)/.test(specifier)) return true;
      const imported = importedLayer(path.join(ROOT, relative), specifier);
      return imported === "features";
    });
    expect(found).toEqual([]);
  });

  it("keeps the application layer out of the hosts", async () => {
    const files = await filesUnder(path.join(ROOT, "src/application"));
    const found = await violations(files, (relative, specifier) => {
      const imported = importedLayer(path.join(ROOT, relative), specifier);
      return imported === "host";
    });
    expect(found).toEqual([]);
  });

  /**
   * The arrow that Phase 4D put right. A use case must depend on a *port*, and
   * the port must be defined where the use case lives: an application module
   * importing `src/persistence` would bind the policy to PostgreSQL and make the
   * "one application layer, two adapters" claim false.
   */
  it("keeps the application layer out of persistence", async () => {
    const files = await filesUnder(path.join(ROOT, "src/application"));
    const found = await violations(files, (relative, specifier) => {
      const imported = importedLayer(path.join(ROOT, relative), specifier);
      return imported === "persistence";
    });
    expect(found).toEqual([]);
  });
});

describe("the application layer exists and is reachable", () => {
  it("exposes the ports and context a host must supply", async () => {
    for (const name of ["context.ts", "errors.ts", "project-service.ts"]) {
      const info = await stat(path.join(ROOT, "src/application", name));
      expect(info.isFile()).toBe(true);
    }
  });

  /**
   * The persistence ports, now defined inside the layer that consumes them so
   * that persistence depends on application and never the reverse.
   */
  it("defines the persistence ports in the application layer", async () => {
    for (const name of [
      "index.ts",
      "project-repository.ts",
      "audit-repository.ts",
      "resource-path.ts",
    ]) {
      const info = await stat(path.join(ROOT, "src/application/ports", name));
      expect(info.isFile()).toBe(true);
    }
  });
});
