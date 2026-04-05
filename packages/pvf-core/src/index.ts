import { mkdir, open, readdir, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import iconv from "iconv-lite";

const PVF_PASSWORD = 0x81a79011;
const HEADER_TAIL_SIZE = 16;
const COPY_CHUNK_SIZE = 8 * 1024 * 1024;
const ROOT_PATH = "";

export type TextProfile = "simplified" | "traditional";
export type OverlayMode = "auto" | "script" | "text" | "binary";

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
  treeIndex: number;
  fileNameHash: number;
  filePath: string;
  displayPath: string;
  fileName: string;
  fileNameBytes: Buffer;
  fileLength: number;
  fileCrc32: number;
  relativeOffset: number;
  absoluteOffset: number;
  alignedLength: number;
}

export interface DirectoryItem {
  kind: "directory" | "file";
  name: string;
  path: string;
}

export interface PvfOverlayFile {
  path: string;
  content?: string | Uint8Array;
  mode?: OverlayMode;
  delete?: boolean;
}

export interface LoadTextOverlayDirectoryOptions {
  rootDir: string;
  ignore?: (relativePath: string) => boolean;
}

export interface RepackPvfOptions {
  sourcePath: string;
  outputPath: string;
  overlays: Iterable<PvfOverlayFile>;
  textProfile?: TextProfile;
}

export interface RepackPvfResult {
  outputPath: string;
  fileCount: number;
  updatedPaths: string[];
  addedPaths: string[];
  deletedPaths: string[];
}

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

interface CompiledScriptToken {
  kind: "continue" | "link" | "value";
  type?: number;
  data?: Buffer;
}

interface NormalizedOverlay extends PvfOverlayFile {
  path: string;
}

function createDirectoryNode(name: string, pathValue: string): DirectoryNode {
  return {
    name,
    path: pathValue,
    directories: new Map(),
    files: new Map(),
  };
}

function getTextEncoding(textProfile: TextProfile): string {
  return textProfile === "traditional" ? "big5" : "gb18030";
}

function normalizeArchivePath(input: string): string {
  return input.replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

function trimTrailingNulls(input: string): string {
  return input.replace(/\0+$/gu, "");
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function rotateRight32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function encodeFilePath(filePath: string): Buffer {
  return iconv.encode(normalizeArchivePath(filePath), "cp949");
}

function decodeFilePath(bytes: Buffer): string {
  return trimTrailingNulls(iconv.decode(bytes, "cp949"));
}

function encodeText(content: string, textProfile: TextProfile): Buffer {
  return iconv.encode(content, getTextEncoding(textProfile));
}

function decodeText(bytes: Buffer, textProfile: TextProfile): string {
  return trimTrailingNulls(iconv.decode(bytes, getTextEncoding(textProfile)));
}

function splitLines(input: string): string[] {
  return input.split(/\r?\n/u);
}

function readFloatString(value: number): string {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32LE(value, 0);
  return buffer.readFloatLE(0).toFixed(6);
}

function getDataFromFormat(source: string, header: string, ending: string): string {
  let start = header.length > 0 ? source.indexOf(header) : 0;

  if (start === -1) {
    return "";
  }

  start += header.length;
  const sliced = source.slice(start);

  if (ending.length === 0) {
    return sliced;
  }

  const end = sliced.indexOf(ending);
  return end === -1 ? "" : sliced.slice(0, end);
}

function int32Buffer(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

function float32Buffer(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
}

function decryptBuffer(buffer: Buffer, length: number, checksum: number): void {
  if (length % 4 !== 0) {
    throw new Error(`Encrypted block length must be divisible by 4, received ${length}.`);
  }

  for (let offset = 0; offset < length; offset += 4) {
    const encrypted = buffer.readUInt32LE(offset);
    const decrypted = rotateRight32((encrypted ^ PVF_PASSWORD ^ checksum) >>> 0, 6);
    buffer.writeUInt32LE(decrypted, offset);
  }
}

function decryptPvf(sourceBytes: Buffer, length: number, checksum: number): Buffer {
  const output = Buffer.from(sourceBytes);
  decryptBuffer(output, length, checksum);
  return output;
}

function encryptPvf(sourceBytes: Buffer, checksum: number): Buffer {
  const alignedLength = align4(sourceBytes.length);
  const padded = Buffer.alloc(alignedLength);
  sourceBytes.copy(padded);
  const encrypted = Buffer.alloc(alignedLength);

  for (let index = 0; index < alignedLength; index += 4) {
    const value = padded.readUInt32LE(index);
    const next = (rotateLeft32(value, 6) ^ checksum ^ PVF_PASSWORD) >>> 0;
    encrypted.writeUInt32LE(next, index);
  }

  return encrypted;
}

async function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let total = 0;

  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total);

    if (bytesRead === 0) {
      throw new Error(`Unexpected EOF while reading ${length} bytes at offset ${position}.`);
    }

    total += bytesRead;
  }

  return buffer;
}

async function copyExactly(
  source: FileHandle,
  target: FileHandle,
  sourceOffset: number,
  length: number,
  targetOffset: number,
): Promise<number> {
  const chunkSize = Math.max(1, Math.min(COPY_CHUNK_SIZE, length));
  const buffer = Buffer.allocUnsafe(chunkSize);
  let copied = 0;

  while (copied < length) {
    const remaining = length - copied;
    const chunkLength = Math.min(buffer.length, remaining);
    let read = 0;

    while (read < chunkLength) {
      const { bytesRead } = await source.read(
        buffer,
        read,
        chunkLength - read,
        sourceOffset + copied + read,
      );

      if (bytesRead === 0) {
        throw new Error(`Unexpected EOF while copying ${length} bytes at offset ${sourceOffset}.`);
      }

      read += bytesRead;
    }

    await target.write(buffer, 0, chunkLength, targetOffset + copied);
    copied += chunkLength;
  }

  return copied;
}

function getFileNameHashCode(fileNameBytes: Uint8Array): number {
  let value = 0x1505;

  for (const byte of fileNameBytes) {
    value = (((0x21 * value) >>> 0) + byte) >>> 0;
  }

  return (value * 0x21) >>> 0;
}

let checksumTableCache: Uint32Array | undefined;

function getChecksumTable(): Uint32Array {
  if (checksumTableCache) {
    return checksumTableCache;
  }

  const table = new Uint32Array(256);
  let num1 = 1 >>> 0;
  let num2 = 128 >>> 0;

  while (num2 > 0) {
    const num3 = (num1 & 1) === 0 ? 0 : 3988292384;
    num1 = ((num1 >>> 1) ^ num3) >>> 0;
    let num4 = 0 >>> 0;
    let num5 = num2;
    const num6 = (num2 * 2) >>> 0;

    do {
      table[num5] = (table[num4]! ^ num1) >>> 0;
      num5 += num2 * 2;
      num4 += num6;
    } while (num4 < 256);

    num2 = Math.floor(num2 / 2) >>> 0;
  }

  checksumTableCache = table;
  return table;
}

function createBuffKey(sourceBytes: Buffer, trueLen: number, seed: number): number {
  const table = getChecksumTable();
  let value = (~seed) >>> 0;

  for (let index = 0; index < trueLen; index += 4) {
    const byte0 = (sourceBytes[index] ?? 0) & 0xff;
    const byte1 = (sourceBytes[index + 1] ?? 0) & 0xff;
    const byte2 = (sourceBytes[index + 2] ?? 0) & 0xff;
    const byte3 = (sourceBytes[index + 3] ?? 0) & 0xff;
    const num2 = ((byte0 ^ value) & 0xff) >>> 0;
    const num3 = ((value >>> 8) ^ table[num2]!) >>> 0;
    const num4 = ((num3 ^ byte1) & 0xff) >>> 0;
    const num5 = ((num3 >>> 8) ^ table[num4]!) >>> 0;
    const num6 = ((num5 ^ byte2) & 0xff) >>> 0;
    const num7 = ((num5 >>> 8) ^ table[num6]!) >>> 0;
    const num8 = ((num7 ^ byte3) & 0xff) >>> 0;
    value = ((num7 >>> 8) ^ table[num8]!) >>> 0;
  }

  return (~value) >>> 0;
}

function comparePreparedEntries(left: PreparedEntry, right: PreparedEntry): number {
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

class LazyStringTable {
  readonly textProfile: TextProfile;

  #bytes: Buffer;
  #count: number;
  #values = new Map<number, string>();

  constructor(bytes: Buffer, textProfile: TextProfile) {
    this.#bytes = bytes;
    this.#count = bytes.readInt32LE(0);
    this.textProfile = textProfile;
  }

  get(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.#count) {
      return "";
    }

    const cached = this.#values.get(index);

    if (cached !== undefined) {
      return cached;
    }

    const start = this.#bytes.readInt32LE(index * 4 + 4);
    const end = this.#bytes.readInt32LE(index * 4 + 8);
    const value = decodeText(this.#bytes.subarray(start + 4, end + 4), this.textProfile);
    this.#values.set(index, value);
    return value;
  }
}

class MutableStringTable {
  readonly textProfile: TextProfile;

  #baseBytes: Buffer;
  #baseCount: number;
  #appended = new Map<string, number>();
  #appendedBytes: Buffer[] = [];

  private constructor(baseBytes: Buffer, textProfile: TextProfile) {
    this.#baseBytes = baseBytes;
    this.#baseCount = baseBytes.readInt32LE(0);
    this.textProfile = textProfile;
  }

  static async fromArchive(archive: PvfArchive, textProfile: TextProfile): Promise<MutableStringTable> {
    return new MutableStringTable(await archive.readDecryptedFile("stringtable.bin"), textProfile);
  }

  get updated(): boolean {
    return this.#appendedBytes.length > 0;
  }

  getOrAdd(value: string): number {
    const cached = this.#appended.get(value);

    if (cached !== undefined) {
      return cached;
    }

    const nextIndex = this.#baseCount + this.#appendedBytes.length;
    this.#appended.set(value, nextIndex);
    this.#appendedBytes.push(encodeText(value, this.textProfile));
    return nextIndex;
  }

  toBuffer(): Buffer {
    if (this.#appendedBytes.length === 0) {
      return Buffer.from(this.#baseBytes);
    }

    const totalCount = this.#baseCount + this.#appendedBytes.length;
    const offsetTableLength = 4 + totalCount * 4;
    const originalDataLength = this.#getOriginalDataLength();
    const appendedLength = this.#appendedBytes.reduce((sum, bytes) => sum + bytes.length, 0);
    const output = Buffer.alloc(offsetTableLength + 4 + originalDataLength + appendedLength);
    let currentOffset = offsetTableLength;
    let writeOffset = offsetTableLength + 4;

    output.writeUInt32LE(totalCount, 0);

    for (let index = 0; index < this.#baseCount; index += 1) {
      output.writeUInt32LE(currentOffset, 4 + index * 4);
      const start = this.#baseBytes.readInt32LE(index * 4 + 4);
      const end = this.#baseBytes.readInt32LE(index * 4 + 8);
      const rawBytes = this.#baseBytes.subarray(start + 4, end + 4);
      rawBytes.copy(output, writeOffset);
      writeOffset += rawBytes.length;
      currentOffset += rawBytes.length;
    }

    for (let index = 0; index < this.#appendedBytes.length; index += 1) {
      const outputIndex = this.#baseCount + index;
      const bytes = this.#appendedBytes[index]!;
      output.writeUInt32LE(currentOffset, 4 + outputIndex * 4);
      bytes.copy(output, writeOffset);
      writeOffset += bytes.length;
      currentOffset += bytes.length;
    }

    output.writeUInt32LE(currentOffset, 4 + totalCount * 4);
    return output;
  }

  #getOriginalDataLength(): number {
    if (this.#baseCount === 0) {
      return 0;
    }

    const firstDataOffset = this.#baseBytes.readInt32LE(4);
    const lastDataOffset = this.#baseBytes.readInt32LE(4 + this.#baseCount * 4);
    return lastDataOffset - firstDataOffset;
  }
}

export class PvfArchive {
  readonly archiveId: string;
  readonly displayName: string;
  readonly filePath: string;

  #fileHandle: FileHandle | undefined;
  #header: PvfHeader | undefined;
  #root = createDirectoryNode(ROOT_PATH, ROOT_PATH);
  #entriesByPath = new Map<string, PvfFileRecord>();
  #entriesInOrder: PvfFileRecord[] = [];
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
    if (this.#fileHandle) {
      await this.#fileHandle.close();
      this.#fileHandle = undefined;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
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

    if (!this.#fileHandle) {
      throw new Error("Archive is not ready.");
    }

    const encrypted = await readExactly(this.#fileHandle, record.alignedLength, record.absoluteOffset);
    return decryptPvf(encrypted, record.alignedLength, record.fileCrc32).subarray(0, record.fileLength);
  }

  async copyEncryptedRange(
    target: FileHandle,
    sourceOffset: number,
    length: number,
    targetOffset: number,
  ): Promise<number> {
    await this.ensureLoaded();

    if (!this.#fileHandle) {
      throw new Error("Archive is not ready.");
    }

    return copyExactly(this.#fileHandle, target, sourceOffset, length, targetOffset);
  }

  async readTrailingBytes(): Promise<Buffer> {
    await this.ensureLoaded();

    if (!this.#fileHandle) {
      throw new Error("Archive is not ready.");
    }

    const trailingOffset = this.#entriesInOrder.reduce(
      (current, entry) => Math.max(current, entry.absoluteOffset + entry.alignedLength),
      this.header.headerSize + this.header.dirTreeLength,
    );
    const sourceStat = await this.#fileHandle.stat();

    if (sourceStat.size <= trailingOffset) {
      return Buffer.alloc(0);
    }

    return readExactly(this.#fileHandle, Number(sourceStat.size - trailingOffset), trailingOffset);
  }

  async readRenderedFile(
    pathValue: string,
    textProfile: TextProfile = DEFAULT_TEXT_PROFILE,
  ): Promise<string> {
    const record = this.#getFile(pathValue);
    const bytes = await this.readDecryptedFile(record);

    if (!this.#isStructuredScriptChunk(bytes)) {
      return this.#renderPlainTextFile(record, bytes, textProfile);
    }

    const textResources = await this.#getTextResources(textProfile);
    return this.#renderStructuredFile(bytes, textResources);
  }

  async #load(): Promise<void> {
    this.#fileHandle = await open(this.filePath, "r");
    this.#header = await this.#readHeader();

    const fileTreeEncrypted = await readExactly(
      this.#fileHandle,
      this.#header.dirTreeLength,
      this.#header.headerSize,
    );
    const fileTree = decryptPvf(fileTreeEncrypted, this.#header.dirTreeLength, this.#header.dirTreeChecksum);
    this.#parseDirectoryTree(fileTree);
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
    const metaStart = 4 + sizeGuid;

    return {
      sizeGuid,
      guid: headerBuffer.subarray(4, metaStart),
      fileVersion: headerBuffer.readInt32LE(metaStart),
      dirTreeLength: headerBuffer.readInt32LE(metaStart + 4),
      dirTreeChecksum: headerBuffer.readUInt32LE(metaStart + 8),
      numFilesInDirTree: headerBuffer.readInt32LE(metaStart + 12),
      headerSize,
    };
  }

  #parseDirectoryTree(treeBytes: Buffer): void {
    let offset = 0;

    for (let treeIndex = 0; treeIndex < this.header.numFilesInDirTree; treeIndex += 1) {
      const fileNameHash = treeBytes.readUInt32LE(offset);
      const filePathLength = treeBytes.readInt32LE(offset + 4);
      const fileNameBytes = Buffer.from(treeBytes.subarray(offset + 8, offset + 8 + filePathLength));
      const fileLength = treeBytes.readInt32LE(offset + 8 + filePathLength);
      const fileCrc32 = treeBytes.readUInt32LE(offset + 12 + filePathLength);
      const relativeOffset = treeBytes.readInt32LE(offset + 16 + filePathLength);
      const displayPath = decodeFilePath(fileNameBytes);
      const filePath = normalizeArchivePath(displayPath);
      const fileName = displayPath.split("/").at(-1) ?? displayPath;
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
        alignedLength: align4(fileLength),
      };

      this.#entriesByPath.set(filePath, record);
      this.#entriesInOrder.push(record);
      this.#insertFile(record);
      offset += filePathLength + 20;
    }
  }

  #insertFile(record: PvfFileRecord): void {
    const segments = record.displayPath.split("/").filter((segment) => segment.length > 0);
    let current = this.#root;

    for (const segment of segments.slice(0, -1)) {
      const normalizedSegment = normalizeArchivePath(segment);
      let next = current.directories.get(normalizedSegment);

      if (!next) {
        const nextPath = current.path.length === 0 ? segment : `${current.path}/${segment}`;
        next = createDirectoryNode(segment, nextPath);
        current.directories.set(normalizedSegment, next);
      }

      current = next;
    }

    current.files.set(normalizeArchivePath(record.fileName), record);
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

    if (bytes.length < 2 || bytes.readUInt16LE(0) !== 53424) {
      return new Map();
    }

    const pathsByIndex = new Map<number, string>();

    for (let offset = 2; offset + 10 <= bytes.length; offset += 10) {
      const indexKind = bytes[offset] ?? -1;
      const pathKind = bytes[offset + 5] ?? -1;

      if (indexKind !== 2 || pathKind !== 7) {
        continue;
      }

      const linkIndex = bytes.readInt32LE(offset + 1);
      const pathIndex = bytes.readInt32LE(offset + 6);
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
    const chunks: string[] = ["#PVF_File\r\n"];
    let pendingLinkIndex: number | null = null;

    for (let offset = 2; offset + 5 <= bytes.length; offset += 5) {
      const kind = bytes[offset] ?? -1;
      const value = bytes.readInt32LE(offset + 1);

      if (kind === 9) {
        pendingLinkIndex = value;
        continue;
      }

      if (kind === 10) {
        const key = textResources.stringTable.get(value);
        const resolved =
          pendingLinkIndex === null
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

  #isStructuredScriptChunk(bytes: Buffer): boolean {
    return bytes.length >= 2 && bytes[0] === 0xb0 && bytes[1] === 0xd0;
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
}

function compileScriptItem(itemData: string, stringTable: MutableStringTable): CompiledScriptToken {
  if (itemData.length === 0) {
    throw new Error("Cannot compile an empty script token.");
  }

  if (itemData.startsWith("[") && itemData.endsWith("]")) {
    return {
      kind: "value",
      type: 5,
      data: int32Buffer(stringTable.getOrAdd(itemData)),
    };
  }

  if (itemData.startsWith("<") && itemData.endsWith(">")) {
    return {
      kind: "link",
    };
  }

  if (itemData.startsWith("`") && itemData.endsWith("`")) {
    return {
      kind: "value",
      type: 7,
      data: int32Buffer(stringTable.getOrAdd(getDataFromFormat(itemData, "`", "`"))),
    };
  }

  if (itemData.startsWith("{") && itemData.endsWith("}")) {
    const opcodeText = getDataFromFormat(itemData, "{", "=");
    const rawValue = getDataFromFormat(itemData, "=", "}");
    const opcode = Number.parseInt(opcodeText, 10);

    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 255) {
      throw new Error(`Unsupported script opcode: ${itemData}`);
    }

    if (rawValue.startsWith("`") && rawValue.endsWith("`")) {
      return {
        kind: "value",
        type: opcode,
        data: int32Buffer(stringTable.getOrAdd(getDataFromFormat(rawValue, "`", "`"))),
      };
    }

    const numericValue = Number.parseInt(rawValue, 10);

    if (!Number.isInteger(numericValue)) {
      throw new Error(`Unsupported command payload: ${itemData}`);
    }

    return {
      kind: "value",
      type: opcode,
      data: int32Buffer(numericValue),
    };
  }

  if (itemData.startsWith("`")) {
    return {
      kind: "continue",
    };
  }

  if (!itemData.includes(".")) {
    const value = Number.parseInt(itemData, 10);

    if (!Number.isInteger(value)) {
      throw new Error(`Invalid integer token: ${itemData}`);
    }

    return {
      kind: "value",
      type: 2,
      data: int32Buffer(value),
    };
  }

  const floatValue = Number.parseFloat(itemData);

  if (Number.isNaN(floatValue)) {
    throw new Error(`Invalid float token: ${itemData}`);
  }

  return {
    kind: "value",
    type: 4,
    data: float32Buffer(floatValue),
  };
}

function writeCompiledToken(output: Buffer[], token: CompiledScriptToken): void {
  if (token.kind !== "value" || token.type === undefined || !token.data) {
    throw new Error("Only value tokens can be written directly.");
  }

  output.push(Buffer.from([token.type]), token.data);
}

function compileType10Token(itemData: string, stringTable: MutableStringTable): Buffer {
  const indexText = getDataFromFormat(itemData, "<", "::");
  const linkIndex = Number.parseInt(indexText, 10);
  const key = getDataFromFormat(itemData, "::", "`");

  if (!Number.isInteger(linkIndex) || key.length === 0) {
    throw new Error(`Invalid link token: ${itemData}`);
  }

  return Buffer.concat([
    Buffer.from([9]),
    int32Buffer(linkIndex),
    Buffer.from([10]),
    int32Buffer(stringTable.getOrAdd(key)),
  ]);
}

export function compilePvfScriptText(scriptText: string, stringTable: MutableStringTable): Buffer {
  const lines = scriptText.replace(/\r\n/gu, "\n").split("\n");
  const output: Buffer[] = [Buffer.from([0xb0, 0xd0])];
  let pending = "";

  for (const line of lines) {
    const lowerLine = line.toLowerCase();

    if (lowerLine === "#pvf_file" || lowerLine === "#pvf_file_add" || line.length === 0) {
      continue;
    }

    const items = line.split("\t").filter((item) => item.length > 0);

    for (const item of items) {
      pending += item;
      const compiled = compileScriptItem(pending, stringTable);

      if (compiled.kind === "continue") {
        pending += "\r\n";
        continue;
      }

      if (compiled.kind === "link") {
        output.push(compileType10Token(pending, stringTable));
        pending = "";
        continue;
      }

      writeCompiledToken(output, compiled);
      pending = "";
    }
  }

  if (pending.length > 0) {
    throw new Error(`Unterminated script token: ${pending}`);
  }

  return Buffer.concat(output);
}

function createPreparedEntry(filePath: string, data: Buffer): PreparedEntry {
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
  const totalLength = align4(entries.reduce((sum, entry) => sum + entry.fileNameBytes.length + 20, 0));
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

  return createPreparedEntry(overlay.path, data);
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

export async function repackPvf(options: RepackPvfOptions): Promise<RepackPvfResult> {
  const sourcePath = path.resolve(options.sourcePath);
  const outputPath = path.resolve(options.outputPath);
  const textProfile = options.textProfile ?? DEFAULT_TEXT_PROFILE;
  const source = new PvfArchive(path.basename(sourcePath), sourcePath);
  const normalizedOverlays = normalizeOverlays(options.overlays);
  const finalEntries: PreparedEntry[] = [];
  const addedPaths = new Set<string>();
  const updatedPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  let stringTable: MutableStringTable | undefined;

  await source.ensureLoaded();

  try {
    const getStringTable = async (): Promise<MutableStringTable> => {
      if (!stringTable) {
        stringTable = await MutableStringTable.fromArchive(source, textProfile);
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
        throw new Error("Overlays may not replace stringtable.bin directly; it is managed by the writer.");
      }

      if (overlay.delete) {
        deletedPaths.add(entry.filePath);
        continue;
      }

      finalEntries.push(await materializeOverlayEntry(overlay, textProfile, getStringTable));
      updatedPaths.add(entry.filePath);
    }

    for (const overlay of normalizedOverlays.values()) {
      if (overlay.path === "stringtable.bin") {
        throw new Error("Overlays may not replace stringtable.bin directly; it is managed by the writer.");
      }

      if (overlay.delete) {
        continue;
      }

      finalEntries.push(await materializeOverlayEntry(overlay, textProfile, getStringTable));
      addedPaths.add(overlay.path);
    }

    if (stringTable?.updated || !source.hasFile("stringtable.bin")) {
      const stringTableEntry = createPreparedEntry(
        "stringtable.bin",
        (stringTable ?? (await getStringTable())).toBuffer(),
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

    await mkdir(path.dirname(outputPath), { recursive: true });
    const output = await open(outputPath, "w");

    try {
      let position = 0;
      const headerPrefix = Buffer.alloc(source.header.headerSize);
      headerPrefix.writeInt32LE(source.header.sizeGuid, 0);
      source.header.guid.copy(headerPrefix, 4);
      const metaStart = 4 + source.header.sizeGuid;
      headerPrefix.writeInt32LE(source.header.fileVersion, metaStart);
      headerPrefix.writeInt32LE(fileTree.length, metaStart + 4);
      headerPrefix.writeUInt32LE(fileTreeChecksum, metaStart + 8);
      headerPrefix.writeInt32LE(finalEntries.length, metaStart + 12);
      await output.write(headerPrefix, 0, headerPrefix.length, position);
      position += headerPrefix.length;
      await output.write(encryptedFileTree, 0, encryptedFileTree.length, position);
      position += encryptedFileTree.length;

      let runStart: PvfFileRecord | undefined;
      let runEnd: PvfFileRecord | undefined;

      const flushRun = async (): Promise<void> => {
        if (!runStart || !runEnd) {
          return;
        }

        const sourceOffset = runStart.absoluteOffset;
        const length = runEnd.absoluteOffset + runEnd.alignedLength - runStart.absoluteOffset;
        position += await source.copyEncryptedRange(output, sourceOffset, length, position);
        runStart = undefined;
        runEnd = undefined;
      };

      for (const entry of finalEntries) {
        if (entry.source === "base" && entry.sourceEntry) {
          if (
            runEnd
            && entry.sourceEntry.treeIndex === runEnd.treeIndex + 1
            && entry.sourceEntry.absoluteOffset === runEnd.absoluteOffset + runEnd.alignedLength
          ) {
            runEnd = entry.sourceEntry;
            continue;
          }

          await flushRun();
          runStart = entry.sourceEntry;
          runEnd = entry.sourceEntry;
          continue;
        }

        await flushRun();
        const encrypted = encryptPvf(entry.data ?? Buffer.alloc(0), entry.fileCrc32);
        await output.write(encrypted, 0, encrypted.length, position);
        position += encrypted.length;
      }

      await flushRun();

      if (trailingBytes.length > 0) {
        await output.write(trailingBytes, 0, trailingBytes.length, position);
      }
    } finally {
      await output.close();
    }

    return {
      outputPath,
      fileCount: finalEntries.length,
      updatedPaths: Array.from(updatedPaths).sort((left, right) => left.localeCompare(right, "en")),
      addedPaths: Array.from(addedPaths).sort((left, right) => left.localeCompare(right, "en")),
      deletedPaths: Array.from(deletedPaths).sort((left, right) => left.localeCompare(right, "en")),
    };
  } finally {
    await source.close();
  }
}
