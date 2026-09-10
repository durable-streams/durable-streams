import prettierPlugin from "eslint-plugin-prettier"
import prettierConfig from "eslint-config-prettier"
import stylisticPlugin from "@stylistic/eslint-plugin"
import { tanstackConfig } from "@tanstack/config/eslint"

export default [
  ...tanstackConfig,
  {
    ignores: [
      `**/dist/**`,
      `**/build/**`,
      `**/.output/**`,
      `**/.next/**`,
      `**/.nitro/**`,
      `**/.tanstack/**`,
      `**/.wrangler/**`,
      `**/worker-configuration.d.ts`,
      `**/coverage/**`,
      `docs/.vitepress/**`,
      `eslint.config.js`,
      `vitest.config.ts`,
      `**/vitest.do.config.ts`,
      `**/vite.config.ts`,
      `**/tsdown.config.ts`,
      `**/tsup.config.ts`,
      `packages/caddy-plugin/**`,
      `packages/client-py/**`,
      `scripts/**`,
      `**/bin/**`,
    ],
  },
  {
    plugins: {
      stylistic: stylisticPlugin,
      prettier: prettierPlugin,
    },
    settings: {
      // import-x/* settings required for import/no-cycle.
      "import-x/resolver": { typescript: true },
      "import-x/extensions": [`.ts`, `.tsx`, `.js`, `.jsx`, `.cjs`, `.mjs`],
    },
    rules: {
      "prettier/prettier": `error`,
      "stylistic/quotes": [`error`, `backtick`, { avoidEscape: true }],
      "pnpm/enforce-catalog": `off`,
      "pnpm/json-enforce-catalog": `off`,
      ...prettierConfig.rules,
    },
  },
  {
    files: [`**/*.ts`, `**/*.tsx`],
    languageOptions: {
      parserOptions: {
        // Anchor `project: true` tsconfig discovery to the repo root so
        // typed linting works no matter which working directory the
        // editor's ESLint server picks (e.g. a package with its own
        // eslint.config.js).
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        `error`,
        { argsIgnorePattern: `^_`, varsIgnorePattern: `^_` },
      ],
      "@typescript-eslint/naming-convention": [
        `error`,
        {
          selector: `typeParameter`,
          format: [`PascalCase`],
          leadingUnderscore: `allow`,
        },
      ],
      "import/no-cycle": `error`,
    },
  },
]
