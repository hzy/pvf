import assert from "node:assert/strict";
import test from "node:test";

import {
  createSection,
  createStatement,
  createStringToken,
  parseEquDocument,
  stringifyEquDocument,
  visitEqu,
} from "./equ.ts";
import type { EquDocument, EquSectionNode, EquToken } from "./equ.ts";
import { expectedStrings, fixturePath, samplePaths } from "./pvf.fixture.ts";
import { PvfArchive } from "./pvf.ts";

function collectTopLevelSections(document: EquDocument): EquSectionNode[] {
  return document.children.filter((node): node is EquSectionNode => node.kind === "section");
}

function findTopLevelSection(document: EquDocument, name: string): EquSectionNode {
  const section = collectTopLevelSections(document).find((node) => node.name === name);

  if (!section) {
    throw new Error(`Missing top-level section [${name}]`);
  }

  return section;
}

function getFirstToken(section: EquSectionNode): EquToken {
  const firstChild = section.children[0];

  if (firstChild?.kind !== "statement" || firstChild.tokens.length === 0) {
    throw new Error(`Section [${section.name}] does not contain a statement token.`);
  }

  return firstChild.tokens[0] ?? (() => {
    throw new Error(`Section [${section.name}] does not contain a token.`);
  })();
}

test("parses simple .equ sections into a mutable AST", async () => {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();

  const document = await archive.readEquDocument(samplePaths.amulet, "simplified");
  const topLevelSections = collectTopLevelSections(document);

  assert.equal(topLevelSections[0]?.name, "name");
  assert.equal(topLevelSections[1]?.name, "name2");

  const nameToken = getFirstToken(findTopLevelSection(document, "name"));
  assert.equal(nameToken.kind, "link");

  if (nameToken.kind !== "link") {
    throw new Error("Expected link token.");
  }

  assert.equal(nameToken.index, 3);
  assert.equal(nameToken.key, "name_100300002");
  assert.equal(nameToken.value, expectedStrings.amuletName);

  const minimumLevelToken = getFirstToken(findTopLevelSection(document, "minimum level"));
  assert.equal(minimumLevelToken.kind, "int");

  if (minimumLevelToken.kind !== "int") {
    throw new Error("Expected int token.");
  }

  assert.equal(minimumLevelToken.value, 70);

  const usableJobSection = findTopLevelSection(document, "usable job");
  assert.equal(usableJobSection.closable, true);
  assert.equal(getFirstToken(usableJobSection).kind, "string");

  await archive.close();
});

test("parses repeated closable blocks and nested sections", async () => {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();

  const titleDocument = await archive.readEquDocument(samplePaths.title, "simplified");
  const titleSections = collectTopLevelSections(titleDocument);
  const ifSections = titleSections.filter((section) => section.name === "if");
  const thenSections = titleSections.filter((section) => section.name === "then");

  assert.equal(ifSections.length, 2);
  assert.equal(thenSections.length, 2);
  assert.ok(ifSections.every((section) => section.closable));
  assert.ok(thenSections.every((section) => section.closable));
  assert.ok(
    ifSections.every((section) => section.children.some((child) => child.kind === "section")),
  );

  const weaponDocument = await archive.readEquDocument(samplePaths.weaponStaff, "simplified");
  const emancipateSection = findTopLevelSection(weaponDocument, "emancipate");

  assert.equal(emancipateSection.closable, true);
  assert.deepEqual(
    emancipateSection.children
      .filter((child): child is EquSectionNode => child.kind === "section")
      .map((child) => child.name),
    ["input", "output", "emancipate explain"],
  );

  await archive.close();
});

test("round-trips representative .equ files through parse/stringify/parse", async () => {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();

  for (
    const equPath of [
      samplePaths.amulet,
      samplePaths.title,
      samplePaths.weaponStaff,
      samplePaths.avatarCap,
    ]
  ) {
    const original = await archive.readEquDocument(equPath, "simplified");
    const reparsed = parseEquDocument(stringifyEquDocument(original));
    assert.deepEqual(reparsed, original, `Roundtrip mismatch for ${equPath}`);
  }

  await archive.close();
});

test("round-trips multiline direct-text sections", () => {
  const source = [
    "#PVF_File",
    "",
    "[explain]",
    "`获得以下套装的套装效果：",
    "\t套装1",
    "\t套装2`",
    "",
    "[grade]",
    "72\t",
    "",
  ].join("\r\n");

  const document = parseEquDocument(source);
  const explainSection = findTopLevelSection(document, "explain");
  const explainToken = getFirstToken(explainSection);

  assert.equal(explainToken.kind, "string");

  if (explainToken.kind !== "string") {
    throw new Error("Expected string token.");
  }

  assert.equal(explainToken.value, "获得以下套装的套装效果：\n\t套装1\n\t套装2");

  const reparsed = parseEquDocument(stringifyEquDocument(document));
  assert.deepEqual(reparsed, document);
});

test("visitor callbacks can mutate sections and tokens", async () => {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();

  const document = await archive.readEquDocument(samplePaths.amulet, "simplified");

  visitEqu(document, {
    link(token, context) {
      if (context.currentSection?.name === "name") {
        token.value = expectedStrings.modifiedAmuletName;
      }
    },
    int(token, context) {
      if (context.currentSection?.name === "minimum level") {
        token.value = 80;
      }
    },
  });

  const reparsed = parseEquDocument(stringifyEquDocument(document));
  const nameToken = getFirstToken(findTopLevelSection(reparsed, "name"));
  const levelToken = getFirstToken(findTopLevelSection(reparsed, "minimum level"));

  assert.equal(nameToken.kind, "link");

  if (nameToken.kind !== "link") {
    throw new Error("Expected link token.");
  }

  assert.equal(nameToken.value, expectedStrings.modifiedAmuletName);
  assert.equal(levelToken.kind, "int");

  if (levelToken.kind !== "int") {
    throw new Error("Expected int token.");
  }

  assert.equal(levelToken.value, 80);

  await archive.close();
});

test("stringifyEquDocument emits parseable multiline text tokens", () => {
  const document: EquDocument = {
    kind: "document",
    header: "#PVF_File",
    children: [
      createSection("explain", [
        createStatement([
          createStringToken("获得以下套装的套装效果：\n\t套装1\n\t套装2"),
        ]),
      ]),
      createSection("grade", [
        createStatement([{ kind: "int", value: 72 }]),
      ]),
    ],
  };

  const reparsed = parseEquDocument(stringifyEquDocument(document));
  assert.deepEqual(reparsed, document);
});
