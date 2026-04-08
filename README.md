# pvfParser

Node 24 + TypeScript PVF browser for the files under `fixtures/`.

## Workspace

- Root: `pnpm workspace`
- App: `apps/pvf-explorer`
- Runtime: Node.js native TypeScript execution, no bundler / transpiler

## Commands

```bash
pnpm install
pnpm dev
pnpm bench
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm spellcheck
pnpm typecheck
pnpm check
pnpm test
```

The local explorer starts at `http://127.0.0.1:4318`.

## Contributing

### Install once

```bash
pnpm install --frozen-lockfile
```

This installs dependencies, prepares the local fixture if needed, and installs the Git hooks via `husky`.

### Daily workflow

1. Make your changes.
2. Run `pnpm format` if you touched multiple files or changed layout-heavy code.
3. Run `pnpm check` before pushing.
4. Run `pnpm test` if your change can affect behavior.

### What each check does

- `pnpm lint`: runs `eslint` across the repo.
- `pnpm lint:fix`: applies auto-fixable ESLint changes.
- `pnpm format`: formats supported files with `dprint`.
- `pnpm format:check`: verifies formatting without changing files.
- `pnpm spellcheck`: runs `cspell` on source and docs.
- `pnpm typecheck`: runs workspace TypeScript checks.
- `pnpm check`: the main pre-push sanity check. It runs lint, format check, spellcheck, and typecheck together.

### Pre-commit behavior

`husky` runs `lint-staged` on every commit. The `lint-staged` rules live in the root `package.json`. Only staged files are checked.

- staged `*.{ts,js,mjs,cjs}` files run through `eslint --fix` and `dprint fmt`
- staged `*.{json,jsonc,md,html,css,yml,yaml}` files run through `dprint fmt`
- staged `package.json` files run through `sort-package-json`

If a commit changes formatting unexpectedly, review the staged diff and commit the formatted result.

### When a check fails

- ESLint failure: run `pnpm lint:fix`, then review and fix anything left manually.
- dprint failure: run `pnpm format`.
- cspell failure: either fix the spelling or add the project-specific word to `cspell.json` if it is intentional.
- typecheck failure: fix the TypeScript error instead of weakening the config.

### Repository conventions for these tools

- `dprint` is the source of truth for formatting.
- `eslint` is for code-quality issues that formatting does not cover.
- `cspell` should stay clean; add game-specific vocabulary deliberately, not casually.
- `pnpm check` should stay green locally before opening a PR.
