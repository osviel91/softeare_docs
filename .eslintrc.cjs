module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  settings: {
    react: { version: "detect" },
  },
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/explicit-module-boundary-types": "off",
  },
  ignorePatterns: [
    "dist/",
    "dist-mcp/",
    "dist-api/",
    "node_modules/",
    "coverage/",
    "vite.config.ts",
    "vitest.setup.ts",
  ],
};
