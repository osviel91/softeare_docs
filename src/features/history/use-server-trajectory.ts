import { useEffect, useState } from "react";
import type { ServerApiClient, ServerTrajectoryEntry } from "../../workspace/server/api-client";

export function useServerTrajectory(
  client: ServerApiClient,
  projectId: string | null,
  resourceId: string | null,
  enabled: boolean,
): { entries: ServerTrajectoryEntry[]; isLoading: boolean } {
  const [entries, setEntries] = useState<ServerTrajectoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !projectId) {
      setEntries([]);
      return;
    }
    let active = true;
    setIsLoading(true);
    void (resourceId
      ? client.getResourceTrajectory(projectId, resourceId)
      : client.getProjectTrajectory(projectId)
    )
      .then((result) => {
        if (active) setEntries(result.entries);
      })
      .catch(() => {
        if (active) setEntries([]);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, enabled, projectId, resourceId]);
  return { entries, isLoading };
}
