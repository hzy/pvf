import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PvfArchive } from "@pvf/pvf-core";
import { applyPvfPipeline, buildPvfPipeline, createPvfModRegistry } from "@pvf/pvf-mod";

import {
  AI_CHARACTER_LIST_PATH,
  SOLDOROS_DOLL_MOD_ID,
  soldorosDollModDefinition,
} from "./index.ts";
import type { SoldorosDollModSummary } from "./index.ts";

const FIXTURE_ARCHIVE_PATH = new URL("../../../fixtures/Script.pvf", import.meta.url).pathname;
const SOURCE_SUMMON_APC_PATH = "aicharacter/_jojochan/swordman/soldoros/soldoros.aic";
const TARGET_SUMMON_APC_PATH = "aicharacter/_jojochan/swordman/soldoros/soldoros_doll.aic";
const TARGET_SUMMON_APC_ID = 1520;

async function buildSoldorosPipeline() {
  const result = await buildPvfPipeline({
    archivePath: FIXTURE_ARCHIVE_PATH,
    registry: createPvfModRegistry([soldorosDollModDefinition]),
    pipeline: {
      id: "soldoros-only",
      mods: [
        {
          id: SOLDOROS_DOLL_MOD_ID,
        },
      ],
    },
  });
  const summary = result.mods[0]?.result as SoldorosDollModSummary | undefined;

  if (!summary) {
    throw new Error("Missing Soldoros doll pipeline summary.");
  }

  return {
    result,
    summary,
  };
}

test("soldoros mod creates a doll APC overlay and list entry", async () => {
  const { result, summary } = await buildSoldorosPipeline();
  const summonApcOverlay = result.overlays.find(
    (overlay) => overlay.path === TARGET_SUMMON_APC_PATH,
  );
  const aiCharacterListOverlay = result.overlays.find(
    (overlay) => overlay.path === AI_CHARACTER_LIST_PATH,
  );

  assert.equal(summary.sourceAicId, 1516);
  assert.equal(summary.sourcePath, SOURCE_SUMMON_APC_PATH);
  assert.equal(summary.dollAicId, TARGET_SUMMON_APC_ID);
  assert.equal(summary.dollPath, TARGET_SUMMON_APC_PATH);
  assert.equal(summary.created, true);
  assert.equal(result.overlays.length, 2);
  assert.ok(summonApcOverlay);
  assert.ok(aiCharacterListOverlay);
  assert.match(String(summonApcOverlay.content), /\[minimum info\][\s\S]*索德罗斯/u);
  assert.match(String(summonApcOverlay.content), /\[attack damage rate\]\r?\n1\.0/u);
  assert.doesNotMatch(String(summonApcOverlay.content), /\[armor subtype\]/u);
  assert.match(String(summonApcOverlay.content), /\[etc action\][\s\S]*action\/ex\.act/u);
  assert.doesNotMatch(String(summonApcOverlay.content), /ex2\.act/u);
  assert.match(
    String(aiCharacterListOverlay.content),
    /1520\t`_jojochan\/swordman\/soldoros\/soldoros_doll\.aic`/u,
  );
});

test("soldoros mod applies cleanly through the pipeline", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pvf-soldoros-pipeline-"));
  const outputPath = join(workDir, "Script.mod.pvf");

  try {
    const result = await applyPvfPipeline({
      archivePath: FIXTURE_ARCHIVE_PATH,
      outputPath,
      registry: createPvfModRegistry([soldorosDollModDefinition]),
      pipeline: {
        id: "soldoros-only",
        mods: [
          {
            id: SOLDOROS_DOLL_MOD_ID,
          },
        ],
      },
    });

    assert.ok(result.updatedPaths.includes(AI_CHARACTER_LIST_PATH));
    assert.ok(result.addedPaths.includes(TARGET_SUMMON_APC_PATH));

    const archive = new PvfArchive("Script.mod.pvf", outputPath);

    try {
      await archive.ensureLoaded();
      const summonApcText = await archive.readRenderedFile(
        TARGET_SUMMON_APC_PATH,
        "simplified",
      );
      const aiCharacterListText = await archive.readRenderedFile(
        AI_CHARACTER_LIST_PATH,
        "simplified",
      );

      assert.match(summonApcText, /\[minimum info\][\s\S]*索德罗斯/u);
      assert.match(summonApcText, /\[attack damage rate\]\r?\n1\.0/u);
      assert.match(
        aiCharacterListText,
        /1520\t`_jojochan\/swordman\/soldoros\/soldoros_doll\.aic`/u,
      );
    } finally {
      await archive.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
