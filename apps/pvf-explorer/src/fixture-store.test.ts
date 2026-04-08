import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FixtureStore } from "./fixture-store.ts";
import { fixturePath, samplePaths } from "./pvf.fixture.ts";
import { PvfArchive } from "./pvf.ts";

test("FixtureStore opens editable files as script edit sessions and saves them in place", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "pvf-fixture-store-"));
  const archivePath = path.join(workDir, "Script.pvf");
  const archiveId = "Script.pvf";

  try {
    await copyFile(fixturePath, archivePath);

    const store = new FixtureStore(workDir);

    try {
      const opened = await store.openArchiveFile(archiveId, samplePaths.amulet, "simplified");
      assert.equal(opened.editable, true);
      assert.ok(opened.session);
      assert.equal(opened.session?.version, 1);

      const modified = `${opened.content}[save smoke]\r\n\`updated by explorer\`\r\n\r\n`;
      const saved = await store.saveArchiveSession(
        opened.session?.id ?? "",
        modified,
        opened.session?.version ?? 0,
      );

      assert.match(saved.content, /\[save smoke\]/u);
      assert.match(saved.content, /`updated by explorer`/u);
      assert.equal(saved.session?.version, 2);

      const persistedArchive = new PvfArchive("Script.pvf", archivePath);

      try {
        await persistedArchive.ensureLoaded();
        const persisted = await persistedArchive.readRenderedFile(samplePaths.amulet, "simplified");
        assert.match(persisted, /\[save smoke\]/u);
        assert.match(persisted, /`updated by explorer`/u);
      } finally {
        await persistedArchive.close();
      }
    } finally {
      await store.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("FixtureStore marks older edit sessions as stale after another session saves", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "pvf-fixture-store-"));
  const archivePath = path.join(workDir, "Script.pvf");
  const archiveId = "Script.pvf";

  try {
    await copyFile(fixturePath, archivePath);

    const store = new FixtureStore(workDir);

    try {
      const first = await store.openArchiveFile(archiveId, samplePaths.amulet, "simplified");
      const second = await store.openArchiveFile(archiveId, samplePaths.amulet, "simplified");

      assert.ok(first.session);
      assert.ok(second.session);

      await store.saveArchiveSession(
        first.session?.id ?? "",
        `${first.content}[session one]\r\n\`writer\`\r\n\r\n`,
        first.session?.version ?? 0,
      );

      await assert.rejects(
        store.saveArchiveSession(
          second.session?.id ?? "",
          `${second.content}[session two]\r\n\`writer\`\r\n\r\n`,
          second.session?.version ?? 0,
        ),
        /stale/u,
      );
    } finally {
      await store.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("FixtureStore opens non-script files without edit sessions", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "pvf-fixture-store-"));
  const archivePath = path.join(workDir, "Script.pvf");
  const archiveId = "Script.pvf";

  try {
    await copyFile(fixturePath, archivePath);

    const store = new FixtureStore(workDir);

    try {
      const opened = await store.openArchiveFile(
        archiveId,
        "equipment/equipment.kor.str",
        "simplified",
      );

      assert.equal(opened.editable, false);
      assert.equal(opened.session, null);
    } finally {
      await store.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("FixtureStore rejects closed edit sessions", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "pvf-fixture-store-"));
  const archivePath = path.join(workDir, "Script.pvf");
  const archiveId = "Script.pvf";

  try {
    await copyFile(fixturePath, archivePath);

    const store = new FixtureStore(workDir);

    try {
      const opened = await store.openArchiveFile(archiveId, samplePaths.amulet, "simplified");
      assert.ok(opened.session);
      store.closeArchiveSession(opened.session?.id ?? "");

      await assert.rejects(
        store.saveArchiveSession(
          opened.session?.id ?? "",
          opened.content,
          opened.session?.version ?? 0,
        ),
        /not found/u,
      );
    } finally {
      await store.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
