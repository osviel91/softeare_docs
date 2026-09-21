/**
 * Re-export of the shared MCP wire vocabulary (Phase 5).
 *
 * The protocol moved to `src/shared/mcp/protocol.ts` when the remote MCP
 * transport landed: it is a wire format two hosts speak, not an implementation
 * detail of the stdio server. This module stays so every existing import — the
 * stdio server, the tool catalog and its tests — keeps working unchanged.
 */
export * from "../src/shared/mcp/protocol";
