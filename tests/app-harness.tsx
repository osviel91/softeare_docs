import { vi } from "vitest";

vi.mock("../src/features/server/use-auth", () => ({
  useAuth: () => ({
    status: "authenticated",
    user: {
      id: "test-user",
      displayName: "Test User",
      email: "test@example.test",
      authType: "session",
      scopes: [],
      accountStatus: "ACTIVE",
    },
    signIn: vi.fn(),
    signInLocal: vi.fn(),
    registerLocal: vi.fn(),
    signOut: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  }),
}));

export { default } from "../src/App";
