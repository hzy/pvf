import { open, type FileHandle } from "node:fs/promises";

import { parseEquDocument, type EquDocument } from "./equ.ts";

const PVF_PASSWORD = 0x81a79011;
const HEADER_TAIL_SIZE = 16;
const ROOT_PATH = "";

const filePathDecoder = /* @__PURE__ */ new TextDecoder("euc-kr");
const simplifiedTextDecoder = /* @__PURE__ */ new TextDecoder("gb18030");
const traditionalTextDecoder = /* @__PURE__ */ new TextDecoder("big5");

export type TextProfile = "simplified" | "traditional";

export const DEFAULT_TEXT_PROFILE: TextProfile = "simplified";

export interface PvfHeader {
  sizeGuid: number;
  guid: Buffer;
  fileVersion: number;
  dirTreeLength: number;
  dirTreeChecksum: number;
  numFilesInDirTree: number;
  headerSize: number;
}

export interface PvfFileRecord {
  fileNumber: number;
  filePath: string;
  displayPath: string;
  fileName: string;
  fileLength: number;
  fileCrc32: number;
  relativeOffset: number;
}

export interface DirectoryItem {
  kind: "directory" | "file";
  name: string;
  path: string;
}

interface DirectoryNode {
  name: string;
  path: string;
  directories: Map<string, DirectoryNode>;
  files: Map<string, PvfFileRecord>;
}

interface TextResources {
  stringTable: Map<number, string>;
  nStringMap: Map<string, string>;
}

function createDirectoryNode(name: string, path: string): DirectoryNode {
  return {
    name,
    path,
    directories: new Map(),
    files: new Map(),
  };
}

function normalizeArchivePath(input: string): string {
  return input
    .replaceAll("\\", "/")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function trimTrailingNulls(input: string): string {
  return input.replace(/\0+$/g, "");
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function rotateRight32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function readFloatString(value: number): string {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32LE(value, 0);
  return buffer.readFloatLE(0).toFixed(6);
}

function decodeFilePath(bytes: Buffer): string {
  return trimTrailingNulls(filePathDecoder.decode(bytes));
}

function getTextDecoder(textProfile: TextProfile) {
  return textProfile === "traditional"
    ? traditionalTextDecoder
    : simplifiedTextDecoder;
}

function decodeStringValue(bytes: Buffer, textProfile: TextProfile): string {
  return trimTrailingNulls(getTextDecoder(textProfile).decode(bytes));
}

function splitLines(input: string): string[] {
  return input.split(/\r?\n/);
}

function extractBetween(
  line: string,
  startToken: string,
  endToken: string,
): string {
  let startIndex = 0;

  if (startToken.length > 0) {
    startIndex = line.indexOf(startToken);

    if (startIndex === -1) {
      return "";
    }

    startIndex += startToken.length;
  }

  const sliced = line.slice(startIndex);

  if (endToken.length === 0) {
    return sliced;
  }

  const endIndex = sliced.indexOf(endToken);
  return endIndex === -1 ? "" : sliced.slice(0, endIndex);
}

function decryptBuffer(buffer: Buffer, length: number, crc32: number): void {
  if (length % 4 !== 0) {
    throw new Error(
      `Encrypted block length must be divisible by 4, received ${length}.`,
    );
  }

  for (let offset = 0; offset < length; offset += 4) {
    const encrypted = buffer.readUInt32LE(offset);
    const decrypted = rotateRight32(
      (encrypted ^ PVF_PASSWORD ^ crc32) >>> 0,
      6,
    );
    buffer.writeUInt32LE(decrypted, offset);
  }
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let total = 0;

  while (total < length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      length - total,
      position + total,
    );

    if (bytesRead === 0) {
      throw new Error(
        `Unexpected EOF while reading ${length} bytes at offset ${position}.`,
      );
    }

    total += bytesRead;
  }

  return buffer;
}

export class PvfArchive {
  readonly archiveId: string;
  readonly displayName: string;
  readonly filePath: string;

  #fileHandle: FileHandle | undefined;
  #header: PvfHeader | undefined;
  #root = createDirectoryNode(ROOT_PATH, ROOT_PATH);
  #entries = new Map<string, PvfFileRecord>();
  #textResourcesByProfile = new Map<TextProfile, TextResources>();
  #loaded = false;
  #loading: Promise<void> | undefined;

  constructor(archiveId: string, filePath: string) {
    this.archiveId = archiveId;
    this.displayName = archiveId.split("/").at(-1) ?? archiveId;
    this.filePath = filePath;
  }

  get isLoaded(): boolean {
    return this.#loaded;
  }

  get fileCount(): number {
    return this.#entries.size;
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
    if (this.#fileHandle) {
      await this.#fileHandle.close();
      this.#fileHandle = undefined;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  listDirectory(path = ROOT_PATH): DirectoryItem[] {
    const node = this.#getDirectory(path);
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

  async readRenderedFile(
    path: string,
    textProfile: TextProfile = DEFAULT_TEXT_PROFILE,
  ): Promise<string> {
    const record = this.#getFile(path);
    const fileBytes = await this.#readFileBytes(record);
    const textResources = await this.#getTextResources(textProfile);
    return this.#renderFile(fileBytes, textResources);
  }

  async readEquDocument(
    path: string,
    textProfile: TextProfile = DEFAULT_TEXT_PROFILE,
  ): Promise<EquDocument> {
    return parseEquDocument(await this.readRenderedFile(path, textProfile));
  }

  hasFile(path: string): boolean {
    return this.#entries.has(normalizeArchivePath(path));
  }

  async #load(): Promise<void> {
    this.#fileHandle = await open(this.filePath, "r");
    this.#header = await this.#readHeader();

    const headerTreeBytes = await readExactly(
      this.#fileHandle,
      this.#header.dirTreeLength,
      this.#header.headerSize,
    );
    decryptBuffer(
      headerTreeBytes,
      this.#header.dirTreeLength,
      this.#header.dirTreeChecksum,
    );

    this.#parseDirectoryTree(headerTreeBytes);
    this.#loaded = true;
  }

  async #readHeader(): Promise<PvfHeader> {
    if (!this.#fileHandle) {
      throw new Error("File handle is not open.");
    }

    const sizeGuidBuffer = await readExactly(this.#fileHandle, 4, 0);
    const sizeGuid = sizeGuidBuffer.readInt32LE(0);
    const headerSize = 4 + sizeGuid + HEADER_TAIL_SIZE;
    const headerBuffer = await readExactly(this.#fileHandle, headerSize, 0);
    const guidStart = 4;
    const metaStart = guidStart + sizeGuid;

    return {
      sizeGuid,
      guid: headerBuffer.subarray(guidStart, metaStart),
      fileVersion: headerBuffer.readInt32LE(metaStart),
      dirTreeLength: headerBuffer.readInt32LE(metaStart + 4),
      dirTreeChecksum: headerBuffer.readUInt32LE(metaStart + 8),
      numFilesInDirTree: headerBuffer.readInt32LE(metaStart + 12),
      headerSize,
    };
  }

  #parseDirectoryTree(treeBytes: Buffer): void {
    if (!this.#header) {
      throw new Error("Header is not loaded.");
    }

    let offset = 0;

    for (let index = 0; index < this.#header.numFilesInDirTree; index += 1) {
      const fileNumber = treeBytes.readUInt32LE(offset);
      const filePathLength = treeBytes.readInt32LE(offset + 4);
      const filePathBytes = treeBytes.subarray(
        offset + 8,
        offset + 8 + filePathLength,
      );
      const fileLength = treeBytes.readInt32LE(offset + 8 + filePathLength);
      const fileCrc32 = treeBytes.readUInt32LE(offset + 12 + filePathLength);
      const relativeOffset = treeBytes.readInt32LE(
        offset + 16 + filePathLength,
      );
      const displayPath = decodeFilePath(filePathBytes);
      const filePath = normalizeArchivePath(displayPath);
      const fileName = displayPath.split("/").at(-1) ?? displayPath;
      const record: PvfFileRecord = {
        fileNumber,
        filePath,
        displayPath,
        fileName,
        fileLength,
        fileCrc32,
        relativeOffset,
      };

      this.#entries.set(filePath, record);
      this.#insertFile(record);
      offset += filePathLength + 20;
    }
  }

  #insertFile(record: PvfFileRecord): void {
    const segments = record.displayPath
      .split("/")
      .filter((segment) => segment.length > 0);
    let current = this.#root;

    for (const segment of segments.slice(0, -1)) {
      const normalizedSegment = normalizeArchivePath(segment);
      let next = current.directories.get(normalizedSegment);

      if (!next) {
        const nextPath =
          current.path.length === 0 ? segment : `${current.path}/${segment}`;
        next = createDirectoryNode(segment, nextPath);
        current.directories.set(normalizedSegment, next);
      }

      current = next;
    }

    current.files.set(normalizeArchivePath(record.fileName), record);
  }

  async #getTextResources(textProfile: TextProfile): Promise<TextResources> {
    const existingResources = this.#textResourcesByProfile.get(textProfile);

    if (existingResources) {
      return existingResources;
    }

    const stringTable = await this.#loadStringTable(textProfile);
    const nStringMap = await this.#loadNStringMap(textProfile, stringTable);
    const loadedResources: TextResources = {
      stringTable,
      nStringMap,
    };

    this.#textResourcesByProfile.set(textProfile, loadedResources);
    return loadedResources;
  }

  async #loadStringTable(
    textProfile: TextProfile,
  ): Promise<Map<number, string>> {
    const stringTable = this.#entries.get("stringtable.bin");

    if (!stringTable) {
      throw new Error("PVF archive is missing stringtable.bin.");
    }

    const bytes = await this.#readFileBytes(stringTable);
    const count = bytes.readInt32LE(0);
    const resolvedStringTable = new Map<number, string>();

    for (let index = 0; index < count; index += 1) {
      const start = bytes.readInt32LE(index * 4 + 4);
      const end = bytes.readInt32LE(index * 4 + 8);
      const length = end - start;
      const valueBytes = bytes.subarray(start + 4, start + 4 + length);
      resolvedStringTable.set(
        index,
        decodeStringValue(valueBytes, textProfile),
      );
    }

    return resolvedStringTable;
  }

  async #loadNStringMap(
    textProfile: TextProfile,
    stringTable: Map<number, string>,
  ): Promise<Map<string, string>> {
    const nStringList = this.#entries.get("n_string.lst");

    if (!nStringList) {
      return new Map();
    }

    const bytes = await this.#readFileBytes(nStringList);

    if (bytes.length < 2 || bytes.readUInt16LE(0) !== 53424) {
      return new Map();
    }

    const referencedPaths = new Set<string>();
    const resolvedNStringMap = new Map<string, string>();

    for (let offset = 2; offset + 10 <= bytes.length; offset += 10) {
      const pathIndex = bytes.readInt32LE(offset + 6);
      const pathValue = stringTable.get(pathIndex);

      if (pathValue) {
        referencedPaths.add(normalizeArchivePath(pathValue));
      }
    }

    for (const referencedPath of referencedPaths) {
      const record = this.#entries.get(referencedPath);

      if (!record) {
        continue;
      }

      const fileBytes = await this.#readFileBytes(record);
      const content = decodeStringValue(fileBytes, textProfile);

      for (const line of splitLines(content)) {
        if (!line.includes(">")) {
          continue;
        }

        const key = extractBetween(line, "", ">");
        const value = extractBetween(line, ">", "");

        if (key.length > 0 && value.length > 0) {
          resolvedNStringMap.set(key, value);
        }
      }
    }

    return resolvedNStringMap;
  }

  async #readFileBytes(record: PvfFileRecord): Promise<Buffer> {
    if (!this.#fileHandle || !this.#header) {
      throw new Error("Archive is not ready.");
    }

    const computedLength = align4(record.fileLength);
    const fileOffset =
      this.#header.headerSize +
      this.#header.dirTreeLength +
      record.relativeOffset;
    const encrypted = await readExactly(
      this.#fileHandle,
      computedLength,
      fileOffset,
    );
    decryptBuffer(encrypted, computedLength, record.fileCrc32);
    return encrypted.subarray(0, record.fileLength);
  }

  #renderFile(bytes: Buffer, textResources: TextResources): string {
    const chunks: string[] = ["#PVF_File\r\n"];

    if (bytes.length >= 7) {
      for (let offset = 2; offset + 5 <= bytes.length; offset += 5) {
        const kind = bytes[offset] ?? -1;

        if (![2, 4, 5, 6, 7, 8, 10].includes(kind)) {
          continue;
        }

        const afterValue = bytes.readInt32LE(offset + 1);

        if (kind === 10) {
          const beforeValue = bytes.readInt32LE(offset - 4);
          chunks.push(
            `${this.#renderSpecial(kind, afterValue, beforeValue, textResources)}\r\n`,
          );
          continue;
        }

        if (kind === 7) {
          chunks.push(
            `\`${this.#renderSpecial(kind, afterValue, 0, textResources)}\`\r\n`,
          );
          continue;
        }

        if (kind === 2 || kind === 4) {
          chunks.push(
            `${this.#renderSpecial(kind, afterValue, 0, textResources)}\t`,
          );
          continue;
        }

        if (kind === 6 || kind === 8) {
          chunks.push(
            `{${kind}=\`${this.#renderSpecial(kind, afterValue, 0, textResources)}\`}\r\n`,
          );
          continue;
        }

        if (kind === 5) {
          chunks.push(
            `\r\n${this.#renderSpecial(kind, afterValue, 0, textResources)}\r\n`,
          );
        }
      }

      chunks.push("\r\n");
    }

    return chunks.join("");
  }

  #renderSpecial(
    kind: number,
    afterValue: number,
    beforeValue: number,
    textResources: TextResources,
  ): string {
    if (kind === 2) {
      return String(afterValue);
    }

    if (kind === 4) {
      return readFloatString(afterValue);
    }

    if (kind === 5 || kind === 6 || kind === 7 || kind === 8) {
      return textResources.stringTable.get(afterValue) ?? "";
    }

    if (kind === 10) {
      const value = textResources.stringTable.get(afterValue) ?? "";
      return `<${beforeValue}::${value}\`${textResources.nStringMap.get(value) ?? ""}\`>`;
    }

    return "";
  }

  #getDirectory(path: string): DirectoryNode {
    const normalizedPath = normalizeArchivePath(path);

    if (normalizedPath.length === 0) {
      return this.#root;
    }

    let current = this.#root;

    for (const segment of normalizedPath.split("/")) {
      const next = current.directories.get(segment);

      if (!next) {
        throw new Error(`Directory not found: ${path}`);
      }

      current = next;
    }

    return current;
  }

  #getFile(path: string): PvfFileRecord {
    const record = this.#entries.get(normalizeArchivePath(path));

    if (!record) {
      throw new Error(`File not found: ${path}`);
    }

    return record;
  }
}
