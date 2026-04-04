import assert from "node:assert/strict";
import test from "node:test";

import { expectedStrings, fixturePath, samplePaths } from "./pvf.fixture.ts";
import { PvfArchive } from "./pvf.ts";

test("lists root directories from Script.pvf", async () => {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();

  const children = archive.listDirectory("");
  assert.ok(children.some((item) => item.kind === "directory" && item.name === "equipment"));
  assert.ok(children.some((item) => item.kind === "directory" && item.name === "character"));

  await archive.close();
});

test("renders equipment/equipment.lst in PVF text format", async () => {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();

  const content = await archive.readRenderedFile(samplePaths.equipmentList, "simplified");
  assert.match(content, /^#PVF_File\r\n/);
  assert.match(content, /character\/common\/jacket\/cloth\/vest_wool\.equ/);

  await archive.close();
});

test("renders simplified Chinese n_string values when the PVF is simplified", async () => {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();

  const content = await archive.readRenderedFile(samplePaths.amulet, "simplified");
  assert.match(content, new RegExp(expectedStrings.amuletName));

  await archive.close();
});
