/** Copy a local project's current documents into a newly created server project. */
import type { Project } from "../../domain/workspace/types";
import { resourceTypeOfName } from "../../domain/workspace/resource-id";
import { isOk } from "../../shared/result/result";
import type { WorkspaceRepository } from "../WorkspaceRepository";
import type { ServerApiClient, ServerProject } from "./api-client";

export async function publishProject(
  client: ServerApiClient,
  source: WorkspaceRepository,
  project: Project,
): Promise<ServerProject> {
  const [diagrams, notes] = await Promise.all([
    source.listDiagramFiles(project.id),
    source.listNoteFiles(project.id),
  ]);
  if (!isOk(diagrams) || !isOk(notes)) {
    throw new Error("Could not read the project's files.");
  }

  const destination = await client.createProject(project.name);
  for (const diagram of diagrams.value) {
    await client.createResource(destination.id, {
      path: diagram.name,
      type: resourceTypeOfName(diagram.name),
      content: diagram.source,
    });
  }
  for (const note of notes.value) {
    await client.createResource(destination.id, {
      path: note.name,
      type: "markdown-document",
      content: note.markdown,
    });
  }
  return destination;
}
