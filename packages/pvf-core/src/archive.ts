import { readFile } from "node:fs/promises";

import {
  decodeFilePath,
  decodeText,
  decryptPvf,
  isStructuredScriptChunk,
  normalizeArchivePath,
  readFloatString,
  splitLines,
  toBufferView,
  toDataView,
} from "./codec.ts";
import { LazyStringTable } from "./string-table.ts";
import {
  DEFAULT_TEXT_PROFILE,
  type DirectoryItem,
  type PvfFileRecord,
  type PvfHeader,
  type TextProfile,
} from "./types.ts";
import { type PvfWriteOptions, type PvfWriteResult, writeArchive } from "./writer.ts";

const HEADER_TAIL_SIZE = 16;
const ROOT_PATH = "";

interface DirectoryNode {
  name: string;
  path: string;
  directories: Map<string, DirectoryNode>;
  files: Map<string, PvfFileRecord>;
}

interface TextResources {
  stringTable: LazyStringTable;
  nStringPathsByIndex: Map<number, string>;
  nStringFiles: Map<string, Map<string, string>>;
}

function createDirectoryNode(name: string, pathValue: string): DirectoryNode {
  return {
    name,
    path: pathValue,
    directories: new Map(),
    files: new Map(),
  };
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

export class PvfArchive {
  readonly archiveId: string;
  readonly displayName: string;
  readonly filePath: string;

  #seedBytes: Buffer | undefined;
  #sourceBytes: Buffer | undefined;
  #header: PvfHeader | undefined;
  #root = createDirectoryNode(ROOT_PATH, ROOT_PATH);
  #entriesByPath = new Map<string, PvfFileRecord>();
  #entriesInOrder: PvfFileRecord[] = [];
  #textResourcesByProfile = new Map<TextProfile, TextResources>();
  #loaded = false;
  #loading: Promise<void> | undefined;

  constructor(archiveId: string, filePath: string, sourceBytes?: Uint8Array) {
    this.archiveId = archiveId;
    this.displayName = archiveId.split("/").at(-1) ?? archiveId;
    this.filePath = filePath;
    this.#seedBytes = sourceBytes ? toBufferView(sourceBytes) : undefined;
  }

  static fromBytes(
    archiveId: string,
    sourceBytes: Uint8Array,
    filePath = `[memory]/${archiveId}`,
  ): PvfArchive {
    return new PvfArchive(archiveId, filePath, sourceBytes);
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  get fileCount(): number {
    return this.#entriesByPath.size;
  }

  get header(): PvfHeader {
    if (!this.#header) {
      throw new Error("PVF header is not loaded.");
    }

    return this.#header;
  }

  get entriesInOrder(): readonly PvfFileRecord[] {
    return this.#entriesInOrder;
  }

  async ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    if (!this.#loading) {
      this.#loading = this.#load();
    }

    await this.#loading;
  }

  async close(): Promise<void> {
    this.#sourceBytes = undefined;
    this.#header = undefined;
    this.#root = createDirectoryNode(ROOT_PATH, ROOT_PATH);
    this.#entriesByPath.clear();
    this.#entriesInOrder = [];
    this.#textResourcesByProfile.clear();
    this.#loaded = false;
    this.#loading = undefined;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async write(options: PvfWriteOptions): Promise<PvfWriteResult> {
    return writeArchive(this, options);
  }

  async overwrite(
    options: Omit<PvfWriteOptions, "outputPath"> & { outputPath?: string },
  ): Promise<PvfWriteResult> {
    const result = await this.write({
      ...options,
      outputPath: options.outputPath ?? this.filePath,
    });
    await this.replaceBytes(result.bytes);
    return result;
  }

  async replaceBytes(sourceBytes: Uint8Array): Promise<void> {
    await this.close();
    this.#seedBytes = toBufferView(sourceBytes);
    await this.ensureLoaded();
  }

  listDirectory(pathValue = ROOT_PATH): DirectoryItem[] {
    const node = this.#getDirectory(pathValue);
    const directories = Array.from(node.directories.values())
      .sort((left, right) => compareNames(left.name, right.name))
      .map<DirectoryItem>((directory) => ({
        kind: "directory",
        name: directory.name,
        path: directory.path,
      }));
    const files = Array.from(node.files.values())
      .sort((left, right) => compareNames(left.fileName, right.fileName))
      .map<DirectoryItem>((record) => ({
        kind: "file",
        name: record.fileName,
        path: record.displayPath,
      }));

    return [...directories, ...files];
  }

  hasFile(pathValue: string): boolean {
    return this.#entriesByPath.has(normalizeArchivePath(pathValue));
  }

  getFileRecord(pathValue: string): PvfFileRecord | undefined {
    return this.#entriesByPath.get(normalizeArchivePath(pathValue));
  }

  async readDecryptedFile(pathValue: string | PvfFileRecord): Promise<Buffer> {
    await this.ensureLoaded();
    const record = typeof pathValue === "string" ? this.#getFile(pathValue) : pathValue;
    return decryptPvf(this.getEncryptedFileSlice(record), record.alignedLength, record.fileCrc32)
      .subarray(0, record.fileLength);
  }

  getEncryptedFileSlice(pathValue: string | PvfFileRecord): Buffer {
    const record = typeof pathValue === "string" ? this.#getFile(pathValue) : pathValue;
    const bytes = this.#getSourceBytes();
    return bytes.subarray(record.absoluteOffset, record.absoluteOffset + record.alignedLength);
  }

  async readTrailingBytes(): Promise<Buffer> {
    await this.ensureLoaded();
    const bytes = this.#getSourceBytes();
    const trailingOffset = this.#entriesInOrder.reduce(
      (current, entry) => Math.max(current, entry.absoluteOffset + entry.alignedLength),
      this.header.headerSize + this.header.dirTreeLength,
    );

    return bytes.subarray(trailingOffset);
  }

  async readRenderedFile(
    pathValue: string,
    textProfile: TextProfile = DEFAULT_TEXT_PROFILE,
  ): Promise<string> {
    const record = this.#getFile(pathValue);
    const bytes = await this.readDecryptedFile(record);

    if (!isStructuredScriptChunk(bytes)) {
      return this.#renderPlainTextFile(record, bytes, textProfile);
    }

    const textResources = await this.#getTextResources(textProfile);
    return this.#renderStructuredFile(bytes, textResources);
  }

  async #load(): Promise<void> {
    const sourceBytes = this.#seedBytes ?? await readFile(this.filePath);
    this.#sourceBytes = sourceBytes;
    this.#header = this.#readHeader(sourceBytes);
    const treeStart = this.#header.headerSize;
    const treeEnd = treeStart + this.#header.dirTreeLength;
    const fileTree = decryptPvf(
      sourceBytes.subarray(treeStart, treeEnd),
      this.#header.dirTreeLength,
      this.#header.dirTreeChecksum,
    );
    this.#parseDirectoryTree(fileTree);
    this.#loaded = true;
  }

  #readHeader(bytes: Uint8Array): PvfHeader {
    const view = toDataView(bytes);
    const sizeGuid = view.getInt32(0, true);
    const headerSize = 4 + sizeGuid + HEADER_TAIL_SIZE;
    const metaStart = 4 + sizeGuid;
    const buffer = toBufferView(bytes);

    return {
      sizeGuid,
      guid: buffer.subarray(4, metaStart),
      fileVersion: view.getInt32(metaStart, true),
      dirTreeLength: view.getInt32(metaStart + 4, true),
      dirTreeChecksum: view.getUint32(metaStart + 8, true),
      numFilesInDirTree: view.getInt32(metaStart + 12, true),
      headerSize,
    };
  }

  #parseDirectoryTree(treeBytes: Uint8Array): void {
    const view = toDataView(treeBytes);
    const buffer = toBufferView(treeBytes);
    this.#entriesInOrder = new Array<PvfFileRecord>(this.header.numFilesInDirTree);
    let offset = 0;

    for (let treeIndex = 0; treeIndex < this.header.numFilesInDirTree; treeIndex += 1) {
      const fileNameHash = view.getUint32(offset, true);
      const filePathLength = view.getInt32(offset + 4, true);
      const pathStart = offset + 8;
      const pathEnd = pathStart + filePathLength;
      const fileNameBytes = buffer.subarray(pathStart, pathEnd);
      const fileLength = view.getInt32(offset + 8 + filePathLength, true);
      const fileCrc32 = view.getUint32(offset + 12 + filePathLength, true);
      const relativeOffset = view.getInt32(offset + 16 + filePathLength, true);
      const displayPath = decodeFilePath(fileNameBytes);
      const filePath = normalizeArchivePath(displayPath);
      const fileNameStart = displayPath.lastIndexOf("/") + 1;
      const fileName = displayPath.slice(fileNameStart);
      const record: PvfFileRecord = {
        treeIndex,
        fileNameHash,
        filePath,
        displayPath,
        fileName,
        fileNameBytes,
        fileLength,
        fileCrc32,
        relativeOffset,
        absoluteOffset: this.header.headerSize + this.header.dirTreeLength + relativeOffset,
        alignedLength: (fileLength + 3) & ~3,
      };

      this.#entriesByPath.set(filePath, record);
      this.#entriesInOrder[treeIndex] = record;
      this.#insertFile(record);
      offset += filePathLength + 20;
    }
  }

  #insertFile(record: PvfFileRecord): void {
    let current = this.#root;
    const lastSlashIndex = record.filePath.lastIndexOf("/");
    let segmentStart = 0;

    while (segmentStart < lastSlashIndex) {
      const slashIndex = record.filePath.indexOf("/", segmentStart);

      if (slashIndex === -1) {
        break;
      }

      const segment = record.filePath.slice(segmentStart, slashIndex);
      let next = current.directories.get(segment);

      if (!next) {
        const nextPath = current.path.length === 0 ? segment : `${current.path}/${segment}`;
        next = createDirectoryNode(segment, nextPath);
        current.directories.set(segment, next);
      }

      current = next;
      segmentStart = slashIndex + 1;
    }

    current.files.set(record.fileName, record);
  }

  async #getTextResources(textProfile: TextProfile): Promise<TextResources> {
    const existing = this.#textResourcesByProfile.get(textProfile);

    if (existing) {
      return existing;
    }

    const stringTableRecord = this.#getFile("stringtable.bin");
    const stringTableBytes = await this.readDecryptedFile(stringTableRecord);
    const stringTable = new LazyStringTable(stringTableBytes, textProfile);
    const nStringPathsByIndex = await this.#loadNStringIndex(stringTable);
    const textResources: TextResources = {
      stringTable,
      nStringPathsByIndex,
      nStringFiles: new Map(),
    };

    this.#textResourcesByProfile.set(textProfile, textResources);
    return textResources;
  }

  async #loadNStringIndex(stringTable: LazyStringTable): Promise<Map<number, string>> {
    const record = this.getFileRecord("n_string.lst");

    if (!record) {
      return new Map();
    }

    const bytes = await this.readDecryptedFile(record);
    const view = toDataView(bytes);

    if (bytes.length < 2 || view.getUint16(0, true) !== 53424) {
      return new Map();
    }

    const pathsByIndex = new Map<number, string>();

    for (let offset = 2; offset + 10 <= bytes.length; offset += 10) {
      const indexKind = bytes[offset] ?? -1;
      const pathKind = bytes[offset + 5] ?? -1;

      if (indexKind !== 2 || pathKind !== 7) {
        continue;
      }

      const linkIndex = view.getInt32(offset + 1, true);
      const pathIndex = view.getInt32(offset + 6, true);
      const pathValue = stringTable.get(pathIndex);

      if (pathValue.length > 0) {
        pathsByIndex.set(linkIndex, normalizeArchivePath(pathValue));
      }
    }

    return pathsByIndex;
  }

  async #loadNStringFile(
    filePath: string,
    textProfile: TextProfile,
    textResources: TextResources,
  ): Promise<Map<string, string>> {
    const cached = textResources.nStringFiles.get(filePath);

    if (cached) {
      return cached;
    }

    const record = this.getFileRecord(filePath);

    if (!record) {
      return new Map();
    }

    const content = decodeText(await this.readDecryptedFile(record), textProfile);
    const values = new Map<string, string>();

    for (const line of splitLines(content)) {
      const divider = line.indexOf(">");

      if (divider <= 0) {
        continue;
      }

      values.set(line.slice(0, divider), line.slice(divider + 1));
    }

    textResources.nStringFiles.set(filePath, values);
    return values;
  }

  async #renderStructuredFile(bytes: Buffer, textResources: TextResources): Promise<string> {
    const view = toDataView(bytes);
    const chunks: string[] = ["#PVF_File\r\n"];
    let pendingLinkIndex: number | null = null;

    for (let offset = 2; offset + 5 <= bytes.length; offset += 5) {
      const kind = bytes[offset] ?? -1;
      const value = view.getInt32(offset + 1, true);

      if (kind === 9) {
        pendingLinkIndex = value;
        continue;
      }

      if (kind === 10) {
        const key = textResources.stringTable.get(value);
        const resolved = pendingLinkIndex === null
          ? ""
          : await this.#resolveNStringValue(
            pendingLinkIndex,
            key,
            textResources.stringTable.textProfile,
            textResources,
          );
        chunks.push(`<${pendingLinkIndex ?? 0}::${key}\`${resolved}\`>\r\n`);
        pendingLinkIndex = null;
        continue;
      }

      if (kind === 7) {
        chunks.push(`\`${textResources.stringTable.get(value)}\`\r\n`);
        pendingLinkIndex = null;
        continue;
      }

      if (kind === 2) {
        chunks.push(`${value}\t`);
        pendingLinkIndex = null;
        continue;
      }

      if (kind === 4) {
        chunks.push(`${readFloatString(value)}\t`);
        pendingLinkIndex = null;
        continue;
      }

      if (kind === 5) {
        chunks.push(`\r\n${textResources.stringTable.get(value)}\r\n`);
        pendingLinkIndex = null;
        continue;
      }

      if (kind === 6 || kind === 8) {
        chunks.push(`{${kind}=\`${textResources.stringTable.get(value)}\`}\r\n`);
        pendingLinkIndex = null;
      }
    }

    chunks.push("\r\n");
    return chunks.join("");
  }

  #renderPlainTextFile(record: PvfFileRecord, bytes: Buffer, textProfile: TextProfile): string {
    const decoded = decodeText(bytes, textProfile);
    return decoded.length > 0 ? decoded : `[binary file] ${record.displayPath}`;
  }

  async #resolveNStringValue(
    linkIndex: number,
    key: string,
    textProfile: TextProfile,
    textResources: TextResources,
  ): Promise<string> {
    const filePath = textResources.nStringPathsByIndex.get(linkIndex);

    if (!filePath) {
      return "";
    }

    const fileValues = await this.#loadNStringFile(filePath, textProfile, textResources);
    return fileValues.get(key) ?? "";
  }

  #getDirectory(pathValue: string): DirectoryNode {
    const normalizedPath = normalizeArchivePath(pathValue);

    if (normalizedPath.length === 0) {
      return this.#root;
    }

    let current = this.#root;

    for (const segment of normalizedPath.split("/")) {
      const next = current.directories.get(segment);

      if (!next) {
        throw new Error(`Directory not found: ${pathValue}`);
      }

      current = next;
    }

    return current;
  }

  #getFile(pathValue: string): PvfFileRecord {
    const record = this.getFileRecord(pathValue);

    if (!record) {
      throw new Error(`File not found: ${pathValue}`);
    }

    return record;
  }

  #getSourceBytes(): Buffer {
    if (!this.#sourceBytes) {
      throw new Error("Archive bytes are not loaded.");
    }

    return this.#sourceBytes;
  }
}
