/** Stored semantic metadata for a project resource.
 *
 * This is intentionally separate from resource identity, content, and derived
 * presentation information. It is not attached to a persisted resource yet.
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
