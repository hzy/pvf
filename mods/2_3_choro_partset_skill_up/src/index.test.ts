import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseEquDocument } from "@pvf/equ-ast";

import {
  DEFAULT_ARCHIVE_PATH,
  applyChoroPartsetSkillUpMod,
  buildChoroPartsetSkillUpMod,
  generateChoroPartsetSkillUpMod,
} from "./index.ts";
import { PvfArchive } from "../../../packages/pvf-core/src/index.ts";

const TARGET_SWORDMAN_SUPPORT_PATH = "equipment/character/common/support/support_3choro65.equ";
const TARGET_SWORDMAN_OUTPUT_PATH = "equipment/character/common/support/support_440453.equ";
const TARGET_EXORCIST_SUPPORT_PATH = "equipment/character/common/support/support_3choro83.equ";
const TARGET_EXORCIST_OUTPUT_PATH = "equipment/character/common/support/support_440471.equ";
const TARGET_AVENGER_SUPPORT_PATH = "equipment/character/common/support/support_3choro84.equ";
const TARGET_AVENGER_OUTPUT_PATH = "equipment/character/common/support/support_440472.equ";
const EQUIPMENT_LIST_PATH = "equipment/equipment.lst";
const AI_CHARACTER_LIST_PATH = "aicharacter/aicharacter.lst";
const TARGET_SUMMON_APC_PATH = "aicharacter/_jojochan/swordman/soldoros/soldoros_doll.aic";
const TARGET_SUMMON_APC_ID = 1520;
const EXPECTED_FILE_COUNT = 24;
const EXPECTED_OVERLAY_COUNT = EXPECTED_FILE_COUNT + 3;

test("buildChoroPartsetSkillUpMod returns generated support overlays and equipment list update", async () => {
  const result = await buildChoroPartsetSkillUpMod({
    archivePath: DEFAULT_ARCHIVE_PATH,
  });

  assert.equal(result.files.length, EXPECTED_FILE_COUNT);
  assert.equal(result.overlays.length, EXPECTED_OVERLAY_COUNT);
  assert.equal(result.skipped.length, 0);
  assert.ok(
    result.overlays.every(
      (overlay) => overlay.mode === "script" && typeof overlay.content === "string",
    ),
  );
  assert.ok(result.overlays.some((overlay) => overlay.path === EQUIPMENT_LIST_PATH));
  assert.ok(result.overlays.some((overlay) => overlay.path === AI_CHARACTER_LIST_PATH));
  assert.ok(result.overlays.some((overlay) => overlay.path === TARGET_SUMMON_APC_PATH));

  const swordmanSupport = result.files.find(
    (file) => file.supportPath === TARGET_SWORDMAN_SUPPORT_PATH,
  );
  const swordmanOverlay = result.overlays.find(
    (overlay) => overlay.path === swordmanSupport?.outputPath,
  );
  const exorcistSupport = result.files.find(
    (file) => file.supportPath === TARGET_EXORCIST_SUPPORT_PATH,
  );
  const avengerSupport = result.files.find(
    (file) => file.supportPath === TARGET_AVENGER_SUPPORT_PATH,
  );

  assert.ok(swordmanSupport);
  assert.ok(swordmanOverlay);
  assert.ok(exorcistSupport);
  assert.ok(avengerSupport);
  assert.equal(swordmanSupport.outputPath, TARGET_SWORDMAN_OUTPUT_PATH);
  assert.equal(exorcistSupport.outputPath, TARGET_EXORCIST_OUTPUT_PATH);
  assert.equal(avengerSupport.outputPath, TARGET_AVENGER_OUTPUT_PATH);
  assert.match(String(swordmanOverlay.content), /\[explain\]/u);
  assert.match(String(swordmanOverlay.content), /\[grade\]/u);
  assert.match(String(swordmanOverlay.content), /诸界融核臂章 - 剑魂/u);
  assert.match(
    String(swordmanOverlay.content),
    /剑圣索德罗斯协助自身战斗，剑圣索德罗斯存在15分钟。/u,
  );
  assert.match(String(swordmanOverlay.content), /\[command\]/u);
  assert.match(
    String(swordmanOverlay.content),
    new RegExp(`\\[summon apc\\]\\r?\\n${TARGET_SUMMON_APC_ID}\\t99\\t1`, "u"),
  );
  assert.match(String(swordmanOverlay.content), /\n\t.+/u);

  const summonApcOverlay = result.overlays.find(
    (overlay) => overlay.path === TARGET_SUMMON_APC_PATH,
  );

  assert.ok(summonApcOverlay);
  assert.match(String(summonApcOverlay.content), /剑圣索德罗斯/u);
  assert.match(String(summonApcOverlay.content), /\[attack damage rate\]\r?\n1\.0/u);

  const swordmanDocument = parseEquDocument(String(swordmanOverlay.content));
  const explainIndex = swordmanDocument.children.findIndex(
    (node) => node.kind === "section" && node.name === "explain",
  );
  const gradeIndex = swordmanDocument.children.findIndex(
    (node) => node.kind === "section" && node.name === "grade",
  );

  assert.ok(explainIndex >= 0);
  assert.ok(gradeIndex >= 0);
  assert.ok(explainIndex < gradeIndex);
});

test("generateChoroPartsetSkillUpMod creates Choro support overlay files", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "pvf-choro-mod-"));

  try {
    const result = await generateChoroPartsetSkillUpMod({
      archivePath: DEFAULT_ARCHIVE_PATH,
      outputDir,
    });

    assert.equal(result.files.length, EXPECTED_FILE_COUNT);
    assert.equal(result.overlays.length, EXPECTED_OVERLAY_COUNT);
    assert.equal(result.skipped.length, 0);

    const swordmanSupport = result.files.find(
      (file) => file.supportPath === TARGET_SWORDMAN_SUPPORT_PATH,
    );
    const exorcistSupport = result.files.find(
      (file) => file.supportPath === TARGET_EXORCIST_SUPPORT_PATH,
    );
    const avengerSupport = result.files.find(
      (file) => file.supportPath === TARGET_AVENGER_SUPPORT_PATH,
    );

    assert.ok(swordmanSupport);
    assert.ok(exorcistSupport);
    assert.ok(avengerSupport);
    assert.ok(
      swordmanSupport.sourcePartsets.includes(
        "equipment/character/partset/2choroset3.equ",
      ),
    );

    const swordmanText = await readFile(
      resolve(outputDir, TARGET_SWORDMAN_OUTPUT_PATH),
      "utf8",
    );
    const summonApcText = await readFile(
      resolve(outputDir, TARGET_SUMMON_APC_PATH),
      "utf8",
    );
    const aiCharacterListText = await readFile(
      resolve(outputDir, AI_CHARACTER_LIST_PATH),
      "utf8",
    );
    const equipmentListText = await readFile(
      resolve(outputDir, EQUIPMENT_LIST_PATH),
      "utf8",
    );

    assert.match(swordmanText, /\[skill data up\]/u);
    assert.match(swordmanText, /\[explain\]/u);
    assert.match(swordmanText, /诸界融核臂章 - 剑魂/u);
    assert.match(
      swordmanText,
      /剑圣索德罗斯协助自身战斗，剑圣索德罗斯存在15分钟。/u,
    );
    assert.match(
      swordmanText,
      /\{6=`\(UP\)`\}\r?\n\{8=`,`\}\r?\n\{6=`\(DOWN\)`\}\r?\n\{8=`,`\}\r?\n\{6=`\(CREATURE\)`\}/u,
    );
    assert.match(
      swordmanText,
      new RegExp(`\\[summon apc\\]\\r?\\n${TARGET_SUMMON_APC_ID}\\t99\\t1`, "u"),
    );
    assert.match(summonApcText, /剑圣索德罗斯/u);
    assert.match(summonApcText, /\[attack damage rate\]\r?\n1\.0/u);
    assert.match(
      aiCharacterListText,
      /1520\t`_jojochan\/swordman\/soldoros\/soldoros_doll\.aic`/u,
    );
    assert.match(swordmanText, /\n\t.+/u);
    assert.match(
      swordmanText,
      /108\t`\[dungeon type\]`\r?\n`\[level\]`\r?\n3\t`%`\r?\n30/u,
    );
    assert.match(
      equipmentListText,
      /440453\t`character\/common\/support\/support_440453\.equ`/u,
    );
    assert.match(
      equipmentListText,
      /440471\t`character\/common\/support\/support_440471\.equ`/u,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("applyChoroPartsetSkillUpMod writes Choro support overlays into a new PVF", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pvf-choro-mod-"));
  const archivePath = resolve(workDir, "Script.source.pvf");
  const outputPath = resolve(workDir, "Script.mod.pvf");

  try {
    await copyFile(DEFAULT_ARCHIVE_PATH, archivePath);

    const result = await applyChoroPartsetSkillUpMod({
      archivePath,
      outputPath,
    });

    assert.equal(result.files.length, EXPECTED_FILE_COUNT);
    assert.equal(result.skipped.length, 0);
    assert.ok(result.updatedPaths.includes(AI_CHARACTER_LIST_PATH));
    assert.ok(result.updatedPaths.includes(EQUIPMENT_LIST_PATH));
    assert.ok(result.addedPaths.includes(TARGET_SUMMON_APC_PATH));
    assert.ok(result.addedPaths.includes(TARGET_SWORDMAN_OUTPUT_PATH));
    assert.ok(result.addedPaths.includes(TARGET_EXORCIST_OUTPUT_PATH));
    assert.ok(result.addedPaths.includes(TARGET_AVENGER_OUTPUT_PATH));

    const archive = new PvfArchive("Script.mod.pvf", outputPath);

    try {
      await archive.ensureLoaded();
      const content = await archive.readRenderedFile(
        TARGET_SWORDMAN_OUTPUT_PATH,
        "simplified",
      );
      const summonApcText = await archive.readRenderedFile(
        TARGET_SUMMON_APC_PATH,
        "simplified",
      );
      const aiCharacterListText = await archive.readRenderedFile(
        AI_CHARACTER_LIST_PATH,
        "simplified",
      );
      const equipmentListText = await archive.readRenderedFile(
        EQUIPMENT_LIST_PATH,
        "simplified",
      );

      assert.match(content, /\[skill data up\]/u);
      assert.match(content, /\[explain\]/u);
      assert.match(content, /诸界融核臂章 - 剑魂/u);
      assert.match(
        content,
        /剑圣索德罗斯协助自身战斗，剑圣索德罗斯存在15分钟。/u,
      );
      assert.match(content, /\[if\]\r?\n\r?\n\[use command\]\r?\n1/u);
      assert.match(
        content,
        new RegExp(`\\[summon apc\\]\\r?\\n${TARGET_SUMMON_APC_ID}\\t99\\t1`, "u"),
      );
      assert.match(summonApcText, /剑圣索德罗斯/u);
      assert.match(summonApcText, /\[attack damage rate\]\r?\n1\.0/u);
      assert.match(
        aiCharacterListText,
        /1520\t`_jojochan\/swordman\/soldoros\/soldoros_doll\.aic`/u,
      );
      assert.match(content, /\n\t.+/u);
      assert.match(
        content,
        /108\t`\[dungeon type\]`\r?\n`\[level\]`\r?\n3\t`%`\r?\n30/u,
      );
      assert.match(
        equipmentListText,
        /440453\t`character\/common\/support\/support_440453\.equ`/u,
      );
    } finally {
      await archive.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("generated Choro support overlay files remain parseable", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "pvf-choro-mod-"));

  try {
    const result = await generateChoroPartsetSkillUpMod({
      archivePath: DEFAULT_ARCHIVE_PATH,
      outputDir,
    });

    for (const file of result.files) {
      const content = await readFile(resolve(outputDir, file.outputPath), "utf8");
      const document = parseEquDocument(content);
      const skillDataUpSections = document.children.filter(
        (node): node is (typeof document.children)[number] & { kind: "section" } =>
          node.kind === "section" && node.name === "skill data up",
      );
      const explainSections = document.children.filter(
        (node): node is (typeof document.children)[number] & { kind: "section" } =>
          node.kind === "section" && node.name === "explain",
      );
      const commandSections = document.children.filter(
        (node): node is (typeof document.children)[number] & { kind: "section" } =>
          node.kind === "section" && node.name === "command",
      );
      const ifSections = document.children.filter(
        (node): node is (typeof document.children)[number] & { kind: "section" } =>
          node.kind === "section" && node.name === "if",
      );
      const thenSections = document.children.filter(
        (node): node is (typeof document.children)[number] & { kind: "section" } =>
          node.kind === "section" && node.name === "then",
      );

      assert.equal(skillDataUpSections.length, 1, file.supportPath);
      assert.equal(explainSections.length, 1, file.supportPath);
      assert.equal(commandSections.length, 1, file.supportPath);
      assert.equal(ifSections.length, 1, file.supportPath);
      assert.equal(thenSections.length, 1, file.supportPath);
      assert.ok(skillDataUpSections[0]?.children.length, file.supportPath);
      assert.notEqual(file.supportPath, file.outputPath, file.className);
      const explainToken = explainSections[0]?.children[0];
      assert.ok(explainToken?.kind === "statement", file.supportPath);

      if (explainToken?.kind !== "statement") {
        throw new Error(`Missing explain statement for ${file.supportPath}`);
      }

      const firstToken = explainToken.tokens[0];
      assert.ok(firstToken?.kind === "string", file.supportPath);

      if (firstToken?.kind !== "string") {
        throw new Error(`Missing explain string token for ${file.supportPath}`);
      }

      assert.match(
        firstToken.value,
        /剑圣索德罗斯协助自身战斗，剑圣索德罗斯存在15分钟。\n获得以下套装的套装效果：\n\t.+/u,
        file.supportPath,
      );
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
