import { decodeText, encodeText, toDataView } from "./codec.ts";
import type { TextProfile } from "./types.ts";

export class LazyStringTable {
  readonly textProfile: TextProfile;

  readonly #bytes: Buffer;
  readonly #view: DataView;
  readonly #count: number;
  readonly #values = new Map<number, string>();

  constructor(bytes: Uint8Array, textProfile: TextProfile) {
    this.#bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#view = toDataView(bytes);
    this.#count = this.#view.getInt32(0, true);
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

    const start = this.#view.getInt32(index * 4 + 4, true);
    const end = this.#view.getInt32(index * 4 + 8, true);
    const value = decodeText(this.#bytes.subarray(start + 4, end + 4), this.textProfile);
    this.#values.set(index, value);
    return value;
  }
}

export class MutableStringTable {
  readonly textProfile: TextProfile;

  readonly #baseBytes: Buffer;
  readonly #baseView: DataView;
  readonly #baseCount: number;
  #baseIndexByValue: Map<string, number> | undefined;
  readonly #appended = new Map<string, number>();
  readonly #appendedBytes: Buffer[] = [];

  constructor(baseBytes: Uint8Array, textProfile: TextProfile) {
    this.#baseBytes = Buffer.from(baseBytes.buffer, baseBytes.byteOffset, baseBytes.byteLength);
    this.#baseView = toDataView(baseBytes);
    this.#baseCount = this.#baseView.getInt32(0, true);
    this.textProfile = textProfile;
  }

  static empty(textProfile: TextProfile): MutableStringTable {
    const bytes = Buffer.alloc(8);
    bytes.writeInt32LE(0, 0);
    bytes.writeInt32LE(4, 4);
    return new MutableStringTable(bytes, textProfile);
  }

  get updated(): boolean {
    return this.#appendedBytes.length > 0;
  }

  getOrAdd(value: string): number {
    const appendedIndex = this.#appended.get(value);

    if (appendedIndex !== undefined) {
      return appendedIndex;
    }

    const baseIndex = this.#getBaseIndex(value);

    if (baseIndex !== undefined) {
      return baseIndex;
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
      const start = this.#baseView.getInt32(index * 4 + 4, true);
      const end = this.#baseView.getInt32(index * 4 + 8, true);
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

    const firstDataOffset = this.#baseView.getInt32(4, true);
    const lastDataOffset = this.#baseView.getInt32(4 + this.#baseCount * 4, true);
    return lastDataOffset - firstDataOffset;
  }

  #getBaseIndex(value: string): number | undefined {
    if (!this.#baseIndexByValue) {
      this.#baseIndexByValue = new Map();

      for (let index = 0; index < this.#baseCount; index += 1) {
        const start = this.#baseView.getInt32(index * 4 + 4, true);
        const end = this.#baseView.getInt32(index * 4 + 8, true);
        const decoded = decodeText(this.#baseBytes.subarray(start + 4, end + 4), this.textProfile);

        if (!this.#baseIndexByValue.has(decoded)) {
          this.#baseIndexByValue.set(decoded, index);
        }
      }
    }

    return this.#baseIndexByValue.get(value);
  }
}
