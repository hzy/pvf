import assert from "node:assert/strict";
import { access, copyFile, rename, rm } from "node:fs/promises";

import {
  createIntToken,
  createStatement,
  createStringToken,
  parseEquDocument,
  stringifyEquDocument,
  type EquDocument,
  type EquSectionNode,
} from "../packages/equ-ast/src/index.ts";
import { PvfArchive, repackPvf } from "../packages/pvf-core/src/index.ts";

const TARGET_ITEM_PATH = "equipment/character/gunner/weapon/hcannon/cann_32343.equ";
const DEFAULT_TEXT_PROFILE = "simplified" as const;
const BOOSTED_NAME = "[测试]流光异体加农炮";
const BOOSTED_EXPLAIN =
  `\
[测试]
    [激光炮]大小 +300%%
    [激光炮]攻击力 +300%%
    [激光炮]冷却时间 -30%%


无法进行分解。`.replace(/\r?\n/g, "\n");

function getSection(document: EquDocument, name: string): EquSectionNode {
  const section = document.children.find(
    (child): child is EquSectionNode => child.kind === "section" && child.name === name,
  );

  if (!section) {
    throw new Error(`Missing section: ${name}`);
  }

  return section;
}

function replaceSectionWithInts(document: EquDocument, name: string, values: number[]): void {
  getSection(document, name).children = [
    createStatement(values.map((value) => createIntToken(value))),
  ];
}

function replaceSectionWithStrings(document: EquDocument, name: string, values: string[]): void {
  getSection(document, name).children = [
    ...values.map((value) => createStatement([createStringToken(value)])),
  ];
}

function boostTargetItem(document: EquDocument): void {
  replaceSectionWithStrings(document, "name", [BOOSTED_NAME]);
  replaceSectionWithStrings(document, "basic explain", [BOOSTED_EXPLAIN]);
  replaceSectionWithInts(document, "physical attack", [888]);
  replaceSectionWithInts(document, "equipment physical attack", [1888, 1600]);
  replaceSectionWithInts(document, "equipment magical attack", [1288, 1080]);
  replaceSectionWithInts(document, "separate attack", [2200, 1600]);

  getSection(document, "skill levelup").children = [
    createStatement([createStringToken("[gunner]")]),
    createStatement([createIntToken(39), createIntToken(10), createStringToken("[at gunner]")]),
    createStatement([createIntToken(39), createIntToken(10)]),
  ];

  getSection(document, "skill data up").children = [
    createStatement([createStringToken("[gunner]")]),
    createStatement([createIntToken(39), createStringToken("[all]")]),
    createStatement([createStringToken("[static]")]),
    createStatement([createIntToken(2), createStringToken("%")]),
    createStatement([createIntToken(300), createStringToken("[at gunner]")]),
    createStatement([createIntToken(39), createStringToken("[all]")]),
    createStatement([createStringToken("[static]")]),
    createStatement([createIntToken(2), createStringToken("%")]),
    createStatement([createIntToken(300)]),
  ];
}

async function backupIfMissing(sourcePath: string, backupPath: string): Promise<void> {
  try {
    await access(backupPath);
  } catch {
    await copyFile(sourcePath, backupPath);
  }
}

async function main(): Promise<void> {
  const sourcePath = process.argv[2] ?? process.env["TARGET_PVF"];

  if (!sourcePath) {
    throw new Error("Usage: node scripts/temp-boost-liuguang-hcannon.ts <Script.pvf>");
  }

  const tempOutputPath = `${sourcePath}.codex.tmp`;
  const backupPath = `${sourcePath}.codex.bak`;
  const sourceArchive = new PvfArchive("Script.pvf", sourcePath);

  try {
    await sourceArchive.ensureLoaded();

    if (!sourceArchive.hasFile(TARGET_ITEM_PATH)) {
      throw new Error(`Target item not found: ${TARGET_ITEM_PATH}`);
    }

    const original = await sourceArchive.readRenderedFile(TARGET_ITEM_PATH, DEFAULT_TEXT_PROFILE);
    const document = parseEquDocument(original);
    boostTargetItem(document);
    const overlayText = stringifyEquDocument(document);

    await repackPvf({
      sourcePath,
      outputPath: tempOutputPath,
      textProfile: DEFAULT_TEXT_PROFILE,
      overlays: [
        {
          path: TARGET_ITEM_PATH,
          content: overlayText,
        },
      ],
    });

    const verifyArchive = new PvfArchive("Script.pvf", tempOutputPath);

    try {
      await verifyArchive.ensureLoaded();
      const verified = await verifyArchive.readRenderedFile(TARGET_ITEM_PATH, DEFAULT_TEXT_PROFILE);
      assert.match(verified, /\[测试\]流光异体加农炮/u);
      assert.match(verified, /\[激光炮\]大小 \+300%%/u);
      assert.match(verified, /\[physical attack\]\r?\n888\t/u);
      assert.match(verified, /\[equipment physical attack\]\r?\n1888\t1600\t/u);
    } finally {
      await verifyArchive.close();
    }

    await backupIfMissing(sourcePath, backupPath);
    await rm(sourcePath, { force: true });
    await rename(tempOutputPath, sourcePath);

    console.log(`Boosted ${TARGET_ITEM_PATH}`);
    console.log(`Output: ${sourcePath}`);
    console.log(`Backup: ${backupPath}`);
  } finally {
    await sourceArchive.close();
    await rm(tempOutputPath, { force: true }).catch(() => {});
  }
}

await main();
