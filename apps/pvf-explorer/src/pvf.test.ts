import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PvfArchive } from "./pvf.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDir, "../../../fixtures/Script.pvf");

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

  const content = await archive.readRenderedFile("equipment/equipment.lst");
  assert.match(content, /^#PVF_File\r\n/);
  assert.match(content, /character\/common\/jacket\/cloth\/vest_wool\.equ/);

  await archive.close();
});
