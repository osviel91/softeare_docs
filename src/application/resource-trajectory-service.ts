import type { ApplicationContext } from "./context";
import { createAuthorizationPolicy, type AuthorizationPolicy } from "./authorization";
import { notFound } from "./errors";
import type { ProjectRepository } from "./ports/project-repository";
import type { TrajectoryEntry } from "../domain/workspace/resource-trajectory";

export interface ResourceTrajectoryService {
  getProjectTrajectory(
    context: ApplicationContext,
    projectId: string,
    options?: { limit?: number; cursor?: number },
  ): Promise<{ entries: TrajectoryEntry[]; nextCursor: number | null }>;
  getResourceTrajectory(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    options?: { limit?: number; cursor?: number },
  ): Promise<{ entries: TrajectoryEntry[]; nextCursor: number | null }>;
}

export function createResourceTrajectoryService(options: {
  projects: ProjectRepository;
  policy?: AuthorizationPolicy;
}): ResourceTrajectoryService {
  const policy = options.policy ?? createAuthorizationPolicy(options.projects);
  return {
    async getProjectTrajectory(context, projectId, page) {
      await policy.requirePermission(context, projectId, "resource:read");
      return options.projects.listTrajectory(projectId, page);
    },
    async getResourceTrajectory(context, projectId, resourceId, page) {
      await policy.requirePermission(context, projectId, "resource:read");
      const resource = await options.projects.findResource(projectId, resourceId);
      if (!resource) throw notFound(`No resource with id ${resourceId}.`);
      return options.projects.listTrajectory(projectId, { ...page, resourceId });
    },
  };
}
