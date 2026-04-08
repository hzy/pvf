import {
  DEFAULT_TEXT_PROFILE,
  isStructuredScriptChunk,
  PvfArchive as CorePvfArchive,
  type TextProfile,
} from "@pvf/pvf-core";
import { type EquDocument, parseEquDocument } from "./equ.ts";

export { DEFAULT_TEXT_PROFILE, isStructuredScriptChunk } from "@pvf/pvf-core";
export type { DirectoryItem, PvfFileRecord, PvfHeader, TextProfile } from "@pvf/pvf-core";

export class PvfArchive extends CorePvfArchive {
  async isStructuredScriptFile(path: string): Promise<boolean> {
    return isStructuredScriptChunk(await this.readDecryptedFile(path));
  }

  async readEquDocument(
    path: string,
    textProfile: TextProfile = DEFAULT_TEXT_PROFILE,
  ): Promise<EquDocument> {
    return parseEquDocument(await this.readRenderedFile(path, textProfile));
  }
}
