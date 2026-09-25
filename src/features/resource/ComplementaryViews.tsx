import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";

interface View {
  id: string;
  title: string;
}

interface Props {
  resourceId: string | null;
  relationships: ResourceRelationship[];
  resources: View[];
  onNavigate(id: string): void;
}

export default function ComplementaryViews({
  resourceId,
  relationships,
  resources,
  onNavigate,
}: Props) {
  if (!resourceId) return null;
  const views = relationships.flatMap((relationship) => {
    if (relationship.sourceId !== resourceId && relationship.targetId !== resourceId) return [];
      const targetId = relationship.sourceId === resourceId ? relationship.targetId : relationship.sourceId;
      const target = resources.find((resource) => resource.id === targetId);
      if (!target) return [];
      const role = relationship.sourceId === resourceId ? relationship.targetRole : relationship.sourceRole;
      return [{ ...target, role }];
  });
  if (views.length === 0) return null;
  return (
    <div className="resource-header__relationships" aria-label="Complementary views">
      {views.map((view) => (
        <button key={view.id} type="button" onClick={() => onNavigate(view.id)}>
          Complementary view{view.role ? ` · ${view.role}` : ""} → {view.title}
        </button>
      ))}
    </div>
  );
}
