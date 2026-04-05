import { mkdir, open, readdir, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import iconv from "iconv-lite";

const PVF_PASSWORD = 0x81a79011;
const HEADER_TAIL_SIZE = 16;

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

export interface PvfEntry {
  fileNameHash: number;
  filePath: string;
  fileNameBytes: Buffer;
  fileLength: number;
  fileCrc32: number;
  relativeOffset: number;
  absoluteOffset: number;
  alignedLength: number;
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

interface PreparedEntry {
  fileNameHash: number;
  filePath: string;
  fileNameBytes: Buffer;
  fileLength: number;
  fileCrc32: number;
  alignedLength: number;
  source: "base" | "generated";
  sourceEntry?: PvfEntry;
  data?: Buffer;
}

interface CompiledScriptToken {
  kind: "continue" | "link" | "value";
  type?: number;
  data?: Buffer;
}

function getTextEncoding(textProfile: TextProfile): string {
  return textProfile === "traditional" ? "big5" : "gb18030";
}

function normalizeArchivePath(input: string): string {
  return input.replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
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

function encodeFilePath(filePath: string): Buffer {
  return iconv.encode(normalizeArchivePath(filePath), "cp949");
}

function encodeText(content: string, textProfile: TextProfile): Buffer {
  return iconv.encode(content, getTextEncoding(textProfile));
}

function decodeText(bytes: Buffer, textProfile: TextProfile): string {
  return iconv.decode(bytes, getTextEncoding(textProfile)).replace(/\0+$/gu, "");
}

function getFileNameHashCode(fileNameBytes: Uint8Array): number {
  let value = 0x1505;

  for (const byte of fileNameBytes) {
    value = (((0x21 * value) >>> 0) + byte) >>> 0;
  }

  return (value * 0x21) >>> 0;
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
      const num7 = (table[num4]! ^ num1) >>> 0;
      table[num5] = num7;
      const num8 = (num2 * 2) >>> 0;
      num5 += num8;
      num4 += num6;
    } while (num4 < 256);

    num2 = Math.floor(num2 / 2) >>> 0;
  }

  checksumTableCache = table;
  return table;
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

function decryptPvf(sourceBytes: Buffer, length: number, checksum: number): Buffer {
  const decrypted = Buffer.alloc(length);

  for (let index = 0; index < length; index += 4) {
    const value = sourceBytes.readUInt32LE(index);
    const next = rotateRight32((value ^ PVF_PASSWORD ^ checksum) >>> 0, 6);
    decrypted.writeUInt32LE(next, index);
  }

  return decrypted;
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

class SourcePvfArchive {
  readonly sourcePath: string;
  readonly fileHandle: FileHandle;
  readonly header: PvfHeader;
  readonly entries = new Map<string, PvfEntry>();
  readonly trailingOffset: number;

  private constructor(sourcePath: string, fileHandle: FileHandle, header: PvfHeader, entries: PvfEntry[]) {
    this.sourcePath = sourcePath;
    this.fileHandle = fileHandle;
    this.header = header;

    for (const entry of entries) {
      this.entries.set(entry.filePath, entry);
    }

    const lastEnd = entries.reduce(
      (current, entry) => Math.max(current, entry.absoluteOffset + entry.alignedLength),
      header.headerSize + header.dirTreeLength,
    );
    this.trailingOffset = lastEnd;
  }

  static async open(sourcePath: string): Promise<SourcePvfArchive> {
    const fileHandle = await open(sourcePath, "r");

    try {
      const sizeGuidBuffer = await readExactly(fileHandle, 4, 0);
      const sizeGuid = sizeGuidBuffer.readInt32LE(0);
      const headerSize = 4 + sizeGuid + HEADER_TAIL_SIZE;
      const headerBuffer = await readExactly(fileHandle, headerSize, 0);
      const metaStart = 4 + sizeGuid;
      const header: PvfHeader = {
        sizeGuid,
        guid: headerBuffer.subarray(4, metaStart),
        fileVersion: headerBuffer.readInt32LE(metaStart),
        dirTreeLength: headerBuffer.readInt32LE(metaStart + 4),
        dirTreeChecksum: headerBuffer.readUInt32LE(metaStart + 8),
        numFilesInDirTree: headerBuffer.readInt32LE(metaStart + 12),
        headerSize,
      };

      const fileTreeEncrypted = await readExactly(fileHandle, header.dirTreeLength, header.headerSize);
      const fileTree = decryptPvf(fileTreeEncrypted, header.dirTreeLength, header.dirTreeChecksum);
      const entries: PvfEntry[] = [];
      let offset = 0;

      for (let index = 0; index < header.numFilesInDirTree; index += 1) {
        const fileNameHash = fileTree.readUInt32LE(offset);
        const filePathLength = fileTree.readInt32LE(offset + 4);
        const fileNameBytes = fileTree.subarray(offset + 8, offset + 8 + filePathLength);
        const filePath = iconv.decode(fileNameBytes, "cp949").replace(/\0+$/gu, "").replaceAll("\\", "/").toLowerCase();
        const fileLength = fileTree.readInt32LE(offset + 8 + filePathLength);
        const fileCrc32 = fileTree.readUInt32LE(offset + 12 + filePathLength);
        const relativeOffset = fileTree.readInt32LE(offset + 16 + filePathLength);
        const alignedLength = align4(fileLength);

        entries.push({
          fileNameHash,
          filePath,
          fileNameBytes: Buffer.from(fileNameBytes),
          fileLength,
          fileCrc32,
          relativeOffset,
          absoluteOffset: header.headerSize + header.dirTreeLength + relativeOffset,
          alignedLength,
        });

        offset += filePathLength + 20;
      }

      return new SourcePvfArchive(sourcePath, fileHandle, header, entries);
    } catch (error) {
      await fileHandle.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.fileHandle.close();
  }

  getEntry(filePath: string): PvfEntry | undefined {
    return this.entries.get(normalizeArchivePath(filePath));
  }

  async readDecryptedFile(filePath: string): Promise<Buffer> {
    const entry = this.getEntry(filePath);

    if (!entry) {
      throw new Error(`Missing PVF entry: ${filePath}`);
    }

    const encrypted = await readExactly(this.fileHandle, entry.alignedLength, entry.absoluteOffset);
    return decryptPvf(encrypted, entry.alignedLength, entry.fileCrc32).subarray(0, entry.fileLength);
  }

  async copyEncryptedFile(target: FileHandle, entry: PvfEntry, position: number): Promise<number> {
    const encrypted = await readExactly(this.fileHandle, entry.alignedLength, entry.absoluteOffset);
    await target.write(encrypted, 0, encrypted.length, position);
    return encrypted.length;
  }

  async readTrailingBytes(): Promise<Buffer> {
    const sourceStat = await this.fileHandle.stat();

    if (sourceStat.size <= this.trailingOffset) {
      return Buffer.alloc(0);
    }

    return readExactly(this.fileHandle, Number(sourceStat.size - this.trailingOffset), this.trailingOffset);
  }
}

class MutableStringTable {
  readonly textProfile: TextProfile;
  #items: string[];
  #indexByValue: Map<string, number>;
  #updated = false;

  private constructor(textProfile: TextProfile, items: string[]) {
    this.textProfile = textProfile;
    this.#items = items;
    this.#indexByValue = new Map(items.map((item, index) => [item, index]));
  }

  static async fromArchive(archive: SourcePvfArchive, textProfile: TextProfile): Promise<MutableStringTable> {
    const bytes = await archive.readDecryptedFile("stringtable.bin");
    const count = bytes.readInt32LE(0);
    const items: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const start = bytes.readInt32LE(index * 4 + 4);
      const end = bytes.readInt32LE(index * 4 + 8);
      const valueBytes = bytes.subarray(start + 4, start + 4 + (end - start));
      items.push(decodeText(valueBytes, textProfile));
    }

    return new MutableStringTable(textProfile, items);
  }

  get updated(): boolean {
    return this.#updated;
  }

  getOrAdd(value: string): number {
    const existing = this.#indexByValue.get(value);

    if (existing !== undefined) {
      return existing;
    }

    const nextIndex = this.#items.length;
    this.#items.push(value);
    this.#indexByValue.set(value, nextIndex);
    this.#updated = true;
    return nextIndex;
  }

  toBuffer(): Buffer {
    const encodedItems = this.#items.map((item) => encodeText(item, this.textProfile));
    const offsetTableLength = 4 + this.#items.length * 4;
    let currentOffset = offsetTableLength;
    const output = Buffer.alloc(offsetTableLength + 4 + encodedItems.reduce((sum, item) => sum + item.length, 0));

    output.writeUInt32LE(this.#items.length, 0);

    for (let index = 0; index < encodedItems.length; index += 1) {
      output.writeUInt32LE(currentOffset, 4 + index * 4);
      currentOffset += encodedItems[index]!.length;
    }

    output.writeUInt32LE(currentOffset, 4 + encodedItems.length * 4);

    let writeOffset = offsetTableLength + 4;

    for (const bytes of encodedItems) {
      bytes.copy(output, writeOffset);
      writeOffset += bytes.length;
    }

    return output;
  }
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

function toPreparedBaseEntry(entry: PvfEntry): PreparedEntry {
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

function comparePreparedEntries(left: PreparedEntry, right: PreparedEntry): number {
  if (left.fileNameHash !== right.fileNameHash) {
    return left.fileNameHash - right.fileNameHash;
  }

  return left.filePath.localeCompare(right.filePath, "en");
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

  return overlay.content.trimStart().toLowerCase().startsWith("#pvf_file")
    ? "script"
    : "text";
}

async function materializeOverlayEntry(
  overlay: PvfOverlayFile,
  stringTable: MutableStringTable,
  textProfile: TextProfile,
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

    data = compilePvfScriptText(overlay.content, stringTable);
  } else {
    throw new Error(`Unsupported overlay mode for ${overlay.path}.`);
  }

  return createPreparedEntry(overlay.path, data);
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
  const source = await SourcePvfArchive.open(sourcePath);

  try {
    const stringTable = await MutableStringTable.fromArchive(source, textProfile);
    const finalEntries = new Map<string, PreparedEntry>();

    for (const entry of source.entries.values()) {
      finalEntries.set(entry.filePath, toPreparedBaseEntry(entry));
    }

    const addedPaths: string[] = [];
    const updatedPaths: string[] = [];
    const deletedPaths: string[] = [];

    for (const overlay of options.overlays) {
      const normalizedPath = normalizeArchivePath(overlay.path);

      if (normalizedPath === "stringtable.bin") {
        throw new Error("Overlays may not replace stringtable.bin directly; it is managed by the writer.");
      }

      if (overlay.delete) {
        if (finalEntries.delete(normalizedPath)) {
          deletedPaths.push(normalizedPath);
        }

        continue;
      }

      const prepared = await materializeOverlayEntry(overlay, stringTable, textProfile);

      if (finalEntries.has(normalizedPath)) {
        updatedPaths.push(normalizedPath);
      } else {
        addedPaths.push(normalizedPath);
      }

      finalEntries.set(normalizedPath, prepared);
    }

    if (deletedPaths.includes("stringtable.bin")) {
      throw new Error("stringtable.bin cannot be deleted.");
    }

    if (stringTable.updated || !finalEntries.has("stringtable.bin")) {
      finalEntries.set("stringtable.bin", createPreparedEntry("stringtable.bin", stringTable.toBuffer()));

      if (!updatedPaths.includes("stringtable.bin") && !addedPaths.includes("stringtable.bin")) {
        updatedPaths.push("stringtable.bin");
      }
    }

    const sortedEntries = Array.from(finalEntries.values()).sort(comparePreparedEntries);
    const fileTree = buildFileTree(sortedEntries);
    const fileTreeChecksum = createBuffKey(fileTree, fileTree.length, sortedEntries.length);
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
      headerPrefix.writeInt32LE(sortedEntries.length, metaStart + 12);
      await output.write(headerPrefix, 0, headerPrefix.length, position);
      position += headerPrefix.length;
      await output.write(encryptedFileTree, 0, encryptedFileTree.length, position);
      position += encryptedFileTree.length;

      for (const entry of sortedEntries) {
        if (entry.source === "base" && entry.sourceEntry) {
          position += await source.copyEncryptedFile(output, entry.sourceEntry, position);
          continue;
        }

        const encrypted = encryptPvf(entry.data ?? Buffer.alloc(0), entry.fileCrc32);
        await output.write(encrypted, 0, encrypted.length, position);
        position += encrypted.length;
      }

      if (trailingBytes.length > 0) {
        await output.write(trailingBytes, 0, trailingBytes.length, position);
      }
    } finally {
      await output.close();
    }

    return {
      outputPath,
      fileCount: sortedEntries.length,
      updatedPaths: updatedPaths.sort((left, right) => left.localeCompare(right, "en")),
      addedPaths: addedPaths.sort((left, right) => left.localeCompare(right, "en")),
      deletedPaths: deletedPaths.sort((left, right) => left.localeCompare(right, "en")),
    };
  } finally {
    await source.close();
  }
}
