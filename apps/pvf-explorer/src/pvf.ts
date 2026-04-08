import {
  DEFAULT_TEXT_PROFILE,
  isStructuredScriptChunk,
  PvfArchive as CorePvfArchive,
  type TextProfile,
} from "../../../packages/pvf-core/src/index.ts";
import { type EquDocument, parseEquDocument } from "./equ.ts";

export {
  DEFAULT_TEXT_PROFILE,
  isStructuredScriptChunk,
} from "../../../packages/pvf-core/src/index.ts";
export type {
  DirectoryItem,
  PvfFileRecord,
  PvfHeader,
  TextProfile,
} from "../../../packages/pvf-core/src/index.ts";

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
