// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../apps/api/auth/password";

describe("local password verifier", () => {
  it("round-trips a password without accepting a different one", async () => {
    const stored = await hashPassword("a-secure-password-123");

    await expect(
      verifyPassword("a-secure-password-123", stored.salt, stored.hash),
    ).resolves.toBe(true);
    await expect(
      verifyPassword("wrong-password", stored.salt, stored.hash),
    ).resolves.toBe(false);
    expect(stored.salt).not.toContain("a-secure-password");
    expect(stored.hash).not.toContain("a-secure-password");
  });
});
