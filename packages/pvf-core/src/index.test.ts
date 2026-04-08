import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedStrings,
  fixturePath,
  samplePaths,
} from "../../../apps/pvf-explorer/src/pvf.fixture.ts";
import { PvfArchive } from "./index.ts";

test("PvfArchive.write rewrites Script.pvf with script and text overlays", async () => {
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
  const source = new PvfArchive("Script.pvf", fixturePath);
  await source.ensureLoaded();

  const result = await source.write({
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

  assert.equal(result.outputPath, null);
  assert.equal(result.strategy, "repack");
  assert.ok(result.updatedPaths.includes(samplePaths.amulet));
  assert.ok(result.updatedPaths.includes("equipment/equipment.kor.str"));
  assert.ok(result.updatedPaths.includes("stringtable.bin"));

  const repackedArchive = PvfArchive.fromBytes("Script.repacked.pvf", result.bytes);

  try {
    await repackedArchive.ensureLoaded();

    const repackedEqu = await repackedArchive.readRenderedFile(samplePaths.amulet, "simplified");
    const repackedStr = await repackedArchive.readRenderedFile(
      "equipment/equipment.kor.str",
      "simplified",
    );

    assert.match(repackedEqu, /\[writer smoke\]/u);
    assert.match(repackedEqu, /`brand new writer string`/u);
    assert.match(repackedEqu, new RegExp(expectedStrings.amuletName, "u"));
    assert.match(repackedStr, /writer_smoke_key>writer smoke value/u);
  } finally {
    await repackedArchive.close();
    await source.close();
  }
});

test("PvfArchive.write keeps the file tree sorted by file name hash when adding files", async () => {
  const source = new PvfArchive("Script.pvf", fixturePath);
  await source.ensureLoaded();

  const result = await source.write({
    textProfile: "simplified",
    overlays: [
      {
        path: "equipment/character/common/support/support_440453.equ",
        content: [
          "#PVF_File",
          "",
          "[name]",
          "`writer order test`",
          "",
        ].join("\r\n"),
        mode: "script",
      },
    ],
  });

  const repackedArchive = PvfArchive.fromBytes("Script.repacked.order-test.pvf", result.bytes);

  try {
    await repackedArchive.ensureLoaded();

    const entries = repackedArchive.entriesInOrder;
    let previousHash = -1;

    for (const entry of entries) {
      assert.ok(
        previousHash <= entry.fileNameHash,
        `File tree hash order regressed at ${entry.filePath}: ${previousHash} > ${entry.fileNameHash}`,
      );
      previousHash = entry.fileNameHash;
    }

    const addedEntry = repackedArchive.getFileRecord(
      "equipment/character/common/support/support_440453.equ",
    );

    assert.ok(addedEntry);
    assert.notEqual(addedEntry.treeIndex, entries.length - 1);
  } finally {
    await repackedArchive.close();
    await source.close();
  }
});
