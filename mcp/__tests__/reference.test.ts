import { describe, expect, it } from "vitest";
import {
  DSL_CONSTRUCTS,
  EVENT_FLOW_CONSTRUCTS,
} from "../../src/language/dsl-reference";
import {
  DOCUMENTING_GUIDE_URI,
  EVENT_FLOW_DSL_URI,
  MARKDOWN_URI,
  PROJECT_RESOURCE_TEMPLATE,
  SEQUENCE_DSL_URI,
  SERVER_INSTRUCTIONS,
  WORKFLOW_GUIDE_URI,
  documentingGuideText,
  eventFlowDslText,
  markdownReferenceText,
  resourceTemplates,
  sequenceDslText,
  staticResourceText,
  staticResources,
} from "../reference";

describe("MCP reference resources", () => {
  it("advertises every static resource with a unique URI", () => {
    const resources = staticResources();
    expect(resources.map((entry) => entry.uri)).toEqual([
      SEQUENCE_DSL_URI,
      EVENT_FLOW_DSL_URI,
      MARKDOWN_URI,
      DOCUMENTING_GUIDE_URI,
      WORKFLOW_GUIDE_URI,
    ]);
    const uris = new Set(resources.map((entry) => entry.uri));
    expect(uris.size).toBe(resources.length);
    for (const resource of resources) {
      expect(resource.name.length).toBeGreaterThan(0);
      expect(String(resource.description).length).toBeGreaterThan(20);
      expect(resource.mimeType).toBe("text/markdown");
    }
  });

  it("documents every construct the languages implement", () => {
    const sequence = sequenceDslText();
    for (const construct of DSL_CONSTRUCTS) {
      expect(sequence).toContain(`### ${construct.name}`);
      expect(sequence).toContain(construct.example);
    }
    const eventFlow = eventFlowDslText();
    for (const construct of EVENT_FLOW_CONSTRUCTS) {
      expect(eventFlow).toContain(`### ${construct.name}`);
      expect(eventFlow).toContain(construct.example);
    }
  });

  it("returns the text for every known URI and null otherwise", () => {
    expect(staticResourceText(SEQUENCE_DSL_URI)).toBe(sequenceDslText());
    expect(staticResourceText(EVENT_FLOW_DSL_URI)).toBe(eventFlowDslText());
    expect(staticResourceText(MARKDOWN_URI)).toBe(markdownReferenceText());
    expect(staticResourceText(DOCUMENTING_GUIDE_URI)).toBe(
      documentingGuideText(),
    );
    expect(staticResourceText(WORKFLOW_GUIDE_URI)).toEqual(
      expect.stringContaining("audit_documentation"),
    );
    expect(staticResourceText("sequencediagrams://nope")).toBe(null);
  });

  it("describes the project linking and embedding rules", () => {
    const markdown = markdownReferenceText();
    expect(markdown).toContain("[[Payment flow]]");
    expect(markdown).toContain("resource://");
    expect(markdown).toContain("{{diagram:resource-id}}");
  });

  it("points the documentation guide at the tools it expects", () => {
    const guide = documentingGuideText();
    for (const tool of [
      "list_projects",
      "create_project",
      "create_resource",
      "validate_project",
      "audit_documentation",
      "render_diagram",
    ]) {
      expect(guide).toContain(tool);
    }
  });

  it("states the workflow in the initialize instructions", () => {
    for (const tool of [
      "get_project_overview",
      "create_resource",
      "validate_source",
      "audit_documentation",
    ]) {
      expect(SERVER_INSTRUCTIONS).toContain(tool);
    }
    expect(SERVER_INSTRUCTIONS).toContain(SEQUENCE_DSL_URI);
  });

  it("offers one resource template for reading project files", () => {
    const templates = resourceTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].uriTemplate).toBe(PROJECT_RESOURCE_TEMPLATE);
  });
});
