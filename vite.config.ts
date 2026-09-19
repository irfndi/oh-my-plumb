import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    printWidth: 100,
    singleQuote: false,
    trailingComma: "all",
    semi: true,
    sortPackageJson: false,
    ignorePatterns: [
      "node_modules",
      "dist",
      "pnpm-lock.yaml",
      "packages/cli/skills",
      ".oh-my-plumb",
    ],
  },
});
