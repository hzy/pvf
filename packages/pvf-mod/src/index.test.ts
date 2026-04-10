import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { PvfMod } from "./index.ts";
import {
  applyPvfMods,
  createSingleStringSection,
  getFirstSectionString,
  replaceTopLevelSection,
  runPvfMods,
  writeOverlayDirectory,
} from "./index.ts";

const FIXTURE_ARCHIVE_PATH = fileURLToPath(
  new URL("../../../fixtures/Script.pvf", import.meta.url),
);
const TARGET_PATH = "equipment/character/common/support/support_440003.equ";

test("runPvfMods exposes previous overlays to later mods", async () => {
  const mods: PvfMod[] = [
    {
      id: "rename-support",
      async apply(session) {
        await session.updateScriptDocument(TARGET_PATH, (document) =>
          replaceTopLevelSection(
            document,
            createSingleStringSection("name", "mod-one-name"),
          ));
      },
    },
    {
      id: "verify-and-extend",
      async apply(session) {
        const document = await session.readScriptDocument(TARGET_PATH);
        assert.equal(getFirstSectionString(document.children, "name"), "mod-one-name");

        session.writeScriptDocument(
          TARGET_PATH,
          replaceTopLevelSection(
            document,
            createSingleStringSection("name2", "mod-two-name2"),
          ),
        );
      },
    },
  ];

  const result = await runPvfMods({
    archivePath: FIXTURE_ARCHIVE_PATH,
    mods,
  });
  const overlay = result.overlays.find((candidate) => candidate.path === TARGET_PATH);

  assert.ok(overlay);
  assert.match(String(overlay.content), /\[name\]\r?\n`mod-one-name`/u);
  assert.match(String(overlay.content), /\[name2\]\r?\n`mod-two-name2`/u);
  assert.deepEqual(
    result.executedMods.map((entry) => entry.modId),
    ["rename-support", "verify-and-extend"],
  );
});

test("applyPvfMods writes the final combined overlays", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pvf-mod-"));
  const outputPath = join(workDir, "Script.multi-mod.test.pvf");

  try {
    const result = await applyPvfMods({
      archivePath: FIXTURE_ARCHIVE_PATH,
      outputPath,
      mods: [
        {
          id: "rename-support",
          async apply(session) {
            await session.updateScriptDocument(TARGET_PATH, (document) =>
              replaceTopLevelSection(
                document,
                createSingleStringSection("name", "mod-apply-name"),
              ));
          },
        },
      ],
    });

    assert.ok(result.updatedPaths.includes(TARGET_PATH));
    assert.equal(result.executedMods.length, 1);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("writeOverlayDirectory rejects overlay paths that escape the output directory", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pvf-mod-overlay-"));

  try {
    await assert.rejects(
      writeOverlayDirectory(workDir, [
        {
          path: "../escaped.txt",
          content: "should fail",
          mode: "text",
        },
      ]),
      /must stay within/u,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
