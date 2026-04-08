import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_TEXT_PROFILE,
  type PvfOverlayFile,
  type PvfWriteResult,
  type TextProfile,
} from "@pvf/pvf-core";

import {
  compareArchivePaths,
  openPvfModSession,
  type PvfMod,
  type PvfModSession,
  writeOverlayDirectory,
} from "./runtime.ts";

export interface PvfRegisteredMod<TOptions = unknown, TResult = unknown> {
  id: string;
  description?: string;
  create(options: TOptions | undefined): PvfMod<TResult>;
}

export type PvfModRegistry = ReadonlyMap<string, PvfRegisteredMod>;

export interface PvfPipelineModConfig {
  id: string;
  options?: unknown;
}

export interface PvfPipelineConfig {
  id: string;
  description?: string;
  mods: readonly PvfPipelineModConfig[];
}

export interface ExecutedPvfPipelineMod {
  id: string;
  description?: string;
  options?: unknown;
  overlayCount: number;
  changedPaths: string[];
  result: unknown;
}

export interface PvfPipelineBuildResult {
  archivePath: string;
  textProfile: TextProfile;
  pipelineId: string;
  pipelineDescription?: string;
  mods: ExecutedPvfPipelineMod[];
  overlays: PvfOverlayFile[];
}

export interface PvfPipelineApplyResult extends PvfPipelineBuildResult, PvfWriteResult {
  outputPath: string;
}

export interface PvfPipelineManifest {
  archivePath: string;
  textProfile: TextProfile;
  pipeline: {
    id: string;
    description?: string;
  };
  mods: ExecutedPvfPipelineMod[];
  overlayPaths: string[];
  overlayOutputDir?: string;
  outputPath?: string;
  writeResult?: {
    fileCount: number;
    addedPaths: string[];
    updatedPaths: string[];
    deletedPaths: string[];
  };
}

export interface BuildPvfPipelineOptions {
  archivePath: string;
  textProfile?: TextProfile;
  registry: PvfModRegistry;
  pipeline: PvfPipelineConfig;
  archiveId?: string;
}

export interface ApplyPvfPipelineOptions extends BuildPvfPipelineOptions {
  outputPath: string;
}

function cloneOverlay(overlay: PvfOverlayFile): PvfOverlayFile {
  return typeof overlay.content === "string" || overlay.content === undefined
    ? { ...overlay }
    : { ...overlay, content: Buffer.from(overlay.content) };
}

function serializeOverlayContent(content: PvfOverlayFile["content"]): string | null {
  if (content === undefined) {
    return null;
  }

  return typeof content === "string"
    ? `text:${content}`
    : `binary:${Buffer.from(content).toString("base64")}`;
}

function createOverlaySnapshot(
  overlays: readonly PvfOverlayFile[],
): Map<string, string> {
  return new Map(
    overlays.map((overlay) => [
      overlay.path,
      JSON.stringify({
        delete: overlay.delete === true,
        mode: overlay.mode ?? null,
        content: serializeOverlayContent(overlay.content),
      }),
    ]),
  );
}

function diffOverlayPaths(
  before: readonly PvfOverlayFile[],
  after: readonly PvfOverlayFile[],
): string[] {
  const beforeSnapshot = createOverlaySnapshot(before);
  const afterSnapshot = createOverlaySnapshot(after);
  const changedPaths = new Set<string>();

  for (const [path, signature] of afterSnapshot) {
    if (beforeSnapshot.get(path) !== signature) {
      changedPaths.add(path);
    }
  }

  for (const path of beforeSnapshot.keys()) {
    if (!afterSnapshot.has(path)) {
      changedPaths.add(path);
    }
  }

  return [...changedPaths].sort(compareArchivePaths);
}

function resolvePipelineMod(
  registry: PvfModRegistry,
  config: PvfPipelineModConfig,
): PvfRegisteredMod {
  const resolved = registry.get(config.id);

  if (!resolved) {
    throw new Error(`Unknown mod "${config.id}" in pipeline.`);
  }

  return resolved;
}

async function runPipeline(
  session: PvfModSession,
  options: BuildPvfPipelineOptions,
): Promise<ExecutedPvfPipelineMod[]> {
  const mods: ExecutedPvfPipelineMod[] = [];

  for (const modConfig of options.pipeline.mods) {
    const registeredMod = resolvePipelineMod(options.registry, modConfig);
    const mod = registeredMod.create(modConfig.options);
    const beforeOverlays = session.listOverlays();
    const result = await mod.apply(session);
    const afterOverlays = session.listOverlays();

    mods.push({
      id: registeredMod.id,
      ...(registeredMod.description ? { description: registeredMod.description } : {}),
      ...(modConfig.options !== undefined ? { options: modConfig.options } : {}),
      overlayCount: afterOverlays.length,
      changedPaths: diffOverlayPaths(beforeOverlays, afterOverlays),
      result,
    });
  }

  return mods;
}

async function buildPipelineResult(
  options: BuildPvfPipelineOptions,
): Promise<PvfPipelineBuildResult> {
  const session = await openPvfModSession({
    archiveId: options.archiveId ?? `pvf-pipeline:${options.pipeline.id}`,
    archivePath: options.archivePath,
    textProfile: options.textProfile ?? DEFAULT_TEXT_PROFILE,
  });

  try {
    const mods = await runPipeline(session, options);

    return {
      archivePath: session.archivePath,
      textProfile: session.textProfile,
      pipelineId: options.pipeline.id,
      ...(options.pipeline.description
        ? { pipelineDescription: options.pipeline.description }
        : {}),
      overlays: session.listOverlays().map(cloneOverlay),
      mods,
    };
  } finally {
    await session.close();
  }
}

export function createPvfModRegistry(
  mods: readonly PvfRegisteredMod[],
): Map<string, PvfRegisteredMod> {
  const registry = new Map<string, PvfRegisteredMod>();

  for (const mod of mods) {
    if (registry.has(mod.id)) {
      throw new Error(`Duplicate mod id "${mod.id}" in registry.`);
    }

    registry.set(mod.id, mod);
  }

  return registry;
}

export async function buildPvfPipeline(
  options: BuildPvfPipelineOptions,
): Promise<PvfPipelineBuildResult> {
  return buildPipelineResult(options);
}

export async function applyPvfPipeline(
  options: ApplyPvfPipelineOptions,
): Promise<PvfPipelineApplyResult> {
  const session = await openPvfModSession({
    archiveId: options.archiveId ?? `pvf-pipeline:apply:${options.pipeline.id}`,
    archivePath: options.archivePath,
    textProfile: options.textProfile ?? DEFAULT_TEXT_PROFILE,
  });

  try {
    const mods = await runPipeline(session, options);
    const outputPath = resolve(options.outputPath);
    const writeResult = await session.write(outputPath);

    return {
      archivePath: session.archivePath,
      textProfile: session.textProfile,
      pipelineId: options.pipeline.id,
      ...(options.pipeline.description
        ? { pipelineDescription: options.pipeline.description }
        : {}),
      overlays: session.listOverlays().map(cloneOverlay),
      mods,
      ...writeResult,
      outputPath,
    };
  } finally {
    await session.close();
  }
}

export function createPvfPipelineManifest(
  result: PvfPipelineBuildResult | PvfPipelineApplyResult,
  options: {
    overlayOutputDir?: string;
  } = {},
): PvfPipelineManifest {
  return {
    archivePath: result.archivePath,
    textProfile: result.textProfile,
    pipeline: {
      id: result.pipelineId,
      ...(result.pipelineDescription ? { description: result.pipelineDescription } : {}),
    },
    mods: result.mods,
    overlayPaths: result.overlays.map((overlay) => overlay.path).sort(compareArchivePaths),
    ...(options.overlayOutputDir ? { overlayOutputDir: resolve(options.overlayOutputDir) } : {}),
    ...("outputPath" in result ? { outputPath: result.outputPath } : {}),
    ...("fileCount" in result
      ? {
        writeResult: {
          fileCount: result.fileCount,
          addedPaths: result.addedPaths,
          updatedPaths: result.updatedPaths,
          deletedPaths: result.deletedPaths,
        },
      }
      : {}),
  };
}

export async function writePvfPipelineManifest(
  outputPath: string,
  manifest: PvfPipelineManifest,
): Promise<void> {
  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, JSON.stringify(manifest, null, 2), "utf8");
}

export async function buildPvfPipelineToDirectory(
  options: BuildPvfPipelineOptions & {
    outputDir: string;
    manifestOutputPath?: string;
  },
): Promise<
  { result: PvfPipelineBuildResult; manifest: PvfPipelineManifest; manifestOutputPath: string }
> {
  const result = await buildPvfPipeline(options);
  const outputDir = resolve(options.outputDir);
  await writeOverlayDirectory(outputDir, result.overlays);

  const manifest = createPvfPipelineManifest(result, {
    overlayOutputDir: outputDir,
  });
  const manifestOutputPath = resolve(options.manifestOutputPath ?? `${outputDir}/manifest.json`);
  await writePvfPipelineManifest(manifestOutputPath, manifest);

  return {
    result,
    manifest,
    manifestOutputPath,
  };
}
