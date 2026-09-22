import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LoginScreen from "../../../src/features/server/LoginScreen";
import type { AuthHook } from "../../../src/features/server/use-auth";

function auth(overrides: Partial<AuthHook> = {}): AuthHook {
  return {
    status: "anonymous",
    user: null,
    signIn: vi.fn(),
    signInLocal: vi.fn().mockResolvedValue(undefined),
    registerLocal: vi.fn().mockResolvedValue("Awaiting approval"),
    signOut: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("LoginScreen", () => {
  it("offers local registration and Google without rendering the app", async () => {
    const currentAuth = auth();
    render(<LoginScreen auth={currentAuth} />);

    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create a local account" }));
    fireEvent.change(screen.getByTestId("login-display-name"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByTestId("login-email"), {
      target: { value: "ada@example.test" },
    });
    fireEvent.change(screen.getByTestId("login-password"), {
      target: { value: "a-secure-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(currentAuth.registerLocal).toHaveBeenCalledWith(
        "ada@example.test",
        "a-secure-password-123",
        "Ada",
      ),
    );
    expect(await screen.findByTestId("login-message")).toHaveTextContent(
      "Awaiting approval",
    );
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
  });

  it("offers an invitation code entry point", () => {
    render(<LoginScreen auth={auth()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Invitation code" }));
    expect(screen.getByTestId("login-invitation-code")).toBeInTheDocument();
  });
});
