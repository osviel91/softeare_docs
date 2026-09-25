export default function ResourceActionBar({
  proposalCount = 0,
  onHistory,
  onChanges,
}: {
  proposalCount?: number;
  onHistory: () => void;
  onChanges?: () => void;
}) {
  return (
    <nav className="resource-action-bar" aria-label="Resource actions">
      <button
        type="button"
        className="resource-action-bar__action"
        data-testid="resource-history-action"
        onClick={onHistory}
      >
        <span aria-hidden="true">⟲</span> History
      </button>
      {onChanges && proposalCount > 0 && (
        <button
          type="button"
          className="resource-action-bar__action"
          data-testid="resource-changes-action"
          onClick={onChanges}
        >
          <span aria-hidden="true">◇</span> Changes
          <span className="resource-action-bar__badge">{proposalCount}</span>
        </button>
      )}
    </nav>
  );
}
