import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  decodeChunk,
  encodeMessage,
  errorResponse,
  isJsonRpcRequest,
  modernProtocolVersionOf,
  successResponse,
  unsupportedProtocolVersion,
} from "../protocol";
import { parseProjectResourceUri } from "../reference";

describe("stdio framing", () => {
  it("separates complete lines and keeps a partial one", () => {
    const first = decodeChunk("", '{"a":1}\n{"b":2}\n{"c":');
    expect(first.messages).toEqual(['{"a":1}', '{"b":2}']);
    expect(first.rest).toBe('{"c":');

    // The partial line is completed by the next chunk instead of being lost.
    const second = decodeChunk(first.rest, "3}\n");
    expect(second.messages).toEqual(['{"c":3}']);
    expect(second.rest).toBe("");
  });

  it("ignores blank lines and trims surrounding whitespace", () => {
    const { messages } = decodeChunk("", '\n  {"a":1}  \n\n');
    expect(messages).toEqual(['{"a":1}']);
  });

  it("encodes a message as exactly one newline-terminated line", () => {
    const encoded = encodeMessage(successResponse(1, { text: "a\nb" }));
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(encoded).result).toEqual({ text: "a\nb" });
  });
});

describe("JSON-RPC helpers", () => {
  it("tells a request from a notification", () => {
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(
      true,
    );
    expect(
      isJsonRpcRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBe(false);
  });

  it("builds successful and failed responses", () => {
    expect(successResponse(7, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
    expect(errorResponse(7, -32601, "nope")).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "nope" },
    });
  });

  it("reports an unsupported version with the versions it does support", () => {
    const response = unsupportedProtocolVersion(3, "1900-01-01");
    expect(response.error?.code).toBe(-32022);
    expect(response.error?.data).toEqual({
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      requested: "1900-01-01",
    });
  });
});

describe("protocol era detection", () => {
  it("reads the version from modern per-request metadata", () => {
    expect(
      modernProtocolVersionOf({
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }),
    ).toBe("2026-07-28");
  });

  it("reports no version for a legacy request", () => {
    expect(modernProtocolVersionOf({ protocolVersion: "2025-06-18" })).toBe(
      null,
    );
    expect(modernProtocolVersionOf(undefined)).toBe(null);
  });

  it("lists the newest revision first and a legacy default", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(LATEST_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(
      DEFAULT_LEGACY_PROTOCOL_VERSION,
    );
  });
});

describe("project resource URIs", () => {
  it("parses a project resource URI", () => {
    expect(
      parseProjectResourceUri(
        "sequencediagrams://project/Payments/resource/diagrams/checkout.seq",
      ),
    ).toEqual({ project: "Payments", path: "diagrams/checkout.seq" });
  });

  it("decodes percent-encoded segments", () => {
    expect(
      parseProjectResourceUri(
        "sequencediagrams://project/My%20Docs/resource/read%20me.md",
      ),
    ).toEqual({ project: "My Docs", path: "read me.md" });
  });

  it("rejects a URI that is not a project resource", () => {
    expect(
      parseProjectResourceUri("sequencediagrams://reference/markdown"),
    ).toBe(null);
    expect(
      parseProjectResourceUri("sequencediagrams://project//resource/x"),
    ).toBe(null);
    expect(parseProjectResourceUri("https://example.com")).toBe(null);
  });
});
