// Global test setup: DOM matchers and environment resets.
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

// Ensure the DOM is clean between tests to avoid state leaking across cases.
afterEach(() => {
  cleanup();
});

// Convenience aliases so test files can stay terse.
export { describe, expect, it };
