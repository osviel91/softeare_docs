/**
 * The MCP server reference on the documentation page.
 *
 * This is the in-app counterpart to the README's "MCP server" section: what the
 * server is, how to start it, how to point OpenCode, Hermes or any other MCP
 * client at it, what an agent can do with it, and the safety boundary. The full
 * tool catalog lives in the README; this page stays short enough to read.
 */
import type { ReactNode } from "react";

/** A code sample, styled like the DSL examples elsewhere in the docs. */
function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="ref__code">
      <code>{children}</code>
    </pre>
  );
}

/** One titled block of the reference. */
function Group({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="ref__group" data-testid={testId}>
      <h3 className="ref__group-title">{title}</h3>
      {children}
    </section>
  );
}

export default function McpReference() {
  return (
    <div className="ref" data-testid="mcp-reference">
      <p className="ref__intro">
        The project ships a Model Context Protocol server, so a coding agent —
        OpenCode, Hermes, Claude, Cursor, or anything else that speaks MCP — can
        document an application with the same engine the editor uses. It links
        the same parser, layout, renderer and project index over a Node
        filesystem repository, so a document an agent writes opens here
        unchanged, and a diagnostic it sees is the one the Problems panel shows.
      </p>

      <Group title="Build and run" testId="mcp-build">
        <CodeBlock>{`npm run mcp:build   # bundle mcp/ into dist-mcp/server.mjs
npm run mcp         # build, then run it on the current directory`}</CodeBlock>
        <p className="ref__summary">
          The bundle is self-contained — it has no runtime dependencies — so a
          client only needs <code>node</code>. Point it at any directory:{" "}
          <code>node dist-mcp/server.mjs --workspace ./docs</code>. The
          workspace follows the same model as a folder opened in the app: a
          subdirectory is a project, and inside it <code>.md</code> is a
          document, <code>.eventseq</code> an event flow, and anything else a
          sequence diagram.
        </p>
      </Group>

      <Group title="Connect a client" testId="mcp-clients">
        <p className="ref__summary">
          OpenCode — add to <code>opencode.json</code>:
        </p>
        <CodeBlock>{`{
  "mcp": {
    "sequencediagrams": {
      "type": "local",
      "command": ["node", "/path/to/dist-mcp/server.mjs",
                  "--workspace", "/path/to/docs"],
      "enabled": true
    }
  }
}`}</CodeBlock>
        <p className="ref__summary">
          Hermes — add to <code>~/.hermes/config.yaml</code>:
        </p>
        <CodeBlock>{`mcp_servers:
  sequencediagrams:
    command: "node"
    args: ["/path/to/dist-mcp/server.mjs", "--workspace", "/path/to/docs"]
    tools:
      resources: true
      prompts: true`}</CodeBlock>
        <p className="ref__summary">
          Claude Desktop, Cursor and other <code>mcpServers</code> clients use
          the same command and arguments:
        </p>
        <CodeBlock>{`{
  "mcpServers": {
    "sequencediagrams": {
      "command": "node",
      "args": ["/path/to/dist-mcp/server.mjs", "--workspace", "/path/to/docs"]
    }
  }
}`}</CodeBlock>
      </Group>

      <Group title="Remote MCP for server projects" testId="mcp-remote">
        <p className="ref__summary">
          When you use the hosted server, an agent reaches <em>your</em> server
          projects over the remote MCP endpoint — no local checkout, no
          workspace directory. It authenticates with a{" "}
          <strong>agent credential</strong> presented as a bearer token. Create
          an <strong>agent</strong> and a credential under{" "}
          <strong>Agents</strong> in the toolbar; the secret is shown once and
          cannot be retrieved again.
        </p>
        <CodeBlock>{`{
  "mcpServers": {
    "sequencediagrams": {
      "type": "http",
      "url": "<your-server>/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_PAT>"
      }
    }
  }
}`}</CodeBlock>
        <p className="ref__summary">
          A credential carries a scope: <code>resource:read</code> can only
          read, and <code>resource:write</code> can also create, update, move
          and delete documents. It may be restricted to particular projects, it
          acts as you, and it never widens your own access. Revoking it — or
          disabling its agent — stops it immediately.
        </p>
        <p className="ref__summary">
          Remote MCP is a <em>machine</em> surface: it accepts only the bearer
          token, never your browser session cookie, and a token is never a
          substitute for signing in. Writes preserve optimistic concurrency — an
          agent must send the revision it last read, and a stale write is
          refused with a conflict instead of overwriting a change made here.
        </p>
      </Group>

      <Group title="What an agent can do" testId="mcp-capabilities">
        <ul className="ref__list ref__list--bullets">
          <li>
            <strong>Orient</strong> — list projects, and read a project's
            resources, symbols and diagnostics before writing anything.
          </li>
          <li>
            <strong>Author</strong> — create and edit sequence diagrams, event
            flows and markdown documents, and rename a file while keeping its
            stable <code>resource://</code> id.
          </li>
          <li>
            <strong>Validate</strong> — check a draft before it is written, and
            a document or the whole project after, with the same verdict the
            Problems panel gives.
          </li>
          <li>
            <strong>Render</strong> — produce the SVG the editor would draw, to
            check a diagram or to save it.
          </li>
          <li>
            <strong>Search</strong> — find text and symbol references across the
            project.
          </li>
          <li>
            <strong>Audit</strong> — list what the documentation is missing:
            broken links, untitled or empty files, resources nothing links to,
            and thin prose.
          </li>
        </ul>
        <p className="ref__summary">
          The server also exposes the two language references, a markdown guide
          and two workflow guides as MCP <em>resources</em>, and four{" "}
          <em>prompts</em> — document an application, improve existing
          documentation, diagram one interaction flow, and model an event-driven
          architecture. The complete tool catalog is in the repository README.
        </p>
      </Group>

      <Group title="Safety" testId="mcp-safety">
        <ul className="ref__list ref__list--bullets">
          <li>
            The workspace root is a hard boundary: every file name is validated
            as a single path segment, so an agent cannot write outside the
            directory it was given.
          </li>
          <li>
            <code>delete_resource</code> fails unless it is called with{" "}
            <code>confirm: true</code>, and a host that treats the server as
            untrusted can require approval for every write, because each tool
            declares whether it only reads.
          </li>
          <li>The server opens no network sockets.</li>
        </ul>
        <p className="ref__summary">
          Verify a checkout with <code>npm run test:mcp</code>, which drives the
          bundled server over real stdio.
        </p>
      </Group>
    </div>
  );
}
