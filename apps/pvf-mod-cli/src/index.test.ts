import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runCli } from "./index.ts";

test("runCli list shows registered pipelines and mods", async () => {
  const output = await runCli(["list"]);

  assert.match(output, /Pipelines:/u);
  assert.match(output, /wild-strawberry-only/u);
  assert.match(output, /demo/u);
  assert.match(output, /example_wild_strawberry_hp_up/u);
  assert.match(output, /soldoros_doll/u);
  assert.match(output, /2_3_choro_partset_skill_up/u);
});

test("runCli build exports overlays and manifest for the example pipeline", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pvf-mod-cli-"));
  const overlayDir = join(workDir, "overlays");
  const manifestPath = join(workDir, "manifest.json");

  try {
    const output = await runCli([
      "build",
      "--pipeline",
      "wild-strawberry-only",
      "--out",
      overlayDir,
      "--manifest-out",
      manifestPath,
    ]);
    const overlayText = await readFile(
      resolve(overlayDir, "stackable/pharmaceutical/food_strawberry.stk"),
      "utf8",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      pipeline: { id: string };
      overlayPaths: string[];
    };

    assert.match(output, /Built pipeline wild-strawberry-only\./u);
    assert.match(overlayText, /\[hp recovery\]\r?\n`\+`\r?\n600\t1000\t`myself`/u);
    assert.equal(manifest.pipeline.id, "wild-strawberry-only");
    assert.ok(
      manifest.overlayPaths.includes("stackable/pharmaceutical/food_strawberry.stk"),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("runCli rejects unsafe implicit output paths for ad-hoc pipeline ids", async () => {
  await assert.rejects(
    runCli([
      "build",
      "--pipeline",
      "../escape",
      "--mod",
      "example_wild_strawberry_hp_up",
    ]),
    /pass --out explicitly/u,
  );
});
