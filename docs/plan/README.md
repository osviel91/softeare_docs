# Plans

This directory holds the mission plans the project is built against. A plan is
written before the work, kept while the work happens, and left in place
afterwards as a record of what was asked for and what was delivered — the
[ADRs](../../ARCHITECTURE.md#7-architectural-decision-records-adrs) explain the
_decisions_; these explain the _intent_.

| Plan                                                                                                    | Status      | Checkpoint            |
| ------------------------------------------------------------------------------------------------------- | ----------- | --------------------- |
| [Phase B — Advanced editor & project intelligence](phase-b-advanced-editor-and-project-intelligence.md) | Implemented | `77e17ef`             |
| [Phase C — Event-driven modeling](phase-c-event-driven-modeling.md)                                     | Implemented | `99362e6` + follow-up |
| [Phase 12 — MCP server for coding agents](phase-12-mcp-server.md)                                       | Implemented | working tree          |
| [Server migration, Phases 0–3](server-migration-0-3.md)                                                 | Implemented | `48242d4` + review    |
| [Server migration, Phase 4](server-migration-4.md)                                                      | Implemented | Phase 4 checkpoint    |

## How a phase is run

1. The mission is recorded here as a plan: goal, deliverables, and the
   boundaries it must not cross.
2. Work proceeds in the slices the plan names, each with its own tests.
3. The phase ends with a checkpoint: `npm test`, `npm run typecheck`,
   `npm run lint`, `npm run format:check`, `npm run build`, and
   `npm run test:e2e` all green, followed by one commit.

## Related documents

- [README.md](../../README.md) — what the application is and how to run it.
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — the layering rules and the ADR log.
