import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { fixturePath, samplePaths, expectedStrings } from "../../../apps/pvf-explorer/src/pvf.fixture.ts";
import { PvfArchive, repackPvf } from "./index.ts";

test("repackPvf rewrites Script.pvf with script and text overlays", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "pvf-repack-"));
  const outputPath = path.join(workDir, "Script.repacked.pvf");
  const modifiedEqu = [
    "#PVF_File",
    "",
    "[name]",
    `<3::name_100300002\`${expectedStrings.amuletName}\`>`,
    "",
    "[writer smoke]",
    "`brand new writer string`",
    "",
  ].join("\r\n");
  const modifiedStr = [
    "// Script\\Equipment",
    `name_100300002>${expectedStrings.amuletName}`,
    "writer_smoke_key>writer smoke value",
    "",
  ].join("\r\n");

  try {
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
      assert.match(repackedEqu, new RegExp(expectedStrings.amuletName, "u"));
      assert.match(repackedStr, /writer_smoke_key>writer smoke value/u);
    } finally {
      await repackedArchive.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
