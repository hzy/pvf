import {
  PvfArchive as CorePvfArchive,
  DEFAULT_TEXT_PROFILE,
  isStructuredScriptChunk,
} from "@pvf/pvf-core";
import type { TextProfile } from "@pvf/pvf-core";

import { parseEquDocument } from "./equ.ts";
import type { EquDocument } from "./equ.ts";

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
