import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_METADATA_FILE_NAME } from "../../src/domain/workspace/metadata";
import { DocumentationWorkspace } from "../workspace";
import { makeTempWorkspace, type TempWorkspace } from "./temp-workspace";

const SEQUENCE_SOURCE = [
  "actor Customer",
  "participant CheckoutAPI",
  "participant PaymentService",
  "",
  "Customer ->> CheckoutAPI: Submit cart",
  "CheckoutAPI ->> PaymentService: Authorize payment",
  "PaymentService -->> CheckoutAPI: Authorized",
  "",
].join("\n");

const EVENT_FLOW_SOURCE = [
  "event OrderCreated {",
  "  version: 2",
  "}",
  "topic orders",
  "producer OrderService",
  "consumer BillingService",
  "OrderService publishes OrderCreated to orders",
  "BillingService consumes OrderCreated from orders",
  "",
].join("\n");

describe("DocumentationWorkspace", () => {
  let temp: TempWorkspace;
  let workspace: DocumentationWorkspace;

  afterEach(async () => {
    if (temp) await temp.cleanup();
  });

  /** Open an empty temporary workspace. */
  async function open(): Promise<DocumentationWorkspace> {
    temp = await makeTempWorkspace();
    workspace = DocumentationWorkspace.open(temp.root);
    return workspace;
  }

  it("starts empty and explains how to create a project", async () => {
    const ws = await open();
    expect(await ws.listProjects()).toEqual([]);
    await expect(ws.resolveProject()).rejects.toThrow(/no projects/i);
  });

  it("creates a project and seeds its identity record", async () => {
    const ws = await open();
    const summary = await ws.createProject("Payments");
    expect(summary.id).toBe("Payments");
    expect((await ws.listProjects()).map((entry) => entry.id)).toEqual([
      "Payments",
    ]);

    // `project.json` is written on the first read, so files get stable ids from
    // the very first resource.
    const metadata = JSON.parse(
      await readFile(
        path.join(temp.root, "Payments", PROJECT_METADATA_FILE_NAME),
        "utf8",
      ),
    );
    expect(metadata.resources).toEqual([]);

    await expect(ws.createProject("Payments")).rejects.toThrow(
      /already exists/i,
    );
  });

  it("creates the three resource kinds with the extension each implies", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");

    const diagram = await ws.createResource(project, {
      kind: "diagram",
      name: "checkout-flow",
      title: "Checkout flow",
      content: SEQUENCE_SOURCE,
    });
    const flow = await ws.createResource(project, {
      kind: "event-flow",
      name: "orders",
      title: "Order processing",
      content: EVENT_FLOW_SOURCE,
    });
    const note = await ws.createResource(project, {
      kind: "note",
      name: "architecture",
      title: "Architecture",
      content: "How the system fits together.",
    });

    expect(diagram.resource.path).toBe("checkout-flow.seq");
    expect(diagram.resource.type).toBe("sequence-diagram");
    expect(diagram.resource.id).toBe("diagram-checkout-flow");
    expect(flow.resource.path).toBe("orders.eventseq");
    expect(flow.resource.type).toBe("event-flow");
    expect(note.resource.path).toBe("architecture.md");
    expect(note.resource.type).toBe("markdown-document");
    // The supplied title is prepended because the text declared none.
    const read = await ws.readResource(project, "architecture");
    expect(read.content.startsWith("# Architecture")).toBe(true);
  });

  it("refuses to overwrite unless asked", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "diagram",
      name: "flow",
      content: SEQUENCE_SOURCE,
    });
    await expect(
      ws.createResource(project, {
        kind: "diagram",
        name: "flow",
        content: "title Other\n",
      }),
    ).rejects.toThrow(/already exists/i);

    const replaced = await ws.createResource(project, {
      kind: "diagram",
      name: "flow",
      content: "title Other\n",
      overwrite: true,
    });
    expect(replaced.created).toBe(false);
    expect((await ws.readResource(project, "flow")).content).toContain(
      "title Other",
    );
  });

  it("rejects a name whose extension contradicts the kind", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await expect(
      ws.createResource(project, {
        kind: "diagram",
        name: "notes.md",
        content: "x",
      }),
    ).rejects.toThrow(/markdown document/i);
    await expect(
      ws.createResource(project, {
        kind: "note",
        name: "a/b",
        content: "x",
      }),
    ).rejects.toThrow(/path separator/i);
  });

  it("updates a resource in replace, append, and prepend mode", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "note",
      name: "readme",
      title: "Readme",
      content: "First.",
    });

    await ws.updateResource(project, "readme", {
      content: "Second.",
      mode: "append",
    });
    let read = await ws.readResource(project, "readme");
    expect(read.content).toContain("First.");
    expect(read.content.trimEnd().endsWith("Second.")).toBe(true);

    await ws.updateResource(project, "readme", {
      content: "Zeroth.",
      mode: "prepend",
    });
    read = await ws.readResource(project, "readme");
    expect(read.content.startsWith("Zeroth.")).toBe(true);

    await ws.updateResource(project, "readme", { content: "# Only" });
    expect((await ws.readResource(project, "readme")).content).toBe("# Only");
  });

  it("resolves a resource by id, path, file name, and title", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "diagram",
      name: "checkout-flow",
      title: "Checkout flow",
      content: SEQUENCE_SOURCE,
    });

    for (const reference of [
      "diagram-checkout-flow",
      "checkout-flow.seq",
      "checkout-flow",
      "Checkout flow",
    ]) {
      const read = await ws.readResource(project, reference);
      expect(read.resource.id).toBe("diagram-checkout-flow");
    }
    await expect(ws.readResource(project, "nope")).rejects.toThrow(
      /No resource matches/i,
    );
  });

  it("validates draft text without writing it", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const good = ws.validateSource(SEQUENCE_SOURCE, "diagram");
    expect(good).toEqual([]);

    const bad = ws.validateSource("A ->> B: undeclared", "diagram");
    expect(bad.some((entry) => entry.severity === "error")).toBe(true);
    expect(bad.every((entry) => entry.resourcePath === "(source)")).toBe(true);

    const badFlow = ws.validateSource("Ghost publishes Missing", "event-flow");
    expect(badFlow.length).toBeGreaterThan(0);

    // Markdown has no language diagnostics.
    expect(ws.validateSource("# Anything", "note")).toEqual([]);
  });

  it("reports project diagnostics and documentation gaps", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "diagram",
      name: "checkout",
      title: "Checkout",
      content: SEQUENCE_SOURCE,
    });
    await ws.createResource(project, {
      kind: "note",
      name: "overview",
      title: "Overview",
      content: "Short.",
    });

    const validation = await ws.validateProject(project);
    expect(validation.summary.resources).toBe(2);
    expect(validation.diagnostics).toEqual([]);

    const audit = await ws.audit(project);
    expect(audit.summary.resources).toBe(2);
    expect(audit.findings.map((entry) => entry.code)).toContain(
      "unreferenced-resource",
    );
    // The overview is linked from nothing, and is too short to be useful.
    expect(audit.findings.map((entry) => entry.code)).toContain(
      "thin-document",
    );
  });

  it("flags a broken in-project link and a missing title", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "note",
      name: "overview",
      content: "See [[Does Not Exist]] for details.",
    });

    const audit = await ws.audit(project);
    const codes = audit.findings.map((entry) => entry.code);
    expect(codes).toContain("broken-link");
    expect(codes).toContain("missing-title");
  });

  it("renders a diagram and an event flow to SVG", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "diagram",
      name: "checkout",
      title: "Checkout",
      content: SEQUENCE_SOURCE,
    });
    await ws.createResource(project, {
      kind: "event-flow",
      name: "orders",
      content: EVENT_FLOW_SOURCE,
    });

    const diagram = await ws.render(project, "checkout");
    expect(diagram.format).toBe("svg");
    expect(diagram.svg).toContain("<svg");
    expect(diagram.width).toBeGreaterThan(0);

    const flow = await ws.render(project, "orders");
    expect(flow.svg).toContain("<svg");

    await expect(
      ws.render(project, "checkout", { output: "../escape.svg" }),
    ).rejects.toThrow(/escapes the workspace root/i);
  });

  it("searches with scopes and finds symbol references", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "diagram",
      name: "checkout",
      title: "Checkout",
      content: SEQUENCE_SOURCE,
    });
    await ws.createResource(project, {
      kind: "note",
      name: "overview",
      title: "Overview",
      content: "The CheckoutAPI orchestrates payment.",
    });

    const byParticipant = await ws.search(project, "participant:CheckoutAPI");
    expect(byParticipant.matches.map((match) => match.name)).toContain(
      "checkout.seq",
    );

    const text = await ws.search(project, "orchestrates");
    expect(text.matches.map((match) => match.name)).toEqual(["overview.md"]);

    const references = await ws.findReferences(project, "CheckoutAPI");
    expect(references.declaredIn).toContain("diagram-checkout");
    expect(references.sites.some((site) => site.role === "declaration")).toBe(
      true,
    );
  });

  it("renames a file while keeping its stable id", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "diagram",
      name: "checkout",
      title: "Checkout",
      content: SEQUENCE_SOURCE,
    });

    const renamed = await ws.renameResource(
      project,
      "diagram-checkout",
      "checkout-v2.seq",
    );
    expect(renamed.resource.path).toBe("checkout-v2.seq");
    expect(renamed.resource.id).toBe("diagram-checkout");

    // The id still resolves because the identity record moved with the file.
    const read = await ws.readResource(project, "diagram-checkout");
    expect(read.resource.path).toBe("checkout-v2.seq");
    expect(read.content).toContain("Checkout");
  });

  it("requires confirmation before deleting", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "diagram",
      name: "checkout",
      content: SEQUENCE_SOURCE,
    });

    await expect(ws.deleteResource(project, "checkout", false)).rejects.toThrow(
      /confirmation/i,
    );

    const deleted = await ws.deleteResource(project, "checkout", true);
    expect(deleted.deleted.path).toBe("checkout.seq");
    await expect(ws.readResource(project, "checkout")).rejects.toThrow(
      /No resource matches/i,
    );
  });

  it("describes a project's symbols and diagnostics for orientation", async () => {
    const ws = await open();
    await ws.createProject("Payments");
    const project = await ws.resolveProject("Payments");
    await ws.createResource(project, {
      kind: "diagram",
      name: "checkout",
      content: SEQUENCE_SOURCE,
    });

    const overview = await ws.overview(project);
    const counts = overview.counts as Record<string, number>;
    expect(counts.resources).toBe(1);
    const symbols = overview.symbols as Record<string, string[]>;
    expect(symbols.participant).toContain("CheckoutAPI");
    expect(symbols.actor).toContain("Customer");
  });
});
