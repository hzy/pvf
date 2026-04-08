/* eslint-disable import/no-named-as-default-member */
import js from "@eslint/js";
import markdown from "@eslint/markdown";
import importPlugin from "eslint-plugin-import";
import nodePlugin from "eslint-plugin-n";
import regexpPlugin from "eslint-plugin-regexp";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  // https://eslint.org/docs/latest/use/configure/configuration-files-new#globally-ignoring-files-with-ignores
  {
    ignores: [
      // dependencies
      "**/node_modules/**",
      ".pnpm-store/**",

      // Outputs
      "**/.rslib/**",
      "**/.turbo/**",
      "**/coverage/**",
      "output/**",
      "target/**",
      "**/test/js",
      "**/dist/**",
      "**/lib/**",
      ".changeset/*",
      "**/CHANGELOG.md",
      "**/etc/*.md",
      "website/docs/en/api/**",
      "website/docs/zh/api/**",
      "website/docs/en/changelog/**",
      "website/docs/zh/changelog/**",

      // Test snapshots
      "**/expected/**",
      "**/rspack-expected/**",

      // Configs
      "eslint.config.js",
      "vitest.config.ts",
      "**/rslib.config.ts",
      "packages/**/vitest.config.ts",
    ],
  },
  js.configs.recommended,
  regexpPlugin.configs["flat/recommended"],
  ...markdown.configs.recommended,
  ...markdown.configs.processor,
  // Rules from eslint-plugin-n
  nodePlugin.configs["flat/recommended-module"],
  {
    rules: {
      "n/file-extension-in-import": "off",
      "n/prefer-node-protocol": "error",
      "n/no-extraneous-import": [
        "error",
        {
          allowModules: ["vitest", "preact"],
        },
      ],
      "n/no-unpublished-import": "off",
      "n/no-missing-import": "off",
      "n/hashbang": "off",
    },
  },
  // Rules from eslint-plugin-unicorn
  {
    plugins: {
      unicorn: eslintPluginUnicorn,
    },
    rules: {
      "unicorn/consistent-function-scoping": "error",
      "unicorn/empty-brace-spaces": "error",
      "unicorn/expiring-todo-comments": "error",
      "unicorn/no-abusive-eslint-disable": "error",
      "unicorn/no-anonymous-default-export": "error",
      "unicorn/no-array-callback-reference": "error",
      "unicorn/no-array-push-push": "error",
      "unicorn/no-await-expression-member": "error",
      "unicorn/no-await-in-promise-methods": "error",
      "unicorn/no-console-spaces": "error",
      "unicorn/no-hex-escape": "error",
      "unicorn/no-invalid-remove-event-listener": "error",
      "unicorn/no-lonely-if": "error",
      "unicorn/no-negated-condition": "error",
      "unicorn/no-nested-ternary": "error",
      "no-nested-ternary": "off",
      "unicorn/no-new-array": "error",
    },
  },
  // Import-related
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
      },
      "import/internal-regex": "^@pvf/",
    },
    rules: {
      "import/no-commonjs": "error",
      "import/no-cycle": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      // dprint already owns import declaration/member ordering. Keep ESLint focused on
      // correctness-oriented import rules so the two tools don't fight in CI.
      "import/order": "off",
      "import/consistent-type-specifier-style": "warn",
      "sort-imports": "off",
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.nodeBuiltin,
        ...globals.es2021,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
  },
  {
    files: [
      "apps/pvf-explorer/public/**/*.js",
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Browser bundles legitimately use navigator APIs that eslint-plugin-n
      // interprets as experimental Node globals.
      "n/no-unsupported-features/node-builtins": "off",
    },
  },
  // TypeScript-related
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["**/*.md/**"],
    extends: [
      tseslint.configs.eslintRecommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: {
          allowDefaultProject: ["*.js", "rslib.config.ts", "vitest.config.ts"],
          defaultProject: "./tsconfig.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-generic-constructors": "off",
    },
  },
  // JavaScript-related
  {
    files: ["**/*.{js,jsx,cjs,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // turn off other type-aware rules
      "deprecation/deprecation": "off",
      "@typescript-eslint/internal/no-poorly-typed-ts-props": "off",

      // turn off rules that don't apply to JS code
      "@typescript-eslint/explicit-function-return-type": "off",
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
        jsxPragma: null,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
