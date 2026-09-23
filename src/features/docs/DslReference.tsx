/**
 * DSL reference ("Docs" view).
 *
 * A static, hand-written reference for exactly the constructs the language layer
 * supports today. The construct data itself lives in
 * `src/language/dsl-reference.ts` so the editor panel, the grammar-guarding
 * tests, and the MCP server's `reference` resources all read one description of
 * the languages; this module is only their presentation.
 *
 * Keeping the data framework-free is what lets a construct be asserted against
 * the real grammar in tests, so it cannot be documented without being
 * implemented.
 */

import {
  DSL_CONSTRUCTS,
  EVENT_FLOW_CONSTRUCTS,
  type DslConstruct,
} from "../../language/dsl-reference";

// Re-exported for the existing panel/test import surface, so moving the data to
// the language layer did not move any caller.
export { DSL_CONSTRUCTS, EVENT_FLOW_CONSTRUCTS };
export type { DslConstruct };

/** One language's section: a heading and the constructs it documents. */
function ConstructSection({
  title,
  constructs,
  testId,
}: {
  title: string;
  constructs: DslConstruct[];
  testId: string;
}) {
  return (
    <section className="docs__section" data-testid={testId}>
      <h3 className="docs__section-title">{title}</h3>
      <dl className="docs__list">
        {constructs.map((construct) => (
          <div className="docs__entry" key={construct.name}>
            <dt className="docs__name">{construct.name}</dt>
            <dd className="docs__body">
              <code className="docs__syntax" data-testid="docs-syntax">
                {construct.syntax}
              </code>
              <p className="docs__summary">{construct.summary}</p>
              <pre className="docs__example">
                <code>{construct.example}</code>
              </pre>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function DslReference() {
  return (
    <div className="docs" data-testid="dsl-reference">
      <p className="docs__intro">
        The editor owns two small documentation languages, both parsed,
        validated and drawn by this project rather than delegated to a library.
        A sequence diagram shows the order of interactions; an event flow shows
        which services produce and consume which events. All three Event Flow
        views are projections of that one semantic resource: Flow emphasizes
        event movement, Catalog documents event facts and metadata, and Topology
        summarizes service connectivity through mediated event relationships.
        Channels and brokers remain available as transport context on those
        relationships rather than becoming a second graph language.
      </p>
      <p className="docs__intro">
        Resource metadata describes the Event Flow file as a whole. Event
        annotations live inside an event declaration and describe that
        individual event; `description`, `domain`, `version`, and `schema` are
        conventional keys, while arbitrary metadata remains supported.
      </p>
      <ConstructSection
        title="Sequence diagrams"
        constructs={DSL_CONSTRUCTS}
        testId="docs-section-sequence"
      />
      <ConstructSection
        title="Event flows"
        constructs={EVENT_FLOW_CONSTRUCTS}
        testId="docs-section-event-flow"
      />
    </div>
  );
}
