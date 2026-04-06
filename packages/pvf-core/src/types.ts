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
