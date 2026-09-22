/**
 * The workspace switcher's contract (Phase 4A).
 *
 * The two things worth pinning down are the ones a user notices: anonymous people
 * are told how to reach server projects instead of being shown an empty section,
 * and a signed-in person can see theirs and open one. Everything else is layout.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import WorkspaceSwitcher from "../../../src/features/explorer/WorkspaceSwitcher";
import type { ServerProject } from "../../../src/workspace/server/api-client";

/** A server project listing. */
function project(id: string, name: string): ServerProject {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    ownerId: "u1",
    role: "OWNER",
    resourceCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/** Render the switcher with sensible defaults for the case under test. */
function renderSwitcher(
  overrides: Partial<React.ComponentProps<typeof WorkspaceSwitcher>> = {},
) {
  const handlers = {
    onOpenLocal: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenServerProject: vi.fn(),
    onCreateServerProject: vi.fn(),
  };
  render(
    <WorkspaceSwitcher
      mode="local"
      auth={{ status: "anonymous", user: null }}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("WorkspaceSwitcher", () => {
  it("keeps local mode usable and hides server sources while anonymous", () => {
    const handlers = renderSwitcher({ folderSupported: true });
    fireEvent.click(screen.getByTestId("workspace-local"));
    expect(handlers.onOpenLocal).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("workspace-server-toggle")).toBeNull();
    expect(screen.queryAllByTestId("workspace-server-project")).toHaveLength(0);
  });

  it("collapses local sources", () => {
    renderSwitcher();
    fireEvent.click(screen.getByTestId("workspace-local-toggle"));
    expect(screen.getByTestId("workspace-local-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("workspace-local")).toBeNull();
  });

  it("lists the signed-in user's projects and opens the chosen one", () => {
    const handlers = renderSwitcher({
      auth: {
        status: "authenticated",
        user: {
          id: "u1",
          displayName: "Ada",
          email: "ada@example.test",
          authType: "session",
          scopes: [],
        },
      },
      serverProjects: [project("p1", "Payments"), project("p2", "OSIRIS")],
      activeServerProjectId: "p2",
    });

    const rows = screen.getAllByTestId("workspace-server-project");
    expect(rows.map((row) => row.textContent?.replace("☁", ""))).toEqual([
      "Payments",
      "OSIRIS",
    ]);
    // The open project is marked, so the user can tell where they are.
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(rows[1]).toHaveAttribute("aria-current", "true");

    fireEvent.click(rows[0]);
    expect(handlers.onOpenServerProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1" }),
    );
  });

  it("creates a server project by name and clears the field", () => {
    const handlers = renderSwitcher({
      auth: {
        status: "authenticated",
        user: {
          id: "u1",
          displayName: "Ada",
          email: null,
          authType: "session",
          scopes: [],
        },
      },
    });

    const input = screen.getByTestId(
      "workspace-new-server-project-input",
    ) as HTMLInputElement;
    const submit = screen.getByTestId("workspace-new-server-project-button");
    // A blank name is not a project.
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "  Payments  " } });
    fireEvent.click(submit);

    expect(handlers.onCreateServerProject).toHaveBeenCalledWith("Payments");
    expect(input.value).toBe("");
  });

  it("shows a load failure with a way to retry", () => {
    const onReloadServerProjects = vi.fn();
    renderSwitcher({
      auth: {
        status: "authenticated",
        user: {
          id: "u1",
          displayName: "Ada",
          email: null,
          authType: "session",
          scopes: [],
        },
      },
      serverProjectsError: "The projects could not be loaded.",
      onReloadServerProjects,
    });

    expect(
      screen.getByTestId("workspace-server-projects-error"),
    ).toHaveTextContent("The projects could not be loaded.");
    fireEvent.click(screen.getByTestId("workspace-server-projects-retry"));
    expect(onReloadServerProjects).toHaveBeenCalledTimes(1);
  });

  it("offers the open server project as a local ZIP download", () => {
    const onDownloadLocalCopy = vi.fn();
    renderSwitcher({
      mode: "server",
      auth: {
        status: "authenticated",
        user: {
          id: "u1",
          displayName: "Ada",
          email: null,
          authType: "session",
          scopes: [],
        },
      },
      onDownloadLocalCopy,
    });

    fireEvent.click(screen.getByTestId("workspace-download-local-copy"));
    expect(onDownloadLocalCopy).toHaveBeenCalledTimes(1);
  });
});
