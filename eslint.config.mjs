import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const ignores = [
  "**/coverage/**",
  "**/dist/**",
  "**/fixtures/**",
  "**/node_modules/**",
  "**/.pnpm-store/**",
  ".husky/_/**",
];

export default tseslint.config(
  {
    ignores,
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
  {
    files: ["apps/pvf-explorer/public/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: [
      "**/*.{mjs,cjs}",
      "*.config.{js,mjs,cjs}",
      "scripts/**/*.js",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
);
