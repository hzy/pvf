import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const fixturePath = path.resolve(currentDir, "../../../fixtures/Script.pvf");

export const samplePaths = {
  equipmentList: "equipment/equipment.lst",
  amulet: "equipment/character/common/amulet/100300002.equ",
  nestedDirectory: "equipment/character/common/amulet",
} as const;

export const expectedStrings = {
  amuletName: "\u65f6\u7a7a\u4e3b\u5bb0\u8005\u9879\u94fe",
} as const;
