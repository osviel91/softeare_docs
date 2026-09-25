import { useEffect, useState } from "react";
import type {
  ServerApiClient,
  ServerChangeProposal,
  ServerChangeProposalDiff,
  ServerResource,
} from "../../workspace/server/api-client";
import type { MergeAnalysis } from "../../domain/diff/merge-analysis";

export interface ProjectProposalEntry {
  proposal: ServerChangeProposal;
  resource: ServerResource;
  diff: ServerChangeProposalDiff | null;
  analysis: MergeAnalysis | null;
}

export async function loadProjectProposals(
  client: ServerApiClient,
  projectId: string,
  details = false,
): Promise<ProjectProposalEntry[]> {
  const resources = await client.listResources(projectId);
  const grouped = await Promise.all(
    resources.map(async (resource) =>
      (await client.listChangeProposals(projectId, resource.id)).map(
        (proposal) => ({
          proposal,
          resource,
          diff: null,
          analysis: null,
        }),
      ),
    ),
  );
  const entries = grouped
    .flat()
    .sort(
      (a, b) =>
        Date.parse(b.proposal.updatedAt) - Date.parse(a.proposal.updatedAt),
    );
  if (!details) return entries;
  return Promise.all(
    entries.map(async (entry) => {
      try {
        const [diff, analysis] = await Promise.all([
          client.getChangeProposalDiff(entry.proposal.id),
          client.getChangeProposalMergeAnalysis(entry.proposal.id),
        ]);
        return { ...entry, diff, analysis };
      } catch {
        return entry;
      }
    }),
  );
}

export function useProjectProposalCount(
  client: ServerApiClient,
  projectId: string | null,
): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!projectId) {
      setCount(0);
      return;
    }
    let active = true;
    void loadProjectProposals(client, projectId)
      .then((entries) => {
        if (active)
          setCount(
            entries.filter(({ proposal }) => proposal.status === "open").length,
          );
      })
      .catch(() => {
        if (active) setCount(0);
      });
    return () => {
      active = false;
    };
  }, [client, projectId]);
  return count;
}

export function useResourceProposalCount(
  client: ServerApiClient,
  projectId: string | null,
  resourceId: string | null,
): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!projectId || !resourceId) {
      setCount(0);
      return;
    }
    let active = true;
    void client
      .listChangeProposals(projectId, resourceId)
      .then((items) => {
        if (active)
          setCount(items.filter((item) => item.status === "open").length);
      })
      .catch(() => {
        if (active) setCount(0);
      });
    return () => {
      active = false;
    };
  }, [client, projectId, resourceId]);
  return count;
}

export function useProjectResourceProposalCounts(
  client: ServerApiClient,
  projectId: string | null,
): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!projectId) {
      setCounts({});
      return;
    }
    let active = true;
    void loadProjectProposals(client, projectId)
      .then((entries) => {
        if (!active) return;
        const next: Record<string, number> = {};
        for (const { proposal } of entries) {
          if (proposal.status === "open")
            next[proposal.resourceId] = (next[proposal.resourceId] ?? 0) + 1;
        }
        setCounts(next);
      })
      .catch(() => {
        if (active) setCounts({});
      });
    return () => {
      active = false;
    };
  }, [client, projectId]);
  return counts;
}
