/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API's origin. The browser only ever talks to its own origin (`/api/...`,
// `/auth/...`), so both the dev server and `vite preview` forward those two
// prefixes to the API. Same-origin is not a convenience here: the session is an
// HttpOnly cookie and the browser only attaches it to same-origin requests.
const apiTarget = process.env.SDM_API_TARGET ?? "http://127.0.0.1:8787";
const apiProxy = {
  "/api": { target: apiTarget, changeOrigin: true },
  "/auth": { target: apiTarget, changeOrigin: true },
} as const;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: apiProxy },
  // `vite preview` serves the built bundle; the E2E run points its proxy at the
  // API the smoke script started. Vite 5 honours `preview.proxy` exactly as
  // `server.proxy` is honoured.
  preview: { proxy: apiProxy },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./vitest.setup.ts",
    // The API and persistence suites boot PostgreSQL-in-WASM (PGlite), apply
    // every migration and then run a real `createApp` in `beforeAll`. That is
    // legitimately several seconds of work, and the 10-second default is close
    // enough to it that a loaded machine fails the *hook* rather than an
    // assertion — a red suite that says nothing about the code. The assertions
    // themselves keep the default timeout.
    hookTimeout: 30_000,
    include: [
      "tests/**/*.{test,spec}.{ts,tsx}",
      "src/**/*.{test,spec}.{ts,tsx}",
      "mcp/**/*.{test,spec}.ts",
      "apps/**/*.{test,spec}.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "mcp/**/*.ts", "apps/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "mcp/**/__tests__/**",
      ],
      reporter: ["text", "json-summary", "html"],
    },
  },
});
