import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PvfArchive } from "../../../apps/pvf-explorer/src/pvf.ts";
import { fixturePath, samplePaths } from "../../../apps/pvf-explorer/src/pvf.fixture.ts";
import { repackPvf } from "./index.ts";

test("repackPvf rewrites Script.pvf with script and text overlays", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "pvf-repack-"));
  const outputPath = path.join(workDir, "Script.repacked.pvf");
  const sourceArchive = new PvfArchive("Script.pvf", fixturePath);

  try {
    await sourceArchive.ensureLoaded();

    const originalEqu = await sourceArchive.readRenderedFile(samplePaths.amulet, "simplified");
    const modifiedEqu = `${originalEqu.trimEnd()}\r\n\r\n[writer smoke]\r\n\`brand new writer string\`\r\n`;

    const originalStr = await sourceArchive.readRenderedFile("equipment/equipment.kor.str", "simplified");
    const modifiedStr = originalStr.replace("upperset_name_cap>高级装扮-帽子", "upperset_name_cap>写出验证-帽子");

    const result = await repackPvf({
      sourcePath: fixturePath,
      outputPath,
      textProfile: "simplified",
      overlays: [
        {
          path: samplePaths.amulet,
          content: modifiedEqu,
        },
        {
          path: "equipment/equipment.kor.str",
          content: modifiedStr,
        },
      ],
    });

    assert.ok(result.updatedPaths.includes(samplePaths.amulet));
    assert.ok(result.updatedPaths.includes("equipment/equipment.kor.str"));
    assert.ok(result.updatedPaths.includes("stringtable.bin"));

    const repackedArchive = new PvfArchive("Script.repacked.pvf", outputPath);

    try {
      await repackedArchive.ensureLoaded();

      const repackedEqu = await repackedArchive.readRenderedFile(samplePaths.amulet, "simplified");
      const repackedStr = await repackedArchive.readRenderedFile("equipment/equipment.kor.str", "simplified");

      assert.match(repackedEqu, /\[writer smoke\]/u);
      assert.match(repackedEqu, /`brand new writer string`/u);
      assert.match(repackedStr, /upperset_name_cap>写出验证-帽子/u);
    } finally {
      await repackedArchive.close();
    }
  } finally {
    await sourceArchive.close();
    await rm(workDir, { recursive: true, force: true });
  }
});
