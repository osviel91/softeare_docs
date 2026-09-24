import type { ApplicationContext } from "./context";
import { agentIdOf, credentialIdOf, isAgentActor } from "./context";
import { conflict, invalid, notFound, unavailable } from "./errors";
import {
  createAuthorizationPolicy,
  type AuthorizationPolicy,
} from "./authorization";
import type { ProjectRepository } from "./ports/project-repository";
import type { WorkspaceMutationService } from "./workspace-mutations";
import type {
  ChangeProposalChanges,
  ChangeProposalRepository,
  NewChangeProposal,
} from "./ports/change-proposal-repository";
import type { ChangeProposal } from "../domain/workspace/change-proposal";
import type { ResourceAuthorship } from "../domain/workspace/resource-revision";
import { normalizeResourceMetadata } from "../domain/workspace/resource-metadata";
import { diffResources, type ResourceDiff } from "../domain/diff/resource-diff";
import {
  analyzeResourceMerge,
  type MergeAnalysis,
} from "../domain/diff/merge-analysis";
import {
  resourceStateFromProposal,
  resourceStateFromRevision,
  type ResourceState,
} from "../domain/diff/resource-state";

export interface ChangeProposalDiff extends ResourceDiff {
  proposalId: string;
  resourceId: string;
  baseRevision: number;
  currentRevision: number;
  stale: boolean;
  type: ResourceState["type"];
  baseContent: string;
  proposedContent: string;
  baseMetadata?: ResourceState["metadata"];
  proposedMetadata?: ResourceState["metadata"];
}

export interface ChangeProposalService {
  create(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
    input: {
      title: string;
      description?: string;
      baseRevision?: number;
    },
  ): Promise<ChangeProposal>;
  get(context: ApplicationContext, id: string): Promise<ChangeProposal>;
  list(
    context: ApplicationContext,
    projectId: string,
    resourceId: string,
  ): Promise<ChangeProposal[]>;
  update(
    context: ApplicationContext,
    id: string,
    input: ChangeProposalChanges & { expectedVersion: number },
  ): Promise<ChangeProposal>;
  open(
    context: ApplicationContext,
    id: string,
    expectedVersion: number,
  ): Promise<ChangeProposal>;
  close(
    context: ApplicationContext,
    id: string,
    expectedVersion: number,
  ): Promise<ChangeProposal>;
  diff(context: ApplicationContext, id: string): Promise<ChangeProposalDiff>;
  analyzeMerge(context: ApplicationContext, id: string): Promise<MergeAnalysis>;
  merge(
    context: ApplicationContext,
    id: string,
  ): Promise<{
    proposal: ChangeProposal;
    resource: import("./workspace-mutations").ResourceView;
  }>;
}

function authorOf(context: ApplicationContext): ResourceAuthorship {
  return isAgentActor(context.principal)
    ? {
        kind: "agent",
        agentId: agentIdOf(context.principal)!,
        ...(credentialIdOf(context.principal) === null
          ? {}
          : { credentialId: credentialIdOf(context.principal)! }),
        subjectUserId: context.principal.subjectUserId,
      }
    : {
        kind: "user",
        userId: context.principal.subjectUserId,
        subjectUserId: context.principal.subjectUserId,
      };
}

export function createChangeProposalService(options: {
  proposals: ChangeProposalRepository;
  projects: ProjectRepository;
  mutations?: WorkspaceMutationService;
  policy?: AuthorizationPolicy;
}): ChangeProposalService {
  const policy = options.policy ?? createAuthorizationPolicy(options.projects);
  const projectFor = async (
    context: ApplicationContext,
    proposalId: string,
  ) => {
    const proposal = await options.proposals.get(proposalId);
    if (proposal === null)
      throw notFound(`No change proposal with id ${proposalId}.`);
    const resource = await findResource(proposal.resourceId);
    await policy.requirePermission(
      context,
      resource.projectId,
      "resource:read",
    );
    return { proposal, resource };
  };
  const findResource = async (resourceId: string) => {
    const resource = await options.projects.findResourceById(resourceId);
    if (resource) return resource;
    throw notFound(`No resource with id ${resourceId}.`);
  };
  const write = async (context: ApplicationContext, proposalId: string) => {
    const result = await projectFor(context, proposalId);
    await policy.requirePermission(
      context,
      result.resource.projectId,
      "resource:update",
    );
    if (
      result.proposal.status === "closed" ||
      result.proposal.status === "merged"
    )
      throw invalid("Terminal proposals cannot be changed.");
    return result;
  };
  const finish = (
    value: ChangeProposal | null,
    id: string,
    expectedVersion: number,
  ) => {
    if (value) return value;
    throw conflict(
      `Change proposal ${id} changed since version ${expectedVersion}.`,
      {
        expectedVersion,
      },
    );
  };

  return {
    async create(context, projectId, resourceId, input) {
      await policy.requirePermission(context, projectId, "resource:update");
      const resource = await options.projects.findResource(
        projectId,
        resourceId,
      );
      if (!resource) throw notFound(`No resource with id ${resourceId}.`);
      const baseRevision = input.baseRevision ?? resource.revision;
      const base = await options.projects.getRevision(resourceId, baseRevision);
      if (!base)
        throw notFound(
          `No revision ${baseRevision} exists for resource ${resourceId}.`,
        );
      const title = input.title.trim();
      if (!title) throw invalid("A proposal title is required.");
      const proposal: NewChangeProposal = {
        resourceId,
        baseRevision,
        proposedContent: base.content,
        ...(base.metadata === undefined
          ? {}
          : { proposedMetadata: base.metadata }),
        title,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        author: authorOf(context),
      };
      return options.proposals.create(proposal);
    },
    async get(context, id) {
      return (await projectFor(context, id)).proposal;
    },
    async list(context, projectId, resourceId) {
      await policy.requirePermission(context, projectId, "resource:read");
      const resource = await options.projects.findResource(
        projectId,
        resourceId,
      );
      if (!resource) throw notFound(`No resource with id ${resourceId}.`);
      return options.proposals.list(resourceId);
    },
    async update(context, id, input) {
      await write(context, id);
      const changes: ChangeProposalChanges = {
        ...(input.proposedContent === undefined
          ? {}
          : { proposedContent: input.proposedContent }),
        ...(input.proposedMetadata === undefined
          ? {}
          : {
              proposedMetadata: normalizeResourceMetadata(
                input.proposedMetadata,
              ),
            }),
        ...(input.title === undefined ? {} : { title: input.title.trim() }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
      };
      if (changes.title === "") throw invalid("A proposal title is required.");
      return finish(
        await options.proposals.update(id, input.expectedVersion, changes),
        id,
        input.expectedVersion,
      );
    },
    async open(context, id, expectedVersion) {
      const { resource, proposal } = await write(context, id);
      await policy.requirePermission(
        context,
        resource.projectId,
        "resource:update",
      );
      if (proposal.status !== "draft")
        throw invalid("Only draft proposals can be opened.");
      return finish(
        await options.proposals.transition(
          id,
          expectedVersion,
          "draft",
          "open",
        ),
        id,
        expectedVersion,
      );
    },
    async close(context, id, expectedVersion) {
      const { resource, proposal } = await write(context, id);
      await policy.requirePermission(
        context,
        resource.projectId,
        "resource:update",
      );
      if (proposal.status !== "draft" && proposal.status !== "open")
        throw invalid("Only draft or open proposals can be closed.");
      return finish(
        await options.proposals.transition(
          id,
          expectedVersion,
          proposal.status,
          "closed",
        ),
        id,
        expectedVersion,
      );
    },
    async diff(context, id) {
      const { proposal, resource } = await projectFor(context, id);
      const base = await options.projects.getRevision(
        proposal.resourceId,
        proposal.baseRevision,
      );
      if (!base)
        throw notFound(
          `No revision ${proposal.baseRevision} exists for resource ${proposal.resourceId}.`,
        );
      const result = diffResources(
        resourceStateFromRevision(base),
        resourceStateFromProposal(proposal, base.type),
      );
      return {
        ...result,
        proposalId: proposal.id,
        resourceId: proposal.resourceId,
        baseRevision: proposal.baseRevision,
        currentRevision: resource.revision,
        stale: resource.revision !== proposal.baseRevision,
        type: base.type,
        baseContent: base.content,
        proposedContent: proposal.proposedContent,
        ...(base.metadata === undefined ? {} : { baseMetadata: base.metadata }),
        ...(proposal.proposedMetadata === undefined
          ? {}
          : { proposedMetadata: proposal.proposedMetadata }),
      };
    },
    async analyzeMerge(context, id) {
      const { proposal, resource } = await projectFor(context, id);
      const base = await options.projects.getRevision(
        proposal.resourceId,
        proposal.baseRevision,
      );
      const current = await options.projects.getRevision(
        proposal.resourceId,
        resource.revision,
      );
      if (!base)
        throw notFound(
          `No revision ${proposal.baseRevision} exists for resource ${proposal.resourceId}.`,
        );
      if (!current)
        throw notFound(
          `No revision ${resource.revision} exists for resource ${proposal.resourceId}.`,
        );
      return analyzeResourceMerge({
        base: resourceStateFromRevision(base),
        current: resourceStateFromRevision(current),
        proposed: resourceStateFromProposal(proposal, base.type),
        baseRevision: proposal.baseRevision,
        currentRevision: resource.revision,
        proposalVersion: proposal.version,
      });
    },
    async merge(context, id) {
      const { proposal, resource } = await projectFor(context, id);
      await policy.requirePermission(
        context,
        resource.projectId,
        "resource:update",
      );
      if (proposal.status !== "open") {
        throw invalid(
          proposal.status === "closed"
            ? "Closed proposals cannot be merged."
            : proposal.status === "merged"
              ? "Merged proposals cannot be merged again."
              : "Only open proposals can be merged.",
          { reason: "lifecycle", status: proposal.status },
        );
      }
      if (!options.mutations) {
        throw unavailable("The canonical mutation service is not configured.");
      }
      const [base, current] = await Promise.all([
        options.projects.getRevision(
          proposal.resourceId,
          proposal.baseRevision,
        ),
        options.projects.getRevision(proposal.resourceId, resource.revision),
      ]);
      if (!base)
        throw notFound(
          `No revision ${proposal.baseRevision} exists for resource ${proposal.resourceId}.`,
        );
      if (!current)
        throw notFound(
          `No revision ${resource.revision} exists for resource ${proposal.resourceId}.`,
        );
      const analysis = analyzeResourceMerge({
        base: resourceStateFromRevision(base),
        current: resourceStateFromRevision(current),
        proposed: resourceStateFromProposal(proposal, base.type),
        baseRevision: proposal.baseRevision,
        currentRevision: resource.revision,
        proposalVersion: proposal.version,
      });
      if (!analysis.autoMergeable || analysis.candidateState === undefined) {
        throw conflict("Change proposal is not safely mergeable.", {
          reason: "merge_analysis",
          analysis,
        });
      }
      const candidate = analysis.candidateState;
      const currentMetadata = JSON.stringify(current.metadata ?? {});
      const candidateMetadata = JSON.stringify(candidate.metadata ?? {});
      if (
        candidate.content === current.content &&
        candidateMetadata === currentMetadata
      ) {
        throw invalid(
          "The proposal has no changes relative to the current canonical resource.",
          { reason: "no_op", currentRevision: resource.revision },
        );
      }
      const merged = await options.mutations.updateResource(
        context,
        resource.projectId,
        resource.id,
        {
          content: candidate.content,
          expectedRevision: resource.revision,
          ...(candidate.metadata === undefined
            ? {}
            : { metadata: candidate.metadata }),
          proposalMerge: {
            proposalId: proposal.id,
            expectedVersion: proposal.version,
            actor: authorOf(context),
            resultingRevision: resource.revision + 1,
          },
        },
      );
      const result = await options.proposals.get(proposal.id);
      if (!result) throw notFound(`No change proposal with id ${proposal.id}.`);
      return { proposal: result, resource: merged };
    },
  };
}
