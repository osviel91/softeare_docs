/** Stored semantic metadata for a project resource.
 *
 * This is intentionally separate from resource identity, content, and derived
 * presentation information.
 */
export interface ResourceMetadata {
  description?: string;
  tags?: string[];
}

/**
 * Normalize metadata without changing the input.
 *
 * Descriptions keep meaningful internal whitespace, including newlines. Tags
 * use the first spelling encountered while duplicate matching is insensitive
 * to case.
 */
export function normalizeResourceMetadata(
  metadata: ResourceMetadata = {},
): ResourceMetadata {
  const description = metadata.description?.trim();
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const tag of metadata.tags ?? []) {
    const trimmed = tag.trim();
    const key = trimmed.toLowerCase();
    if (trimmed !== "" && !seen.has(key)) {
      seen.add(key);
      tags.push(trimmed);
    }
  }

  return {
    ...(description ? { description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** Parse the optional JSON representation, treating invalid legacy values as absent. */
export function parseResourceMetadata(value: unknown): ResourceMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (
    (input.description !== undefined && typeof input.description !== "string") ||
    (input.tags !== undefined &&
      (!Array.isArray(input.tags) ||
        !input.tags.every((tag) => typeof tag === "string")))
  ) {
    return undefined;
  }
  const normalized = normalizeResourceMetadata({
    ...(typeof input.description === "string"
      ? { description: input.description }
      : {}),
    ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
  });
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}
