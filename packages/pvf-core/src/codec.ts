import iconv from "iconv-lite";

import type { TextProfile } from "./types.ts";

const PVF_PASSWORD = 0x81a79011;
const LITTLE_ENDIAN_CHECK = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function toBufferView(input: Uint8Array): Buffer {
  return Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export function toDataView(input: Uint8Array): DataView {
  return new DataView(input.buffer, input.byteOffset, input.byteLength);
}

export function getTextEncoding(textProfile: TextProfile): string {
  return textProfile === "traditional" ? "big5" : "gb18030";
}

export function normalizeArchivePath(input: string): string {
  if (input.length === 0) {
    return input;
  }

  const firstCode = input.charCodeAt(0);
  const lastCode = input.charCodeAt(input.length - 1);
  let needsSlowPath = firstCode === 47 || lastCode === 47 || firstCode <= 0x20 || lastCode <= 0x20;

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);

    if (code === 92 || (code >= 65 && code <= 90)) {
      needsSlowPath = true;
      break;
    }
  }

  if (!needsSlowPath) {
    return input;
  }

  return input.replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

export function align4(value: number): number {
  return (value + 3) & ~3;
}

export function trimTrailingNulls(input: string): string {
  return input.replace(/\0+$/gu, "");
}

export function encodeFilePath(filePath: string): Buffer {
  return iconv.encode(normalizeArchivePath(filePath), "cp949");
}

export function decodeFilePath(bytes: Uint8Array): string {
  return trimTrailingNulls(iconv.decode(toBufferView(bytes), "cp949"));
}

export function encodeText(content: string, textProfile: TextProfile): Buffer {
  return iconv.encode(content, getTextEncoding(textProfile));
}

export function decodeText(bytes: Uint8Array, textProfile: TextProfile): string {
  return trimTrailingNulls(iconv.decode(toBufferView(bytes), getTextEncoding(textProfile)));
}

export function splitLines(input: string): string[] {
  return input.split(/\r?\n/u);
}

export function readFloatString(value: number): string {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32LE(value, 0);
  return buffer.readFloatLE(0).toFixed(6);
}

export function int32Buffer(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

export function float32Buffer(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function rotateRight32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function decryptBuffer(buffer: Buffer, length: number, checksum: number): void {
  if (length % 4 !== 0) {
    throw new Error(`Encrypted block length must be divisible by 4, received ${length}.`);
  }

  if (LITTLE_ENDIAN_CHECK && (buffer.byteOffset & 3) === 0) {
    const words = new Uint32Array(buffer.buffer, buffer.byteOffset, length >>> 2);
    const xorMask = (PVF_PASSWORD ^ checksum) >>> 0;

    for (let index = 0; index < words.length; index += 1) {
      words[index] = rotateRight32((words[index]! ^ xorMask) >>> 0, 6);
    }

    return;
  }

  for (let offset = 0; offset < length; offset += 4) {
    const encrypted = buffer.readUInt32LE(offset);
    const decrypted = rotateRight32((encrypted ^ PVF_PASSWORD ^ checksum) >>> 0, 6);
    buffer.writeUInt32LE(decrypted, offset);
  }
}

export function decryptPvf(sourceBytes: Uint8Array, length: number, checksum: number): Buffer {
  const output = Buffer.from(sourceBytes.subarray(0, length));
  decryptBuffer(output, length, checksum);
  return output;
}

export function encryptPvf(sourceBytes: Uint8Array, checksum: number): Buffer {
  const source = toBufferView(sourceBytes);
  const alignedLength = align4(source.length);
  const padded = Buffer.alloc(alignedLength);
  source.copy(padded);
  const encrypted = Buffer.allocUnsafe(alignedLength);

  if (LITTLE_ENDIAN_CHECK && (padded.byteOffset & 3) === 0 && (encrypted.byteOffset & 3) === 0) {
    const sourceWords = new Uint32Array(padded.buffer, padded.byteOffset, alignedLength >>> 2);
    const encryptedWords = new Uint32Array(
      encrypted.buffer,
      encrypted.byteOffset,
      alignedLength >>> 2,
    );
    const xorMask = (checksum ^ PVF_PASSWORD) >>> 0;

    for (let index = 0; index < sourceWords.length; index += 1) {
      encryptedWords[index] = (rotateLeft32(sourceWords[index]!, 6) ^ xorMask) >>> 0;
    }

    return encrypted;
  }

  for (let index = 0; index < alignedLength; index += 4) {
    const value = padded.readUInt32LE(index);
    const next = (rotateLeft32(value, 6) ^ checksum ^ PVF_PASSWORD) >>> 0;
    encrypted.writeUInt32LE(next, index);
  }

  return encrypted;
}

export function getFileNameHashCode(fileNameBytes: Uint8Array): number {
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

export function createBuffKey(sourceBytes: Uint8Array, trueLen: number, seed: number): number {
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

export function isStructuredScriptChunk(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xb0 && bytes[1] === 0xd0;
}
