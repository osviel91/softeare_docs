import { useEffect, useState } from "react";
import type { ResourceMetadata } from "../../domain/workspace/resource-metadata";

interface Props {
  metadata?: ResourceMetadata;
  writable: boolean;
  onSave(metadata: ResourceMetadata): Promise<ResourceMetadata | Error>;
}

export default function ResourceMetadataEditor({
  metadata,
  writable,
  onSave,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(metadata?.description ?? "");
  const [tags, setTags] = useState((metadata?.tags ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setDescription(metadata?.description ?? "");
      setTags((metadata?.tags ?? []).join(", "));
    }
  }, [metadata, editing]);

  const save = async () => {
    setError(null);
    const result = await onSave({
      description,
      tags: tags.split(","),
    });
    if (result instanceof Error) {
      setError(result.message);
      return;
    }
    setEditing(false);
  };

  if (!editing) {
    const hasMetadata = Boolean(
      metadata?.description || metadata?.tags?.length,
    );
    return (
      <div
        className="resource-header__metadata"
        data-testid="resource-metadata"
      >
        {metadata?.description ? (
          <p className="resource-header__description">{metadata.description}</p>
        ) : null}
        {metadata?.tags?.length ? (
          <div className="resource-header__tags" aria-label="Resource tags">
            {metadata.tags.map((tag) => (
              <span className="resource-header__tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {writable ? (
          <button
            className="resource-header__edit"
            type="button"
            onClick={() => setEditing(true)}
            aria-label={
              hasMetadata ? "Edit resource context" : "Add resource context"
            }
          >
            {hasMetadata ? "Edit context" : "Add context"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="resource-header__metadata resource-header__metadata--editing">
      <label>
        Description
        <textarea
          aria-label="Resource description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
        />
      </label>
      <label>
        Tags <span className="resource-header__hint">comma separated</span>
        <input
          aria-label="Resource tags"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
      </label>
      {error ? (
        <p className="resource-header__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="resource-header__actions">
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button type="button" onClick={() => void save()}>
          Save context
        </button>
      </div>
    </div>
  );
}
