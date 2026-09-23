import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PlatformAdministration from "../../../src/features/server/PlatformAdministration";

describe("PlatformAdministration", () => {
  it("keeps account approval controls in the settings page", () => {
    const onSetUserStatus = vi.fn();
    const onSetWorkspaceMemberRole = vi.fn();
    render(
      <PlatformAdministration
        auth={{
          status: "authenticated",
          user: {
            id: "admin",
            displayName: "Ada",
            email: "ada@example.test",
            authType: "session",
            scopes: [],
            accountStatus: "ACTIVE",
            platformAdmin: true,
          },
        }}
        adminUsers={[
          {
            id: "pending",
            displayName: "Grace",
            email: "grace@example.test",
            status: "PENDING",
            platformAdmin: false,
          },
        ]}
        onSetUserStatus={onSetUserStatus}
        workspaces={[
          {
            id: "workspace-1",
            ownerId: "admin",
            name: "Ada Workspace",
            isDefault: true,
            role: "ADMIN",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ]}
        workspaceMembersByWorkspaceId={{
          "workspace-1": [
            {
              workspaceId: "workspace-1",
              userId: "pending",
              displayName: "Grace",
              email: "grace@example.test",
              role: "EDITOR",
              createdAt: new Date(0).toISOString(),
            },
          ],
        }}
        onSetWorkspaceMemberRole={onSetWorkspaceMemberRole}
        onRemoveWorkspaceMember={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onRenameWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-settings-page")).toBeInTheDocument();
    expect(screen.getByText("Account approval")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Status for grace@example.test"), {
      target: { value: "ACTIVE" },
    });

    expect(onSetUserStatus).toHaveBeenCalledWith("pending", "ACTIVE");
    fireEvent.change(
      screen.getByLabelText("Workspace role for grace@example.test"),
      {
        target: { value: "VIEWER" },
      },
    );
    expect(onSetWorkspaceMemberRole).toHaveBeenCalledWith(
      "workspace-1",
      "pending",
      "VIEWER",
    );
  });
});
