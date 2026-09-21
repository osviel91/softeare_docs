/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./vitest.setup.ts",
    include: [
      "tests/**/*.{test,spec}.{ts,tsx}",
      "src/**/*.{test,spec}.{ts,tsx}",
      "mcp/**/*.{test,spec}.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "mcp/**/*.ts"],
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
