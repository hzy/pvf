import { readdir } from "node:fs/promises";
import path from "node:path";

import { PvfArchive } from "./pvf.ts";

export interface ArchiveSummary {
  id: string;
  name: string;
  relativePath: string;
  loaded: boolean;
  fileCount: number | null;
}

async function walkFiles(currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath)));
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

export class FixtureStore {
  readonly fixturesDir: string;

  #archives = new Map<string, PvfArchive>();
  #scanned = false;

  constructor(fixturesDir: string) {
    this.fixturesDir = fixturesDir;
  }

  async listArchives(): Promise<ArchiveSummary[]> {
    await this.#scanIfNeeded();

    return Array.from(this.#archives.values())
      .sort((left, right) => left.archiveId.localeCompare(right.archiveId, "en"))
      .map((archive) => ({
        id: archive.archiveId,
        name: archive.displayName,
        relativePath: archive.archiveId,
        loaded: archive.isLoaded,
        fileCount: archive.isLoaded ? archive.fileCount : null,
      }));
  }

  async getArchive(archiveId: string): Promise<PvfArchive> {
    await this.#scanIfNeeded();
    const archive = this.#archives.get(archiveId);

    if (!archive) {
      throw new Error(`Archive not found: ${archiveId}`);
    }

    return archive;
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.#archives.values()).map(async (archive) => archive.close()));
  }

  async #scanIfNeeded(): Promise<void> {
    if (this.#scanned) {
      return;
    }

    const files = await walkFiles(this.fixturesDir);

    for (const file of files) {
      if (path.extname(file).toLowerCase() !== ".pvf") {
        continue;
      }

      const relativePath = path.relative(this.fixturesDir, file).replaceAll("\\", "/");
      this.#archives.set(relativePath, new PvfArchive(relativePath, file));
    }

    this.#scanned = true;
  }
}
