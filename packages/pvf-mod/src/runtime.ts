import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseEquDocument, stringifyEquDocument } from "@pvf/equ-ast";
import type { EquDocument, RenderedEquReader } from "@pvf/equ-ast";
import { DEFAULT_TEXT_PROFILE, PvfArchive, normalizeArchivePath } from "@pvf/pvf-core";
import type { PvfOverlayFile, PvfWriteOptions, PvfWriteResult, TextProfile } from "@pvf/pvf-core";

import { resolvePathWithinDirectory } from "./path.ts";

export function compareArchivePaths(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

export function sortOverlays(overlays: readonly PvfOverlayFile[]): PvfOverlayFile[] {
  return [...overlays].sort((left, right) => compareArchivePaths(left.path, right.path));
}

export interface PvfMod<TResult = void> {
  id: string;
  apply(session: PvfModSession): Promise<TResult>;
}

export interface ExecutedPvfModResult<TResult = unknown> {
  modId: string;
  result: TResult;
  overlayCount: number;
}

export interface OpenPvfModSessionOptions {
  archivePath: string;
  archiveId?: string;
  textProfile?: TextProfile;
}

export interface RunPvfModsOptions {
  archivePath: string;
  archiveId?: string;
  textProfile?: TextProfile;
  mods: readonly PvfMod<unknown>[];
}

export interface RunPvfModsResult {
  archivePath: string;
  textProfile: TextProfile;
  overlays: PvfOverlayFile[];
  executedMods: ExecutedPvfModResult<unknown>[];
}

export interface ApplyPvfModsOptions extends RunPvfModsOptions {
  outputPath: string;
}

export interface ApplyPvfModsResult extends RunPvfModsResult, PvfWriteResult {}

function cloneOverlay(overlay: PvfOverlayFile): PvfOverlayFile {
  return typeof overlay.content === "string" || overlay.content === undefined
    ? { ...overlay }
    : { ...overlay, content: Buffer.from(overlay.content) };
}

export class PvfModSession implements RenderedEquReader<TextProfile> {
  readonly archive: PvfArchive;
  readonly archivePath: string;
  readonly textProfile: TextProfile;
  readonly state = new Map<string, unknown>();

  readonly #overlays = new Map<string, PvfOverlayFile>();
  readonly #renderedCache = new Map<string, Promise<string>>();

  constructor(archive: PvfArchive, archivePath: string, textProfile: TextProfile) {
    this.archive = archive;
    this.archivePath = archivePath;
    this.textProfile = textProfile;
  }

  async ensureLoaded(): Promise<void> {
    await this.archive.ensureLoaded();
  }

  hasFile(path: string): boolean {
    const normalizedPath = normalizeArchivePath(path);
    const overlay = this.#overlays.get(normalizedPath);

    if (overlay) {
      return overlay.delete !== true;
    }

    return this.archive.hasFile(normalizedPath);
  }

  getOverlay(path: string): PvfOverlayFile | undefined {
    const overlay = this.#overlays.get(normalizeArchivePath(path));
    return overlay ? cloneOverlay(overlay) : undefined;
  }

  listOverlays(): PvfOverlayFile[] {
    return sortOverlays([...this.#overlays.values()].map((overlay) => cloneOverlay(overlay)));
  }

  setOverlay(overlay: PvfOverlayFile): void {
    const normalizedPath = normalizeArchivePath(overlay.path);
    this.#overlays.set(normalizedPath, cloneOverlay({ ...overlay, path: normalizedPath }));

    for (const cacheKey of this.#renderedCache.keys()) {
      if (cacheKey.endsWith(`:${normalizedPath}`)) {
        this.#renderedCache.delete(cacheKey);
      }
    }
  }

  writeTextFile(path: string, content: string): void {
    this.setOverlay({
      path,
      content,
      mode: "text",
    });
  }

  writeScriptDocument(path: string, document: EquDocument): void {
    this.setOverlay({
      path,
      content: stringifyEquDocument(document),
      mode: "script",
    });
  }

  deleteFile(path: string): void {
    this.setOverlay({
      path,
      delete: true,
    });
  }

  async readRenderedFile(
    path: string,
    textProfile: TextProfile = this.textProfile,
  ): Promise<string> {
    const normalizedPath = normalizeArchivePath(path);
    const overlay = this.#overlays.get(normalizedPath);

    if (overlay) {
      if (overlay.delete) {
        throw new Error(`Cannot read deleted overlay file ${normalizedPath}.`);
      }

      if (typeof overlay.content !== "string") {
        throw new Error(`Overlay ${normalizedPath} is binary and cannot be rendered as text.`);
      }

      return overlay.content;
    }

    const cacheKey = `${textProfile}:${normalizedPath}`;
    const existing = this.#renderedCache.get(cacheKey);

    if (existing) {
      return existing;
    }

    const created = this.archive.readRenderedFile(normalizedPath, textProfile);
    this.#renderedCache.set(cacheKey, created);
    return created;
  }

  async readScriptDocument(path: string): Promise<EquDocument> {
    return parseEquDocument(await this.readRenderedFile(path, this.textProfile));
  }

  async updateScriptDocument(
    path: string,
    updater: (document: EquDocument) => EquDocument | Promise<EquDocument>,
  ): Promise<EquDocument> {
    const nextDocument = await updater(await this.readScriptDocument(path));
    this.writeScriptDocument(path, nextDocument);
    return nextDocument;
  }

  async write(outputPath?: string): Promise<PvfWriteResult> {
    const options: PvfWriteOptions = {
      overlays: this.listOverlays(),
      textProfile: this.textProfile,
    };

    if (outputPath) {
      options.outputPath = outputPath;
    }

    return this.archive.write(options);
  }

  async close(): Promise<void> {
    await this.archive.close();
  }
}

export async function openPvfModSession(
  options: OpenPvfModSessionOptions,
): Promise<PvfModSession> {
  const archivePath = resolve(options.archivePath);
  const archiveId = options.archiveId ?? `pvf-mod-session:${archivePath}`;
  const textProfile = options.textProfile ?? DEFAULT_TEXT_PROFILE;
  const archive = new PvfArchive(archiveId, archivePath);
  const session = new PvfModSession(archive, archivePath, textProfile);
  await session.ensureLoaded();
  return session;
}

export async function runPvfMods(options: RunPvfModsOptions): Promise<RunPvfModsResult> {
  const session = await openPvfModSession(options);

  try {
    const executedMods: ExecutedPvfModResult<unknown>[] = [];

    for (const mod of options.mods) {
      const result = await mod.apply(session);
      executedMods.push({
        modId: mod.id,
        result,
        overlayCount: session.listOverlays().length,
      });
    }

    return {
      archivePath: session.archivePath,
      textProfile: session.textProfile,
      overlays: session.listOverlays(),
      executedMods,
    };
  } finally {
    await session.close();
  }
}

export async function applyPvfMods(
  options: ApplyPvfModsOptions,
): Promise<ApplyPvfModsResult> {
  const session = await openPvfModSession(options);

  try {
    const executedMods: ExecutedPvfModResult<unknown>[] = [];

    for (const mod of options.mods) {
      const result = await mod.apply(session);
      executedMods.push({
        modId: mod.id,
        result,
        overlayCount: session.listOverlays().length,
      });
    }

    const writeResult = await session.write(resolve(options.outputPath));

    return {
      archivePath: session.archivePath,
      textProfile: session.textProfile,
      overlays: session.listOverlays(),
      executedMods,
      ...writeResult,
    };
  } finally {
    await session.close();
  }
}

export async function writeOverlayDirectory(
  outputDir: string,
  overlays: readonly PvfOverlayFile[],
): Promise<void> {
  const resolvedOutputDir = resolve(outputDir);

  for (const overlay of overlays) {
    if (overlay.delete || typeof overlay.content !== "string") {
      throw new Error(`Overlay export only supports text/script files: ${overlay.path}`);
    }

    const outputPath = resolvePathWithinDirectory(
      resolvedOutputDir,
      overlay.path.replaceAll("\\", "/"),
      `Overlay path "${overlay.path}"`,
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, overlay.content, "utf8");
  }
}
