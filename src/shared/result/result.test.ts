import { describe, expect, it } from "vitest";
import { err, isErr, isOk, map, mapErr, ok } from "./result";

describe("result", () => {
  it("ok wraps a value and reports success", () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("err wraps an error and reports failure", () => {
    const error = new Error("boom");
    const result = err(error);
    expect(isOk(result)).toBe(false);
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error).toBe(error);
    }
  });

  it("map transforms the success value only", () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(map(err(new Error("x")), (n) => n * 3)).toEqual(err(new Error("x")));
  });

  it("mapErr transforms the error value only", () => {
    const mapped = mapErr(ok(1), () => "wrapped");
    expect(mapped).toEqual(ok(1));

    const mappedErr = mapErr(err(new Error("x")), (e) => String(e));
    expect(mappedErr).toEqual(err("Error: x"));
  });

  it("type guards are mutually exclusive", () => {
    const value = ok(1);
    const failure = err(new Error("x"));
    expect(isOk(value)).not.toBe(isErr(value));
    expect(isOk(failure)).not.toBe(isErr(failure));
  });
});
