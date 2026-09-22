import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PlatformAdministration from "../../../src/features/server/PlatformAdministration";

describe("PlatformAdministration", () => {
  it("keeps account approval controls in the settings page", () => {
    const onSetUserStatus = vi.fn();
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
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-settings-page")).toBeInTheDocument();
    expect(screen.getByText("Account approval")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Status for grace@example.test"), {
      target: { value: "ACTIVE" },
    });

    expect(onSetUserStatus).toHaveBeenCalledWith("pending", "ACTIVE");
  });
});
