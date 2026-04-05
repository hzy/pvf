import { parseEquDocument, type EquDocument } from "./equ.ts";
import {
  DEFAULT_TEXT_PROFILE,
  PvfArchive as CorePvfArchive,
  type TextProfile,
} from "../../../packages/pvf-core/src/index.ts";

export {
  DEFAULT_TEXT_PROFILE,
} from "../../../packages/pvf-core/src/index.ts";
export type {
  DirectoryItem,
  PvfFileRecord,
  PvfHeader,
  TextProfile,
} from "../../../packages/pvf-core/src/index.ts";

export class PvfArchive extends CorePvfArchive {
  async readEquDocument(
    path: string,
    textProfile: TextProfile = DEFAULT_TEXT_PROFILE,
  ): Promise<EquDocument> {
    return parseEquDocument(await this.readRenderedFile(path, textProfile));
  }
}
