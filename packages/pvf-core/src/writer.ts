import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PvfArchive } from "./archive.ts";
import {
  align4,
  createBuffKey,
  encodeFilePath,
  encodeText,
  encryptPvf,
  getFileNameHashCode,
  normalizeArchivePath,
} from "./codec.ts";
import { compilePvfScriptText } from "./script.ts";
import { MutableStringTable } from "./string-table.ts";
import {
  DEFAULT_TEXT_PROFILE,
  type LoadTextOverlayDirectoryOptions,
  type OverlayMode,
  type PvfFileRecord,
  type PvfOverlayFile,
  type TextProfile,
} from "./types.ts";

export type WriteStrategy = "repack";

export interface PvfWriteOptions {
  outputPath?: string;
  overlays: Iterable<PvfOverlayFile>;
  textProfile?: TextProfile;
}

export interface PvfWriteResult {
  outputPath: string | null;
  fileCount: number;
  updatedPaths: string[];
  addedPaths: string[];
  deletedPaths: string[];
  strategy: WriteStrategy;
  bytes: Buffer;
}

interface PreparedEntry {
  fileNameHash: number;
  filePath: string;
  fileNameBytes: Buffer;
  fileLength: number;
  fileCrc32: number;
  alignedLength: number;
  source: "base" | "generated";
  sourceEntry?: PvfFileRecord;
  data?: Buffer;
}

interface NormalizedOverlay extends PvfOverlayFile {
  path: string;
}

function comparePreparedEntries(left: PreparedEntry, right: PreparedEntry): number {
  if (left.fileNameHash !== right.fileNameHash) {
    return left.fileNameHash - right.fileNameHash;
  }

  const nameBytesComparison = Buffer.compare(left.fileNameBytes, right.fileNameBytes);

  if (nameBytesComparison !== 0) {
    return nameBytesComparison;
  }

  if (left.sourceEntry && right.sourceEntry) {
    return left.sourceEntry.treeIndex - right.sourceEntry.treeIndex;
  }

  if (left.sourceEntry) {
    return -1;
  }

  if (right.sourceEntry) {
    return 1;
  }

  return left.filePath.localeCompare(right.filePath, "en");
}

function createPreparedEntry(
  filePath: string,
  data: Buffer,
  sourceEntry?: PvfFileRecord,
): PreparedEntry {
  const normalizedPath = normalizeArchivePath(filePath);
  const fileNameBytes = encodeFilePath(normalizedPath);
  const fileNameHash = getFileNameHashCode(fileNameBytes);
  const padded = Buffer.alloc(align4(data.length));
  data.copy(padded);
  const fileCrc32 = createBuffKey(padded, padded.length, fileNameHash);

  return {
    fileNameHash,
    filePath: normalizedPath,
    fileNameBytes,
    fileLength: data.length,
    fileCrc32,
    alignedLength: padded.length,
    source: "generated",
    ...(sourceEntry ? { sourceEntry } : {}),
    data,
  };
}

function toPreparedBaseEntry(entry: PvfFileRecord): PreparedEntry {
  return {
    fileNameHash: entry.fileNameHash,
    filePath: entry.filePath,
    fileNameBytes: entry.fileNameBytes,
    fileLength: entry.fileLength,
    fileCrc32: entry.fileCrc32,
    alignedLength: entry.alignedLength,
    source: "base",
    sourceEntry: entry,
  };
}

function buildFileTree(entries: readonly PreparedEntry[]): Buffer {
  const totalLength = align4(
    entries.reduce((sum, entry) => sum + entry.fileNameBytes.length + 20, 0),
  );
  const output = Buffer.alloc(totalLength);
  let treeOffset = 0;
  let fileDataOffset = 0;

  for (const entry of entries) {
    output.writeUInt32LE(entry.fileNameHash, treeOffset);
    output.writeInt32LE(entry.fileNameBytes.length, treeOffset + 4);
    entry.fileNameBytes.copy(output, treeOffset + 8);
    output.writeInt32LE(entry.fileLength, treeOffset + 8 + entry.fileNameBytes.length);
    output.writeUInt32LE(entry.fileCrc32, treeOffset + 12 + entry.fileNameBytes.length);
    output.writeInt32LE(fileDataOffset, treeOffset + 16 + entry.fileNameBytes.length);
    treeOffset += entry.fileNameBytes.length + 20;
    fileDataOffset += entry.alignedLength;
  }

  return output;
}

function detectOverlayMode(overlay: PvfOverlayFile): OverlayMode {
  if (overlay.mode && overlay.mode !== "auto") {
    return overlay.mode;
  }

  if (typeof overlay.content !== "string") {
    return "binary";
  }

  return overlay.content.trimStart().toLowerCase().startsWith("#pvf_file") ? "script" : "text";
}

async function materializeOverlayEntry(
  overlay: NormalizedOverlay,
  existingEntry: PvfFileRecord | undefined,
  textProfile: TextProfile,
  getStringTable: () => Promise<MutableStringTable>,
): Promise<PreparedEntry> {
  if (overlay.content === undefined) {
    throw new Error(`Overlay ${overlay.path} is missing content.`);
  }

  const mode = detectOverlayMode(overlay);
  let data: Buffer;

  if (mode === "binary") {
    data = Buffer.from(overlay.content);
  } else if (mode === "text") {
    if (typeof overlay.content !== "string") {
      throw new Error(`Overlay ${overlay.path} must provide string content for text mode.`);
    }

    data = encodeText(overlay.content, textProfile);
  } else if (mode === "script") {
    if (typeof overlay.content !== "string") {
      throw new Error(`Overlay ${overlay.path} must provide string content for script mode.`);
    }

    data = compilePvfScriptText(overlay.content, await getStringTable());
  } else {
    throw new Error(`Unsupported overlay mode for ${overlay.path}.`);
  }

  return createPreparedEntry(overlay.path, data, existingEntry);
}

function normalizeOverlays(overlays: Iterable<PvfOverlayFile>): Map<string, NormalizedOverlay> {
  const normalized = new Map<string, NormalizedOverlay>();

  for (const overlay of overlays) {
    const normalizedPath = normalizeArchivePath(overlay.path);
    normalized.set(normalizedPath, {
      ...overlay,
      path: normalizedPath,
    });
  }

  return normalized;
}

async function getMutableStringTable(
  archive: PvfArchive,
  textProfile: TextProfile,
): Promise<MutableStringTable> {
  if (!archive.hasFile("stringtable.bin")) {
    return MutableStringTable.empty(textProfile);
  }

  return new MutableStringTable(await archive.readDecryptedFile("stringtable.bin"), textProfile);
}

function buildOutputBytes(
  source: PvfArchive,
  finalEntries: readonly PreparedEntry[],
  encryptedFileTree: Buffer,
  fileTreeChecksum: number,
  trailingBytes: Buffer,
): Buffer {
  const headerSize = source.header.headerSize;
  const fileBytesLength = finalEntries.reduce((sum, entry) => sum + entry.alignedLength, 0);
  const totalSize = headerSize + encryptedFileTree.length + fileBytesLength + trailingBytes.length;
  const output = Buffer.alloc(totalSize);
  const headerPrefix = Buffer.alloc(headerSize);
  let position = 0;

  headerPrefix.writeInt32LE(source.header.sizeGuid, 0);
  source.header.guid.copy(headerPrefix, 4);
  const metaStart = 4 + source.header.sizeGuid;
  headerPrefix.writeInt32LE(source.header.fileVersion, metaStart);
  headerPrefix.writeInt32LE(encryptedFileTree.length, metaStart + 4);
  headerPrefix.writeUInt32LE(fileTreeChecksum, metaStart + 8);
  headerPrefix.writeInt32LE(finalEntries.length, metaStart + 12);
  headerPrefix.copy(output, position);
  position += headerPrefix.length;

  encryptedFileTree.copy(output, position);
  position += encryptedFileTree.length;

  for (const entry of finalEntries) {
    if (entry.source === "base" && entry.sourceEntry) {
      source.getEncryptedFileSlice(entry.sourceEntry).copy(output, position);
      position += entry.sourceEntry.alignedLength;
      continue;
    }

    encryptPvf(entry.data ?? Buffer.alloc(0), entry.fileCrc32).copy(output, position);
    position += entry.alignedLength;
  }

  trailingBytes.copy(output, position);
  return output;
}

export async function loadTextOverlayDirectory(
  options: LoadTextOverlayDirectoryOptions,
): Promise<PvfOverlayFile[]> {
  const rootDir = path.resolve(options.rootDir);
  const overlays: PvfOverlayFile[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).replaceAll("\\", "/");

      if (options.ignore?.(relativePath) ?? relativePath === "manifest.json") {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      overlays.push({
        path: relativePath,
        content: await readFile(absolutePath, "utf8"),
        mode: "auto",
      });
    }
  }

  await walk(rootDir);
  overlays.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return overlays;
}

export async function writeArchive(
  source: PvfArchive,
  options: PvfWriteOptions,
): Promise<PvfWriteResult> {
  const textProfile = options.textProfile ?? DEFAULT_TEXT_PROFILE;
  const normalizedOverlays = normalizeOverlays(options.overlays);
  const finalEntries: PreparedEntry[] = [];
  const addedPaths = new Set<string>();
  const updatedPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  const resolvedOutputPath = options.outputPath ? path.resolve(options.outputPath) : null;
  let stringTable: MutableStringTable | undefined;

  await source.ensureLoaded();

  const getStringTable = async (): Promise<MutableStringTable> => {
    if (!stringTable) {
      stringTable = await getMutableStringTable(source, textProfile);
    }

    return stringTable;
  };

  for (const entry of source.entriesInOrder) {
    const overlay = normalizedOverlays.get(entry.filePath);

    if (!overlay) {
      finalEntries.push(toPreparedBaseEntry(entry));
      continue;
    }

    normalizedOverlays.delete(entry.filePath);

    if (entry.filePath === "stringtable.bin") {
      throw new Error(
        "Overlays may not replace stringtable.bin directly; it is managed by the writer.",
      );
    }

    if (overlay.delete) {
      deletedPaths.add(entry.filePath);
      continue;
    }

    finalEntries.push(await materializeOverlayEntry(overlay, entry, textProfile, getStringTable));
    updatedPaths.add(entry.filePath);
  }

  for (const overlay of normalizedOverlays.values()) {
    if (overlay.path === "stringtable.bin") {
      throw new Error(
        "Overlays may not replace stringtable.bin directly; it is managed by the writer.",
      );
    }

    if (overlay.delete) {
      continue;
    }

    finalEntries.push(
      await materializeOverlayEntry(overlay, undefined, textProfile, getStringTable),
    );
    addedPaths.add(overlay.path);
  }

  if (stringTable?.updated || !source.hasFile("stringtable.bin")) {
    const stringTableEntry = createPreparedEntry(
      "stringtable.bin",
      (stringTable ?? (await getStringTable())).toBuffer(),
      source.getFileRecord("stringtable.bin"),
    );
    const existingIndex = finalEntries.findIndex((entry) => entry.filePath === "stringtable.bin");

    if (existingIndex === -1) {
      finalEntries.push(stringTableEntry);
      addedPaths.add("stringtable.bin");
    } else {
      finalEntries[existingIndex] = stringTableEntry;
      updatedPaths.add("stringtable.bin");
    }
  }

  finalEntries.sort(comparePreparedEntries);

  const fileTree = buildFileTree(finalEntries);
  const fileTreeChecksum = createBuffKey(fileTree, fileTree.length, finalEntries.length);
  const encryptedFileTree = encryptPvf(fileTree, fileTreeChecksum);
  const trailingBytes = await source.readTrailingBytes();
  const bytes = buildOutputBytes(
    source,
    finalEntries,
    encryptedFileTree,
    fileTreeChecksum,
    trailingBytes,
  );

  if (resolvedOutputPath) {
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, bytes);
  }

  return {
    outputPath: resolvedOutputPath,
    fileCount: finalEntries.length,
    updatedPaths: Array.from(updatedPaths).sort((left, right) => left.localeCompare(right, "en")),
    addedPaths: Array.from(addedPaths).sort((left, right) => left.localeCompare(right, "en")),
    deletedPaths: Array.from(deletedPaths).sort((left, right) => left.localeCompare(right, "en")),
    strategy: "repack",
    bytes,
  };
}
