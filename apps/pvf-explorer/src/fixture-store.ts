import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { TextProfile } from "@pvf/pvf-core";

import { PvfArchive } from "./pvf.ts";

export interface ArchiveSummary {
  id: string;
  name: string;
  relativePath: string;
  loaded: boolean;
  fileCount: number | null;
}

export interface ArchiveEditSession {
  id: string;
  archive: string;
  path: string;
  textProfile: TextProfile;
  version: number;
}

export interface ArchiveFileContent {
  archive: string;
  path: string;
  textProfile: TextProfile;
  editable: boolean;
  content: string;
  session: ArchiveEditSession | null;
}

interface StoredSession {
  id: string;
  archiveId: string;
  path: string;
  textProfile: TextProfile;
  archiveVersion: number;
  version: number;
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

function toPublicSession(session: StoredSession): ArchiveEditSession {
  return {
    id: session.id,
    archive: session.archiveId,
    path: session.path,
    textProfile: session.textProfile,
    version: session.version,
  };
}

export class FixtureStore {
  readonly fixturesDir: string;

  #archives = new Map<string, PvfArchive>();
  #archiveVersions = new Map<string, number>();
  #sessions = new Map<string, StoredSession>();
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

  async openArchiveFile(
    archiveId: string,
    filePath: string,
    textProfile: TextProfile,
  ): Promise<ArchiveFileContent> {
    const archive = await this.getArchive(archiveId);
    await archive.ensureLoaded();
    const editable = await archive.isStructuredScriptFile(filePath);
    const session = editable
      ? this.#createSession(archiveId, filePath, textProfile)
      : null;

    return {
      archive: archiveId,
      path: filePath,
      textProfile,
      editable,
      content: await archive.readRenderedFile(filePath, textProfile),
      session: session ? toPublicSession(session) : null,
    };
  }

  async saveArchiveSession(
    sessionId: string,
    content: string,
    expectedVersion: number,
  ): Promise<ArchiveFileContent> {
    const session = this.#getSession(sessionId);

    if (session.version !== expectedVersion) {
      throw new Error(`Edit session version mismatch: ${session.path}`);
    }

    const archive = await this.getArchive(session.archiveId);
    await archive.ensureLoaded();

    if (this.#getArchiveVersion(session.archiveId) !== session.archiveVersion) {
      throw new Error(`Edit session is stale for ${session.path}`);
    }

    await archive.overwrite({
      textProfile: session.textProfile,
      overlays: [
        {
          path: session.path,
          content,
          mode: "script",
        },
      ],
    });

    const nextArchiveVersion = this.#getArchiveVersion(session.archiveId) + 1;
    this.#archiveVersions.set(session.archiveId, nextArchiveVersion);
    session.archiveVersion = nextArchiveVersion;
    session.version += 1;

    return {
      archive: session.archiveId,
      path: session.path,
      textProfile: session.textProfile,
      editable: true,
      content: await archive.readRenderedFile(session.path, session.textProfile),
      session: toPublicSession(session),
    };
  }

  closeArchiveSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  async close(): Promise<void> {
    this.#sessions.clear();
    await Promise.all(Array.from(this.#archives.values()).map(async (archive) => archive.close()));
  }

  #createSession(
    archiveId: string,
    filePath: string,
    textProfile: TextProfile,
  ): StoredSession {
    const session: StoredSession = {
      id: randomUUID(),
      archiveId,
      path: filePath,
      textProfile,
      archiveVersion: this.#getArchiveVersion(archiveId),
      version: 1,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  #getSession(sessionId: string): StoredSession {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      throw new Error(`Edit session not found: ${sessionId}`);
    }

    return session;
  }

  #getArchiveVersion(archiveId: string): number {
    return this.#archiveVersions.get(archiveId) ?? 0;
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
      this.#archiveVersions.set(relativePath, 0);
    }

    this.#scanned = true;
  }
}
