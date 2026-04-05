import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseEquDocument } from "@pvf/equ-ast";

import {
  DEFAULT_ARCHIVE_PATH,
  generateChoroPartsetSkillUpMod,
} from "./index.ts";

test("generateChoroPartsetSkillUpMod creates support files from stackable class data", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "pvf-choro-mod-"));

  try {
    const result = await generateChoroPartsetSkillUpMod({
      archivePath: DEFAULT_ARCHIVE_PATH,
      outputDir,
    });

    assert.equal(result.files.length, 22);
    assert.deepEqual(
      result.skipped.map((file) => file.className).sort(),
      ["复仇者", "驱魔师"],
    );

    const swordmanSupport = result.files.find(
      (file) => file.className === "剑魂",
    );

    assert.ok(swordmanSupport);
    assert.ok(
      swordmanSupport.sourcePartsets.includes(
        "equipment/character/partset/2choroset3.equ",
      ),
    );

    const swordmanText = await readFile(
      resolve(outputDir, swordmanSupport.outputPath),
      "utf8",
    );

    assert.match(swordmanText, /\[skill data up\]/u);
    assert.match(
      swordmanText,
      /108\t`\[dungeon type\]`\r?\n`\[level\]`\r?\n3\t`%`\r?\n30/u,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("generated support files remain parseable", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "pvf-choro-mod-"));

  try {
    const result = await generateChoroPartsetSkillUpMod({
      archivePath: DEFAULT_ARCHIVE_PATH,
      outputDir,
    });

    for (const file of result.files) {
      const content = await readFile(resolve(outputDir, file.outputPath), "utf8");
      const document = parseEquDocument(content);
      const skillDataUpSections = document.children.filter(
        (node): node is (typeof document.children)[number] & { kind: "section" } =>
          node.kind === "section" && node.name === "skill data up",
      );

      assert.equal(skillDataUpSections.length, 1, file.supportPath);
      assert.ok(skillDataUpSections[0]?.children.length, file.supportPath);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
