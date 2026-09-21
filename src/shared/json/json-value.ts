/**
 * A JSON value: what a `jsonb` column may hold.
 *
 * Defined rather than imported from a dependency, like the rest of this
 * project's small foundations, so an audit record's shape is describable with
 * no package involved.
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** An object-shaped JSON value. */
export type JsonObject = { [key: string]: JsonValue };

/** Whether a value can be serialised to JSON without losing its shape. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}
