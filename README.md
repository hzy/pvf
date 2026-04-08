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

## Mod Pipelines

The repository now has a workspace-based mod pipeline system:

- shared runtime and pipeline helpers live in `packages/pvf-mod`
- individual mods live in `mods/*`
- the pipeline registry lives in `mods/registry.ts`
- named pipeline configs live in `mods/pipelines.ts`
- the CLI entrypoint lives in `apps/pvf-mod-cli`

### Built-in mods

- `example_wild_strawberry_hp_up`: changes Wild Strawberry HP recovery from `60` to `600`
- `2_3_choro_partset_skill_up`: generates the merged Choro support equipment overlays

### Built-in pipelines

- `wild-strawberry-only`: runs only the Wild Strawberry example mod
- `demo`: runs `example_wild_strawberry_hp_up -> 2_3_choro_partset_skill_up`

`demo` is the current default pipeline.

### List available pipelines and mods

```bash
pnpm --filter pvf-mod-cli start list
```

### Build overlays to a directory

This runs the selected pipeline in order, writes the final merged overlays to a directory, and emits a manifest JSON file.

```bash
pnpm --filter pvf-mod-cli start build --pipeline demo
```

By default this writes to `out/<pipeline-id>/` and writes `manifest.json` in that directory.

Useful flags:

- `--pipeline <id>`: choose a named pipeline from `mods/pipelines.ts`
- `--archive <path>`: read from a different source PVF instead of `fixtures/Script.pvf`
- `--out <dir>`: override the overlay output directory
- `--manifest-out <path>`: override the manifest output path
- `--text-profile simplified|traditional`: choose rendered text profile

Example:

```bash
pnpm --filter pvf-mod-cli start build \
  --pipeline wild-strawberry-only \
  --out ./out/wild-strawberry \
  --manifest-out ./out/wild-strawberry/manifest.json
```

### Apply a pipeline to produce a new PVF

This runs the selected pipeline in order and writes a new PVF file with all overlays applied.

```bash
pnpm --filter pvf-mod-cli start apply --pipeline demo
```

By default this writes to `out/<pipeline-id>.pvf` and also writes `<output>.manifest.json`.

Useful flags:

- `--pipeline <id>`: choose a named pipeline
- `--archive <path>`: input PVF path
- `--pvf-out <path>`: output PVF path
- `--manifest-out <path>`: manifest output path
- `--text-profile simplified|traditional`: rendered text profile

Example:

```bash
pnpm --filter pvf-mod-cli start apply \
  --pipeline demo \
  --pvf-out ./out/demo.pvf \
  --manifest-out ./out/demo.manifest.json
```

### Build an ad-hoc pipeline from explicit mod order

If you want to test a temporary sequence without editing `mods/pipelines.ts`, pass repeated `--mod` flags. The order of `--mod` flags is the execution order.

```bash
pnpm --filter pvf-mod-cli start build \
  --pipeline adhoc-preview \
  --mod example_wild_strawberry_hp_up \
  --mod 2_3_choro_partset_skill_up
```

### Adding a new mod

1. Create a new folder in `mods/<your_mod>/`.
2. Export a `PvfRegisteredMod` from `src/index.ts`.
3. Keep the mod focused on patch logic only. Do not put standalone CLI or manifest writing logic in the mod package.
4. Add the mod to `mods/registry.ts`.
5. Add it to a named pipeline in `mods/pipelines.ts`, or run it ad hoc with repeated `--mod`.

The runtime guarantees that mods run sequentially, and mod `n + 1` reads the merged final result produced by mods `1..n`.

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
