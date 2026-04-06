import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseEquDocument } from "@pvf/equ-ast";

import { PvfArchive } from "../../../packages/pvf-core/src/index.ts";
import {
  applyChoroPartsetSkillUpMod,
  buildChoroPartsetSkillUpMod,
  DEFAULT_ARCHIVE_PATH,
  generateChoroPartsetSkillUpMod,
} from "./index.ts";

const TARGET_SWORDMAN_SUPPORT_PATH =
  "equipment/character/common/support/support_3choro65.equ";
const TARGET_EXORCIST_SUPPORT_PATH =
  "equipment/character/common/support/support_3choro83.equ";
const TARGET_AVENGER_SUPPORT_PATH =
  "equipment/character/common/support/support_3choro84.equ";
const EXPECTED_FILE_COUNT = 24;

test("buildChoroPartsetSkillUpMod returns target Choro support overlays", async () => {
  const result = await buildChoroPartsetSkillUpMod({
    archivePath: DEFAULT_ARCHIVE_PATH,
  });

  assert.equal(result.files.length, EXPECTED_FILE_COUNT);
  assert.equal(result.overlays.length, result.files.length);
  assert.equal(result.skipped.length, 0);
  assert.ok(
    result.overlays.every(
      (overlay) => overlay.mode === "script" && typeof overlay.content === "string",
    ),
  );

  const swordmanSupport = result.files.find(
    (file) => file.supportPath === TARGET_SWORDMAN_SUPPORT_PATH,
  );
  const swordmanOverlay = result.overlays.find(
    (overlay) => overlay.path === swordmanSupport?.supportPath,
  );
  const exorcistSupport = result.files.find(
    (file) => file.supportPath === TARGET_EXORCIST_SUPPORT_PATH,
  );
  const avengerSupport = result.files.find(
    (file) => file.supportPath === TARGET_AVENGER_SUPPORT_PATH,
  );

  assert.ok(swordmanSupport);
  assert.ok(swordmanOverlay);
  assert.ok(exorcistSupport);
  assert.ok(avengerSupport);
  assert.match(String(swordmanOverlay.content), /\[explain\]/u);
  assert.match(String(swordmanOverlay.content), /\[grade\]/u);
  assert.match(String(swordmanOverlay.content), /\n\t.+/u);

  const swordmanDocument = parseEquDocument(String(swordmanOverlay.content));
  const explainIndex = swordmanDocument.children.findIndex(
    (node) => node.kind === "section" && node.name === "explain",
  );
  const gradeIndex = swordmanDocument.children.findIndex(
    (node) => node.kind === "section" && node.name === "grade",
  );

  assert.ok(explainIndex >= 0);
  assert.ok(gradeIndex >= 0);
  assert.ok(explainIndex < gradeIndex);
});

test("generateChoroPartsetSkillUpMod creates Choro support overlay files", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "pvf-choro-mod-"));

  try {
    const result = await generateChoroPartsetSkillUpMod({
      archivePath: DEFAULT_ARCHIVE_PATH,
      outputDir,
    });

    assert.equal(result.files.length, EXPECTED_FILE_COUNT);
    assert.equal(result.overlays.length, result.files.length);
    assert.equal(result.skipped.length, 0);

    const swordmanSupport = result.files.find(
      (file) => file.supportPath === TARGET_SWORDMAN_SUPPORT_PATH,
    );
    const exorcistSupport = result.files.find(
      (file) => file.supportPath === TARGET_EXORCIST_SUPPORT_PATH,
    );
    const avengerSupport = result.files.find(
      (file) => file.supportPath === TARGET_AVENGER_SUPPORT_PATH,
    );

    assert.ok(swordmanSupport);
    assert.ok(exorcistSupport);
    assert.ok(avengerSupport);
    assert.ok(
      swordmanSupport.sourcePartsets.includes(
        "equipment/character/partset/2choroset3.equ",
      ),
    );

    const swordmanText = await readFile(
      resolve(outputDir, TARGET_SWORDMAN_SUPPORT_PATH),
      "utf8",
    );

    assert.match(swordmanText, /\[skill data up\]/u);
    assert.match(swordmanText, /\[explain\]/u);
    assert.match(swordmanText, /\n\t.+/u);
    assert.match(
      swordmanText,
      /108\t`\[dungeon type\]`\r?\n`\[level\]`\r?\n3\t`%`\r?\n30/u,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("applyChoroPartsetSkillUpMod writes Choro support overlays into a new PVF", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pvf-choro-mod-"));
  const archivePath = resolve(workDir, "Script.source.pvf");
  const outputPath = resolve(workDir, "Script.mod.pvf");

  try {
    await copyFile(DEFAULT_ARCHIVE_PATH, archivePath);

    const result = await applyChoroPartsetSkillUpMod({
      archivePath,
      outputPath,
    });

    assert.equal(result.files.length, EXPECTED_FILE_COUNT);
    assert.equal(result.skipped.length, 0);
    assert.ok(result.updatedPaths.includes(TARGET_SWORDMAN_SUPPORT_PATH));
    assert.ok(result.updatedPaths.includes(TARGET_EXORCIST_SUPPORT_PATH));
    assert.ok(result.updatedPaths.includes(TARGET_AVENGER_SUPPORT_PATH));

    const archive = new PvfArchive("Script.mod.pvf", outputPath);

    try {
      await archive.ensureLoaded();
      const content = await archive.readRenderedFile(
        TARGET_SWORDMAN_SUPPORT_PATH,
        "simplified",
      );

      assert.match(content, /\[skill data up\]/u);
      assert.match(content, /\[explain\]/u);
      assert.match(content, /\n\t.+/u);
      assert.match(
        content,
        /108\t`\[dungeon type\]`\r?\n`\[level\]`\r?\n3\t`%`\r?\n30/u,
      );
    } finally {
      await archive.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("generated Choro support overlay files remain parseable", async () => {
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
      const explainSections = document.children.filter(
        (node): node is (typeof document.children)[number] & { kind: "section" } =>
          node.kind === "section" && node.name === "explain",
      );

      assert.equal(skillDataUpSections.length, 1, file.supportPath);
      assert.equal(explainSections.length, 1, file.supportPath);
      assert.ok(skillDataUpSections[0]?.children.length, file.supportPath);
      const explainToken = explainSections[0]?.children[0];
      assert.ok(explainToken && explainToken.kind === "statement", file.supportPath);

      if (!explainToken || explainToken.kind !== "statement") {
        throw new Error(`Missing explain statement for ${file.supportPath}`);
      }

      const firstToken = explainToken.tokens[0];
      assert.ok(firstToken?.kind === "string", file.supportPath);

      if (firstToken?.kind !== "string") {
        throw new Error(`Missing explain string token for ${file.supportPath}`);
      }

      assert.match(firstToken.value, /^\S.+\n\t.+/u, file.supportPath);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
