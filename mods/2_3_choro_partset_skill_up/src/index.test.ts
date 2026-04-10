import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseEquDocument } from "@pvf/equ-ast";
import { PvfArchive } from "@pvf/pvf-core";
import {
  applyPvfPipeline,
  buildPvfPipeline,
  createPvfModRegistry,
  runPvfMods,
  updateListedPathDocument,
} from "@pvf/pvf-mod";
import type { PvfMod } from "@pvf/pvf-mod";

import { AI_CHARACTER_LIST_PATH } from "./constants.ts";
import {
  CHORO_PARTSET_SKILL_UP_MOD_ID,
  choroPartsetSkillUpModDefinition,
  createChoroPartsetSkillUpMod,
} from "./index.ts";
import type { ChoroPartsetSkillUpModSummary } from "./index.ts";
import {
  SOLDOROS_DOLL_MOD_ID,
  SUPPORT_SUMMON_DOLL_HP_ITEM_ID,
  SUPPORT_SUMMON_DOLL_MP_ITEM_ID,
  buildSupportSummonDollDocument,
  soldorosDollModDefinition,
} from "../../soldoros_doll/src/index.ts";
import type { SoldorosDollModSummary } from "../../soldoros_doll/src/index.ts";

const FIXTURE_ARCHIVE_PATH = fileURLToPath(
  new URL("../../../fixtures/Script.pvf", import.meta.url),
);
const SOURCE_SUMMON_APC_PATH = "aicharacter/_jojochan/swordman/soldoros/soldoros.aic";
const TARGET_SWORDMAN_SUPPORT_PATH = "equipment/character/common/support/support_3choro65.equ";
const TARGET_SWORDMAN_OUTPUT_PATH = "equipment/character/common/support/support_440453.equ";
const TARGET_EXORCIST_SUPPORT_PATH = "equipment/character/common/support/support_3choro83.equ";
const TARGET_EXORCIST_OUTPUT_PATH = "equipment/character/common/support/support_440471.equ";
const TARGET_AVENGER_SUPPORT_PATH = "equipment/character/common/support/support_3choro84.equ";
const TARGET_AVENGER_OUTPUT_PATH = "equipment/character/common/support/support_440472.equ";
const EQUIPMENT_LIST_PATH = "equipment/equipment.lst";

function getQuickItemInts(content: string): number[] {
  const document = parseEquDocument(content);
  const quickItemSection = document.children.find(
    (node): node is (typeof document.children)[number] & { kind: "section" } =>
      node.kind === "section" && node.name === "quick item",
  );

  assert.ok(quickItemSection);
  const statement = quickItemSection.children.find(
    (child): child is (typeof quickItemSection.children)[number] & { kind: "statement" } =>
      child.kind === "statement",
  );

  assert.ok(statement);
  return statement.tokens.flatMap((token) => token.kind === "int" ? [token.value] : []);
}
const TARGET_SUMMON_APC_PATH = "aicharacter/_jojochan/swordman/soldoros/soldoros_doll.aic";
const TARGET_SUMMON_APC_ID = 1520;
const CUSTOM_SUMMON_APC_PATH = "aicharacter/_jojochan/swordman/soldoros/soldoros_custom_doll.aic";
const CUSTOM_SUMMON_APC_ID = 990_001;
const EXPECTED_FILE_COUNT = 24;
const EXPECTED_OVERLAY_COUNT = EXPECTED_FILE_COUNT + 3;

async function buildChoroPipeline() {
  const result = await buildPvfPipeline({
    archivePath: FIXTURE_ARCHIVE_PATH,
    registry: createPvfModRegistry([
      soldorosDollModDefinition,
      choroPartsetSkillUpModDefinition,
    ]),
    pipeline: {
      id: "choro-only",
      mods: [
        {
          id: SOLDOROS_DOLL_MOD_ID,
        },
        {
          id: CHORO_PARTSET_SKILL_UP_MOD_ID,
        },
      ],
    },
  });
  const soldorosSummary = result.mods[0]?.result as SoldorosDollModSummary | undefined;
  const summary = result.mods[1]?.result as ChoroPartsetSkillUpModSummary | undefined;

  if (!soldorosSummary) {
    throw new Error("Missing Soldoros prerequisite summary.");
  }

  if (!summary) {
    throw new Error("Missing Choro pipeline summary.");
  }

  return {
    result,
    soldorosSummary,
    summary,
  };
}

test("choro support mod omits summon command when the doll prerequisite is missing", async () => {
  const result = await buildPvfPipeline({
    archivePath: FIXTURE_ARCHIVE_PATH,
    registry: createPvfModRegistry([choroPartsetSkillUpModDefinition]),
    pipeline: {
      id: "choro-without-prerequisite",
      mods: [
        {
          id: CHORO_PARTSET_SKILL_UP_MOD_ID,
        },
      ],
    },
  });
  const summary = result.mods[0]?.result as ChoroPartsetSkillUpModSummary | undefined;

  if (!summary) {
    throw new Error("Missing Choro summary without prerequisite.");
  }

  const swordmanOverlay = result.overlays.find(
    (overlay) => overlay.path === TARGET_SWORDMAN_OUTPUT_PATH,
  );

  assert.equal(summary.files.length, EXPECTED_FILE_COUNT);
  assert.equal(summary.skipped.length, 0);
  assert.ok(swordmanOverlay);
  assert.ok(result.overlays.some((overlay) => overlay.path === EQUIPMENT_LIST_PATH));
  assert.ok(!result.overlays.some((overlay) => overlay.path === AI_CHARACTER_LIST_PATH));
  assert.ok(!result.overlays.some((overlay) => overlay.path === TARGET_SUMMON_APC_PATH));
  assert.match(String(swordmanOverlay.content), /\[explain\]/u);
  assert.match(String(swordmanOverlay.content), /获得以下套装的套装效果：/u);
  assert.doesNotMatch(
    String(swordmanOverlay.content),
    /剑圣索德罗斯协助自身战斗，剑圣索德罗斯存在15分钟。/u,
  );
  assert.doesNotMatch(String(swordmanOverlay.content), /\[command\]/u);
  assert.doesNotMatch(String(swordmanOverlay.content), /\[summon apc\]/u);
});

test("choro support mod discovers the summon APC id from previous mod overlays", async () => {
  const prerequisiteMod: PvfMod = {
    id: "inject-custom-soldoros-doll",
    async apply(session) {
      const aiCharacterListDocument = await session.readScriptDocument(AI_CHARACTER_LIST_PATH);
      const sourceSummonDocument = await session.readScriptDocument(SOURCE_SUMMON_APC_PATH);

      session.writeScriptDocument(
        CUSTOM_SUMMON_APC_PATH,
        buildSupportSummonDollDocument(sourceSummonDocument),
      );
      session.writeScriptDocument(
        AI_CHARACTER_LIST_PATH,
        updateListedPathDocument(
          aiCharacterListDocument,
          "aicharacter",
          [
            {
              id: CUSTOM_SUMMON_APC_ID,
              path: CUSTOM_SUMMON_APC_PATH,
            },
          ],
        ),
      );
    },
  };
  const result = await runPvfMods({
    archivePath: FIXTURE_ARCHIVE_PATH,
    mods: [prerequisiteMod, createChoroPartsetSkillUpMod()],
  });
  const swordmanOverlay = result.overlays.find(
    (overlay) => overlay.path === TARGET_SWORDMAN_OUTPUT_PATH,
  );

  assert.ok(swordmanOverlay);
  assert.match(
    String(swordmanOverlay.content),
    new RegExp(`\\[summon apc\\]\\r?\\n${CUSTOM_SUMMON_APC_ID}\\t99\\t1`, "u"),
  );
});

test("choro mod builds generated support overlays through the pipeline", async () => {
  const { result, soldorosSummary, summary } = await buildChoroPipeline();

  assert.equal(soldorosSummary.dollAicId, TARGET_SUMMON_APC_ID);
  assert.equal(summary.files.length, EXPECTED_FILE_COUNT);
  assert.equal(result.overlays.length, EXPECTED_OVERLAY_COUNT);
  assert.equal(summary.skipped.length, 0);
  assert.ok(
    result.overlays.every(
      (overlay) => overlay.mode === "script" && typeof overlay.content === "string",
    ),
  );
  assert.ok(result.overlays.some((overlay) => overlay.path === EQUIPMENT_LIST_PATH));
  assert.ok(result.overlays.some((overlay) => overlay.path === AI_CHARACTER_LIST_PATH));
  assert.ok(result.overlays.some((overlay) => overlay.path === TARGET_SUMMON_APC_PATH));

  const swordmanSupport = summary.files.find(
    (file) => file.supportPath === TARGET_SWORDMAN_SUPPORT_PATH,
  );
  const swordmanOverlay = result.overlays.find(
    (overlay) => overlay.path === swordmanSupport?.outputPath,
  );
  const exorcistSupport = summary.files.find(
    (file) => file.supportPath === TARGET_EXORCIST_SUPPORT_PATH,
  );
  const avengerSupport = summary.files.find(
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
  assert.match(String(summonApcOverlay.content), /\[minimum info\][\s\S]*索德罗斯/u);
  assert.match(String(summonApcOverlay.content), /\[attack damage rate\]\r?\n1\.0/u);
  assert.deepEqual(getQuickItemInts(String(summonApcOverlay.content)).slice(0, 4), [
    SUPPORT_SUMMON_DOLL_HP_ITEM_ID,
    1000,
    SUPPORT_SUMMON_DOLL_MP_ITEM_ID,
    1000,
  ]);

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

test("choro mod applies cleanly through the pipeline", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pvf-choro-pipeline-"));
  const outputPath = join(workDir, "Script.mod.pvf");

  try {
    const result = await applyPvfPipeline({
      archivePath: FIXTURE_ARCHIVE_PATH,
      outputPath,
      registry: createPvfModRegistry([
        soldorosDollModDefinition,
        choroPartsetSkillUpModDefinition,
      ]),
      pipeline: {
        id: "choro-only",
        mods: [
          {
            id: SOLDOROS_DOLL_MOD_ID,
          },
          {
            id: CHORO_PARTSET_SKILL_UP_MOD_ID,
          },
        ],
      },
    });

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
      assert.match(summonApcText, /\[minimum info\][\s\S]*索德罗斯/u);
      assert.match(summonApcText, /\[attack damage rate\]\r?\n1\.0/u);
      assert.deepEqual(getQuickItemInts(summonApcText).slice(0, 4), [
        SUPPORT_SUMMON_DOLL_HP_ITEM_ID,
        1000,
        SUPPORT_SUMMON_DOLL_MP_ITEM_ID,
        1000,
      ]);
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

test("generated choro overlays remain parseable", async () => {
  const { result, summary } = await buildChoroPipeline();

  for (const file of summary.files) {
    const overlay = result.overlays.find((candidate) => candidate.path === file.outputPath);

    assert.ok(overlay);
    const document = parseEquDocument(String(overlay.content));
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
});
