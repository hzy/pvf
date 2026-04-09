import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PvfArchive } from "@pvf/pvf-core";
import { applyPvfPipeline, buildPvfPipeline, createPvfModRegistry } from "@pvf/pvf-mod";

import {
  EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID,
  ORIGINAL_WILD_STRAWBERRY_HP_RECOVERY,
  UPDATED_WILD_STRAWBERRY_HP_RECOVERY,
  WILD_STRAWBERRY_PATH,
  exampleWildStrawberryHpUpModDefinition,
} from "./index.ts";

const FIXTURE_ARCHIVE_PATH = new URL("../../../fixtures/Script.pvf", import.meta.url).pathname;

test("example wild strawberry mod updates the rendered overlay", async () => {
  const result = await buildPvfPipeline({
    archivePath: FIXTURE_ARCHIVE_PATH,
    registry: createPvfModRegistry([exampleWildStrawberryHpUpModDefinition]),
    pipeline: {
      id: "wild-strawberry-only",
      mods: [
        {
          id: EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID,
        },
      ],
    },
  });
  const overlay = result.overlays.find((candidate) => candidate.path === WILD_STRAWBERRY_PATH);
  const summary = result.mods[0]?.result;

  assert.ok(overlay);
  assert.deepEqual(summary, {
    path: WILD_STRAWBERRY_PATH,
    previousRecovery: ORIGINAL_WILD_STRAWBERRY_HP_RECOVERY,
    nextRecovery: UPDATED_WILD_STRAWBERRY_HP_RECOVERY,
  });
  assert.match(String(overlay.content), /\[hp recovery\]\r?\n`\+`\r?\n600\t1000\t`myself`/u);
});

test("example wild strawberry mod writes the updated PVF", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pvf-strawberry-mod-"));
  const outputPath = join(workDir, "Script.strawberry.pvf");

  try {
    const result = await applyPvfPipeline({
      archivePath: FIXTURE_ARCHIVE_PATH,
      outputPath,
      registry: createPvfModRegistry([exampleWildStrawberryHpUpModDefinition]),
      pipeline: {
        id: "wild-strawberry-only",
        mods: [
          {
            id: EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID,
          },
        ],
      },
    });

    assert.ok(result.updatedPaths.includes(WILD_STRAWBERRY_PATH));

    const archive = new PvfArchive("wild-strawberry-test", outputPath);

    try {
      await archive.ensureLoaded();
      const content = await archive.readRenderedFile(WILD_STRAWBERRY_PATH, "simplified");
      assert.match(content, /\[hp recovery\]\r?\n`\+`\r?\n600\t1000\t`myself`/u);
    } finally {
      await archive.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
