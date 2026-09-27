import js from "@eslint/js";
import playwright from "eslint-plugin-playwright";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", ".apps/", "playwright-report/", "test-results/", "blob-report/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  { files: ["**/*.mjs"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["tests/**/*.ts"],
    ...playwright.configs["flat/recommended"],
    rules: {
      ...playwright.configs["flat/recommended"].rules,
      // Los recorridos de hito son largos y encadenan pasos con test.step y utilidades propias.
      "playwright/expect-expect": ["error", { assertFunctionNames: ["expectMail", "expectUnauthorized"] }],
      "playwright/no-conditional-in-test": "off",
      "playwright/no-skipped-test": ["error", { allowConditional: true }],
    },
  },
);
