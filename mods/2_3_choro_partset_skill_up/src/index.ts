import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseEquDocument,
  createCommandToken,
  createIdentifierToken,
  createStatement,
  createSection,
  createIntToken,
  createStringToken,
  stringifyEquDocument,
  type EquDocument,
  type EquNode,
  type EquSectionNode,
  type EquStatementNode,
} from "@pvf/equ-ast";

import {
  DEFAULT_TEXT_PROFILE,
  PvfArchive,
  type PvfOverlayFile,
  type TextProfile,
} from "../../../packages/pvf-core/src/index.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const DEFAULT_ARCHIVE_PATH = resolve(REPO_ROOT, "fixtures/Script.pvf");
const DEFAULT_OUTPUT_DIR = resolve(PACKAGE_ROOT, "out");

const STACKABLE_PATHS = [
  "stackable/event/bestfriend/event_8382.stk",
  "stackable/event/bestfriend/event_8383.stk",
] as const;

const EQUIPMENT_LIST_PATH = "equipment/equipment.lst";
const EQUIPMENT_PARTSET_PATH = "etc/equipmentpartset.etc";
const AI_CHARACTER_LIST_PATH = "aicharacter/aicharacter.lst";
const SUPPORT_TEMPLATE_PATH = "equipment/character/common/support/support_440003.equ";
const SUPPORT_NAME_SEPARATOR = " - ";
const TARGET_PIECE_COUNTS = new Set([3, 6, 9]);
const EXPLAIN_HEADING = "获得以下套装的套装效果：";
const GENERATED_SUPPORT_NAME_PREFIX = "诸界融核臂章";
const GENERATED_SUPPORT_ID_START = 440453;
const SUPPORT_SUMMON_SOURCE_NAME = "\u5251\u5723\u7d22\u5fb7\u7f57\u65af";
const SUPPORT_SUMMON_COOLDOWN = 900_000;
const SUPPORT_SUMMON_EXPLAIN =
  "↑↓+[宠物技能指令]输入时，可以召唤出剑圣索德罗斯协助自身战斗，剑圣索德罗斯存在15分钟。";
const SUPPORT_SUMMON_ATTACK_DAMAGE_RATE = "1.0";

export interface GenerateChoroPartsetSkillUpModOptions {
  archivePath?: string;
  outputDir?: string;
  textProfile?: TextProfile;
  cleanOutput?: boolean;
}

export interface BuildChoroPartsetSkillUpModOptions {
  archivePath?: string;
  textProfile?: TextProfile;
}

export interface ApplyChoroPartsetSkillUpModOptions {
  archivePath?: string;
  outputPath: string;
  textProfile?: TextProfile;
}

export interface GeneratedSupportFile {
  className: string;
  supportPath: string;
  equipmentId: number;
  outputPath: string;
  sourcePartsets: string[];
  skillEntryCount: number;
}

export interface SkippedSupportFile {
  className: string;
  supportPath: string;
  reason: string;
}

export interface GenerateChoroPartsetSkillUpModResult {
  archivePath: string;
  outputDir: string;
  textProfile: TextProfile;
  overlays: PvfOverlayFile[];
  files: GeneratedSupportFile[];
  skipped: SkippedSupportFile[];
}

export interface BuildChoroPartsetSkillUpModResult {
  archivePath: string;
  textProfile: TextProfile;
  overlays: PvfOverlayFile[];
  files: GeneratedSupportFile[];
  skipped: SkippedSupportFile[];
}

export interface ApplyChoroPartsetSkillUpModResult extends BuildChoroPartsetSkillUpModResult {
  outputPath: string;
  fileCount: number;
  updatedPaths: string[];
  addedPaths: string[];
  deletedPaths: string[];
}

interface SkillEntryBlock {
  pieceCount: number;
  sourcePartsetPath: string;
  statements: EquStatementNode[];
}

interface ListedPathEntry {
  id: number;
  path: string;
}

interface ListedPathFile {
  id: number;
  path: string;
}

function isSection(node: EquNode): node is EquSectionNode {
  return node.kind === "section";
}

function isStatement(node: EquNode): node is EquStatementNode {
  return node.kind === "statement";
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

async function readEquDocument(
  archive: PvfArchive,
  path: string,
  textProfile: TextProfile,
): Promise<EquDocument> {
  return parseEquDocument(await archive.readRenderedFile(path, textProfile));
}

function getSections(nodes: readonly EquNode[], name: string): EquSectionNode[] {
  return nodes.filter(
    (node): node is EquSectionNode => isSection(node) && node.name === name,
  );
}

function getFirstSection(
  nodes: readonly EquNode[],
  name: string,
): EquSectionNode | undefined {
  return getSections(nodes, name)[0];
}

function getStatementInts(statement: EquStatementNode): number[] {
  return statement.tokens.flatMap((token) =>
    token.kind === "int" ? [token.value] : [],
  );
}

function getFirstSectionInt(
  nodes: readonly EquNode[],
  name: string,
): number | undefined {
  const section = getFirstSection(nodes, name);
  const statement = section?.children.find(isStatement);
  return statement?.tokens.find((token) => token.kind === "int")?.value;
}

function getFirstSectionString(
  nodes: readonly EquNode[],
  name: string,
): string | undefined {
  const section = getFirstSection(nodes, name);
  const statement = section?.children.find(isStatement);
  const token = statement?.tokens.find(
    (candidate) => candidate.kind === "string" || candidate.kind === "link",
  );
  return token?.kind === "string" || token?.kind === "link"
    ? token.value
    : undefined;
}

function isJobMarkerStatement(statement: EquStatementNode): boolean {
  return (
    statement.tokens.length === 1 &&
    statement.tokens[0]?.kind === "string" &&
    statement.tokens[0].value.startsWith("[") &&
    statement.tokens[0].value.endsWith("]")
  );
}

function extractTrailingJobMarker(
  statement: EquStatementNode,
): EquStatementNode | undefined {
  const lastToken = statement.tokens.at(-1);

  if (
    statement.tokens.length < 2 ||
    lastToken?.kind !== "string" ||
    !lastToken.value.startsWith("[") ||
    !lastToken.value.endsWith("]")
  ) {
    return undefined;
  }

  return createStatement([lastToken]);
}

function stripTrailingJobMarker(statement: EquStatementNode): EquStatementNode {
  if (!extractTrailingJobMarker(statement)) {
    return statement;
  }

  return createStatement(statement.tokens.slice(0, -1));
}

function extractEquipmentIds(section: EquSectionNode | undefined): number[] {
  if (!section) {
    return [];
  }

  const values = section.children
    .filter(isStatement)
    .flatMap((statement) => getStatementInts(statement));
  const equipmentIds: number[] = [];

  for (let index = 0; index < values.length; index += 2) {
    const equipmentId = values[index];

    if (equipmentId !== undefined) {
      equipmentIds.push(equipmentId);
    }
  }

  return equipmentIds;
}

function extractCategoryNames(document: EquDocument): Map<string, string> {
  const section = getFirstSection(document.children, "booster category name");

  if (!section) {
    return new Map<string, string>();
  }

  const headerPairs = getSections(document.children, "booster select category")
    .map((categorySection) =>
      getStatementInts(categorySection.children.find(isStatement) ?? {
        kind: "statement",
        tokens: [],
      }),
    )
    .filter((pair): pair is [number, number] =>
      pair[0] !== undefined && pair[1] !== undefined,
    );
  const majorCategories = [...new Set(headerPairs.map(([majorCategory]) => majorCategory))]
    .sort((left, right) => left - right);
  const minorCount = headerPairs.reduce(
    (current, [, minorCategory]) => Math.max(current, minorCategory + 1),
    0,
  );
  const categoryValues = section.children
    .filter(isStatement)
    .flatMap((statement) =>
      statement.tokens.flatMap((token) =>
        token.kind === "string" || token.kind === "link" ? [token.value] : [],
      ),
    );
  const transferIndex = categoryValues.indexOf("请选择转职");

  if (majorCategories.length > 0 && minorCount > 0 && transferIndex >= 0) {
    const subclassValues = categoryValues.slice(transferIndex + 1);
    const categoryNames = new Map<string, string>();

    for (const [majorIndex, majorCategory] of majorCategories.entries()) {
      for (let minorCategory = 0; minorCategory < minorCount; minorCategory += 1) {
        const name = subclassValues[majorIndex * minorCount + minorCategory];

        if (!name || name === "无") {
          continue;
        }

        categoryNames.set(`${majorCategory}:${minorCategory}`, name);
      }
    }

    return categoryNames;
  }

  const categoryNames = new Map<string, string>();

  for (const statement of section.children.filter(isStatement)) {
    for (const token of statement.tokens) {
      if (token.kind !== "link") {
        continue;
      }

      const match = /^booster_category_(\d+)_(\d+)$/u.exec(token.key);

      if (!match || token.value === "无") {
        continue;
      }

      categoryNames.set(`${match[1]}:${match[2]}`, token.value);
    }
  }

  return categoryNames;
}

function mergeClassEquipmentIds(
  target: Map<string, Set<number>>,
  source: Map<string, number[]>,
): void {
  for (const [className, equipmentIds] of source) {
    let current = target.get(className);

    if (!current) {
      current = new Set();
      target.set(className, current);
    }

    for (const equipmentId of equipmentIds) {
      current.add(equipmentId);
    }
  }
}

function extractClassEquipmentIds(document: EquDocument): Map<string, number[]> {
  const categoryNames = extractCategoryNames(document);
  const classEquipmentIds = new Map<string, number[]>();

  for (const section of getSections(document.children, "booster select category")) {
    const headerStatement = section.children.find(isStatement);
    const [majorCategory, minorCategory] = headerStatement
      ? getStatementInts(headerStatement)
      : [];

    if (majorCategory === undefined || minorCategory === undefined) {
      continue;
    }

    const className = categoryNames.get(`${majorCategory}:${minorCategory}`);

    if (!className) {
      continue;
    }

    const equipmentIds = extractEquipmentIds(
      getFirstSection(section.children, "equipment"),
    );

    if (equipmentIds.length === 0) {
      continue;
    }

    classEquipmentIds.set(className, equipmentIds);
  }

  return classEquipmentIds;
}

async function loadEquipmentPathById(
  archive: PvfArchive,
  textProfile: TextProfile,
): Promise<Map<number, string>> {
  return loadListedPathById(
    archive,
    EQUIPMENT_LIST_PATH,
    "equipment",
    textProfile,
  );
}

async function loadListedPathById(
  archive: PvfArchive,
  listPath: string,
  rootPath: string,
  textProfile: TextProfile,
): Promise<Map<number, string>> {
  const content = await archive.readRenderedFile(listPath, textProfile);
  const pathById = new Map<number, string>();

  for (const rawLine of content.split(/\r?\n/u)) {
    const match = /^(\d+)\t`(.+)`$/u.exec(rawLine.trim());

    if (!match) {
      continue;
    }

    pathById.set(
      Number.parseInt(match[1] ?? "0", 10),
      `${rootPath}/${match[2] ?? ""}`,
    );
  }

  return pathById;
}

function findNextAvailableListedPathId(
  pathById: ReadonlyMap<number, string>,
  startId: number,
): number {
  let nextId = startId + 1;

  while (pathById.has(nextId)) {
    nextId += 1;
  }

  return nextId;
}

async function findAiCharacterByName(
  archive: PvfArchive,
  textProfile: TextProfile,
  targetName: string,
): Promise<ListedPathEntry> {
  const pathById = await loadListedPathById(
    archive,
    AI_CHARACTER_LIST_PATH,
    "aicharacter",
    textProfile,
  );

  for (const [aicId, aicPath] of [...pathById.entries()].sort(
    (left, right) => left[0] - right[0],
  )) {
    const document = await readEquDocument(archive, aicPath, textProfile);
    const minimumInfoName = getFirstSectionString(document.children, "minimum info")?.trim();

    if (minimumInfoName === targetName) {
      return {
        id: aicId,
        path: aicPath,
      };
    }
  }

  throw new Error(`Unable to find APC id for ${targetName}.`);
}

async function loadPartsetPathByIndex(
  archive: PvfArchive,
  textProfile: TextProfile,
): Promise<Map<number, string>> {
  const document = await readEquDocument(archive, EQUIPMENT_PARTSET_PATH, textProfile);
  const partsetPathByIndex = new Map<number, string>();

  for (const section of getSections(document.children, "equipment part set")) {
    const statement = section.children.find(isStatement);

    if (!statement) {
      continue;
    }

    const index = statement.tokens.find((token) => token.kind === "int")?.value;
    const pathToken = statement.tokens.find((token) => token.kind === "string");

    if (index === undefined || pathToken?.kind !== "string") {
      continue;
    }

    partsetPathByIndex.set(index, `equipment/${pathToken.value}`);
  }

  return partsetPathByIndex;
}

async function loadSupportPathsByClass(
  archive: PvfArchive,
  equipmentPathById: Map<number, string>,
  textProfile: TextProfile,
): Promise<Map<string, string[]>> {
  const supportPathsByClass = new Map<string, string[]>();

  for (const equipmentPath of equipmentPathById.values()) {
    if (!/support_3choro\d+\.equ$/iu.test(equipmentPath)) {
      continue;
    }

    const document = await readEquDocument(archive, equipmentPath, textProfile);
    const name = getFirstSectionString(document.children, "name");

    if (!name?.includes(SUPPORT_NAME_SEPARATOR)) {
      continue;
    }

    const className = name.split(SUPPORT_NAME_SEPARATOR).at(-1)?.trim();

    if (!className || supportPathsByClass.has(className)) {
      continue;
    }

    supportPathsByClass.set(className, [equipmentPath]);
  }

  return supportPathsByClass;
}

function createDocumentCache(
  archive: PvfArchive,
  textProfile: TextProfile,
): (path: string) => Promise<EquDocument> {
  const cache = new Map<string, Promise<EquDocument>>();

  return async (path: string): Promise<EquDocument> => {
    const existing = cache.get(path);

    if (existing) {
      return existing;
    }

    const created = readEquDocument(archive, path, textProfile);
    cache.set(path, created);
    return created;
  };
}

async function loadClassPartsets(
  archive: PvfArchive,
  textProfile: TextProfile,
  equipmentPathById: Map<number, string>,
  partsetPathByIndex: Map<number, string>,
): Promise<Map<string, string[]>> {
  const classEquipmentIds = new Map<string, Set<number>>();

  for (const stackablePath of STACKABLE_PATHS) {
    const document = await readEquDocument(archive, stackablePath, textProfile);
    mergeClassEquipmentIds(classEquipmentIds, extractClassEquipmentIds(document));
  }

  const readDocument = createDocumentCache(archive, textProfile);
  const classPartsets = new Map<string, string[]>();

  for (const [className, equipmentIds] of classEquipmentIds) {
    const partsetPaths = new Set<string>();

    for (const equipmentId of equipmentIds) {
      const equipmentPath = equipmentPathById.get(equipmentId);

      if (!equipmentPath) {
        continue;
      }

      const equipmentDocument = await readDocument(equipmentPath);
      const partsetIndex = getFirstSectionInt(
        equipmentDocument.children,
        "part set index",
      );

      if (partsetIndex === undefined) {
        continue;
      }

      const partsetPath = partsetPathByIndex.get(partsetIndex);

      if (partsetPath) {
        partsetPaths.add(partsetPath);
      }
    }

    classPartsets.set(className, [...partsetPaths].sort(comparePaths));
  }

  return classPartsets;
}

function extractSkillEntryBlocks(
  section: EquSectionNode,
  pieceCount: number,
  sourcePartsetPath: string,
): SkillEntryBlock[] {
  const statements = section.children.filter(isStatement);
  const blocks: SkillEntryBlock[] = [];
  let index = 0;
  let currentJobMarker = statements[index];

  if (!currentJobMarker || !isJobMarkerStatement(currentJobMarker)) {
    throw new Error(
      `Expected leading job marker in ${sourcePartsetPath} piece ${pieceCount}.`,
    );
  }

  index += 1;

  while (index < statements.length) {
    const blockStatements = statements.slice(index, index + 4);

    if (blockStatements.length < 4) {
      throw new Error(
        `Incomplete skill data up block in ${sourcePartsetPath} piece ${pieceCount}.`,
      );
    }

    const firstStatement = blockStatements[0];
    const secondStatement = blockStatements[1];
    const thirdStatement = blockStatements[2];
    const fourthStatement = blockStatements[3];

    if (
      !firstStatement ||
      !secondStatement ||
      !thirdStatement ||
      !fourthStatement
    ) {
      throw new Error(
        `Incomplete skill data up block in ${sourcePartsetPath} piece ${pieceCount}.`,
      );
    }

    const trailingJobMarker = extractTrailingJobMarker(fourthStatement);

    blocks.push({
      pieceCount,
      sourcePartsetPath,
      statements: [
        currentJobMarker,
        firstStatement,
        secondStatement,
        thirdStatement,
        stripTrailingJobMarker(fourthStatement),
      ],
    });

    index += 4;

    if (trailingJobMarker) {
      currentJobMarker = trailingJobMarker;
      continue;
    }

    const nextStatement = statements[index];

    if (nextStatement && isJobMarkerStatement(nextStatement)) {
      currentJobMarker = nextStatement;
      index += 1;
    }
  }

  return blocks;
}

async function loadSkillEntryBlocksByPartset(
  archive: PvfArchive,
  textProfile: TextProfile,
  partsetPaths: Iterable<string>,
): Promise<Map<string, SkillEntryBlock[]>> {
  const blocksByPartset = new Map<string, SkillEntryBlock[]>();

  for (const partsetPath of partsetPaths) {
    const document = await readEquDocument(archive, partsetPath, textProfile);
    const blocks: SkillEntryBlock[] = [];

    for (const section of getSections(document.children, "piece set ability")) {
      const pieceCount = getStatementInts(section.children.find(isStatement) ?? {
        kind: "statement",
        tokens: [],
      }).at(0);

      if (!pieceCount || !TARGET_PIECE_COUNTS.has(pieceCount)) {
        continue;
      }

      for (const skillSection of getSections(section.children, "skill data up")) {
        blocks.push(
          ...extractSkillEntryBlocks(skillSection, pieceCount, partsetPath),
        );
      }
    }

    blocksByPartset.set(partsetPath, blocks);
  }

  return blocksByPartset;
}

async function loadPartsetNameByPath(
  archive: PvfArchive,
  textProfile: TextProfile,
  partsetPaths: Iterable<string>,
): Promise<Map<string, string>> {
  const namesByPath = new Map<string, string>();

  for (const partsetPath of partsetPaths) {
    const document = await readEquDocument(archive, partsetPath, textProfile);
    const name = (
      getFirstSectionString(document.children, "set name")
      ?? getFirstSectionString(document.children, "name")
    )?.trim();

    if (name) {
      namesByPath.set(partsetPath, name);
    }
  }

  return namesByPath;
}

function dedupeSkillEntryBlocks(blocks: readonly SkillEntryBlock[]): SkillEntryBlock[] {
  const seen = new Set<string>();
  const uniqueBlocks: SkillEntryBlock[] = [];

  for (const block of blocks) {
    const key = JSON.stringify(block.statements);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueBlocks.push(block);
  }

  return uniqueBlocks;
}

function mergeSkillDataUpBlocks(blocks: readonly SkillEntryBlock[]): EquSectionNode {
  return createSection(
    "skill data up",
    blocks.flatMap((block) => block.statements),
    true,
  );
}

function replaceTopLevelSkillDataUp(
  document: EquDocument,
  skillDataUpSection: EquSectionNode,
): EquDocument {
  const nextChildren = document.children.filter(
    (node) => !isSection(node) || node.name !== "skill data up",
  );
  const insertIndex = nextChildren.findIndex(
    (node) =>
      isSection(node) &&
      (node.name === "possible kiri protect" || node.name === "icon mark"),
  );
  const safeInsertIndex = insertIndex === -1 ? nextChildren.length : insertIndex;

  nextChildren.splice(safeInsertIndex, 0, skillDataUpSection);

  return {
    ...document,
    children: nextChildren,
  };
}

function buildExplainText(sourcePartsets: readonly string[], partsetNameByPath: Map<string, string>): string {
  const seen = new Set<string>();
  const lines = [SUPPORT_SUMMON_EXPLAIN, EXPLAIN_HEADING];

  for (const partsetPath of sourcePartsets) {
    const partsetName = partsetNameByPath.get(partsetPath)?.trim();

    if (!partsetName || seen.has(partsetName)) {
      continue;
    }

    seen.add(partsetName);
    lines.push(`\t${partsetName}`);
  }

  return lines.join("\n");
}

function replaceTopLevelExplain(
  document: EquDocument,
  explainText: string,
): EquDocument {
  const nextChildren = document.children.filter(
    (node) => !isSection(node) || node.name !== "explain",
  );
  const explainSection = createSection("explain", [
    createStatement([createStringToken(explainText)]),
  ]);
  const insertIndex = nextChildren.findIndex(
    (node) => isSection(node) && node.name === "grade",
  );
  const safeInsertIndex = insertIndex === -1 ? nextChildren.length : insertIndex;

  nextChildren.splice(safeInsertIndex, 0, explainSection);

  return {
    ...document,
    children: nextChildren,
  };
}

function replaceTopLevelSection(
  document: EquDocument,
  section: EquSectionNode,
  insertBeforeNames: readonly string[] = [],
): EquDocument {
  const originalIndex = document.children.findIndex(
    (node) => isSection(node) && node.name === section.name,
  );
  const nextChildren = document.children.filter(
    (node) => !isSection(node) || node.name !== section.name,
  );

  if (originalIndex >= 0) {
    nextChildren.splice(Math.min(originalIndex, nextChildren.length), 0, section);
    return {
      ...document,
      children: nextChildren,
    };
  }

  const insertIndex = nextChildren.findIndex(
    (node) => isSection(node) && insertBeforeNames.includes(node.name),
  );
  const safeInsertIndex = insertIndex === -1 ? nextChildren.length : insertIndex;
  nextChildren.splice(safeInsertIndex, 0, section);

  return {
    ...document,
    children: nextChildren,
  };
}

function createSingleStringSection(name: string, value: string): EquSectionNode {
  return createSection(name, [createStatement([createStringToken(value)])]);
}

function createSingleIntSection(name: string, value: number): EquSectionNode {
  return createSection(name, [createStatement([createIntToken(value)])]);
}

function createSingleFloatLiteralSection(name: string, value: string): EquSectionNode {
  return createSection(name, [createStatement([createIdentifierToken(value)])]);
}

function buildSupportSummonSections(apcId: number): EquSectionNode[] {
  return [
    createSection(
      "command",
      [
        createStatement([createCommandToken(6, "(UP)")]),
        createStatement([createCommandToken(8, ",")]),
        createStatement([createCommandToken(6, "(DOWN)")]),
        createStatement([createCommandToken(8, ",")]),
        createStatement([createCommandToken(6, "(CREATURE)")]),
      ],
      true,
    ),
    createSection(
      "if",
      [
        createSingleIntSection("use command", 1),
        createSingleIntSection("cooltime", SUPPORT_SUMMON_COOLDOWN),
      ],
      true,
    ),
    createSection(
      "then",
      [
        createSingleIntSection("duration", SUPPORT_SUMMON_COOLDOWN),
        createSection("target", [
          createStatement([createStringToken("myself"), createIntToken(-1)]),
        ]),
        createSection("summon apc", [
          createStatement([
            createIntToken(apcId),
            // createIntToken(-1), // APC level, -1 to match player level.
            createIntToken(99),
            createIntToken(1),
          ]),
        ]),
      ],
      true,
    ),
  ];
}

function buildGeneratedSupportName(className: string): string {
  return `${GENERATED_SUPPORT_NAME_PREFIX}${SUPPORT_NAME_SEPARATOR}${className}`;
}

function buildGeneratedSupportPath(equipmentId: number): string {
  return `equipment/character/common/support/support_${equipmentId}.equ`;
}

function buildSupportSummonDollPath(archivePath: string): string {
  if (!archivePath.endsWith(".aic")) {
    throw new Error(`Expected .aic path, received ${archivePath}.`);
  }

  return archivePath.replace(/\.aic$/u, "_doll.aic");
}

function toListedPathRelativePath(
  archivePath: string,
  rootPath: string,
): string {
  const prefix = `${rootPath}/`;

  if (!archivePath.startsWith(prefix)) {
    throw new Error(`Expected ${rootPath} path, received ${archivePath}.`);
  }

  return archivePath.slice(prefix.length);
}

function createListedPathStatement(
  id: number,
  archivePath: string,
  rootPath: string,
): EquStatementNode {
  return createStatement([
    createIntToken(id),
    createStringToken(toListedPathRelativePath(archivePath, rootPath)),
  ]);
}

function updateListedPathDocument(
  document: EquDocument,
  rootPath: string,
  files: readonly ListedPathFile[],
): EquDocument {
  const overridesById = new Map(
    files.map((file) => [
      file.id,
      toListedPathRelativePath(file.path, rootPath),
    ]),
  );
  const overridePaths = new Set(overridesById.values());
  const entries = document.children
    .filter(isStatement)
    .map((statement) => {
      const id = statement.tokens.find((token) => token.kind === "int")?.value;
      const relativePath = statement.tokens.find((token) => token.kind === "string")?.value;

      return id !== undefined && relativePath !== undefined
        ? { id, relativePath }
        : undefined;
    })
    .filter(
      (
        entry,
      ): entry is {
        id: number;
        relativePath: string;
      } => entry !== undefined,
    )
    .filter(
      (entry) =>
        !overridesById.has(entry.id) && !overridePaths.has(entry.relativePath),
    );

  for (const file of files) {
    entries.push({
      id: file.id,
      relativePath: toListedPathRelativePath(file.path, rootPath),
    });
  }

  entries.sort((left, right) => left.id - right.id);

  return {
    ...document,
    children: entries.map((entry) =>
      createListedPathStatement(
        entry.id,
        `${rootPath}/${entry.relativePath}`,
        rootPath,
      ),
    ),
  };
}

function sortBySupportPath<T extends { supportPath: string }>(
  files: readonly T[],
): T[] {
  return [...files].sort((left, right) => comparePaths(left.supportPath, right.supportPath));
}

function sortOverlays(overlays: readonly PvfOverlayFile[]): PvfOverlayFile[] {
  return [...overlays].sort((left, right) => comparePaths(left.path, right.path));
}

export interface GeneratedChoroPartsetSkillUpManifest {
  archivePath: string;
  outputDir: string;
  textProfile: TextProfile;
  overlayPaths: string[];
  files: GeneratedSupportFile[];
  skipped: SkippedSupportFile[];
}

async function writeOverlayDirectory(
  outputDir: string,
  overlays: readonly PvfOverlayFile[],
): Promise<void> {
  for (const overlay of overlays) {
    if (overlay.delete || typeof overlay.content !== "string") {
      throw new Error(`Overlay export only supports text/script files: ${overlay.path}`);
    }

    const outputPath = resolve(outputDir, overlay.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, overlay.content, "utf8");
  }
}

async function writeManifest(
  outputDir: string,
  result: GenerateChoroPartsetSkillUpModResult,
): Promise<void> {
  const manifest: GeneratedChoroPartsetSkillUpManifest = {
    archivePath: result.archivePath,
    outputDir: result.outputDir,
    textProfile: result.textProfile,
    overlayPaths: result.overlays.map((overlay) => overlay.path),
    files: result.files,
    skipped: result.skipped,
  };

  await writeFile(
    resolve(outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

async function buildChoroPartsetSkillUpModFromArchive(
  archive: PvfArchive,
  archivePath: string,
  textProfile: TextProfile,
): Promise<BuildChoroPartsetSkillUpModResult> {
  const equipmentPathById = await loadEquipmentPathById(archive, textProfile);
  const partsetPathByIndex = await loadPartsetPathByIndex(archive, textProfile);
  const classPartsets = await loadClassPartsets(
    archive,
    textProfile,
    equipmentPathById,
    partsetPathByIndex,
  );
  const supportPathsByClass = await loadSupportPathsByClass(
    archive,
    equipmentPathById,
    textProfile,
  );

  const allPartsets = [
    ...new Set(Array.from(classPartsets.values()).flat()),
  ].sort(comparePaths);
  const blocksByPartset = await loadSkillEntryBlocksByPartset(
    archive,
    textProfile,
    allPartsets,
  );
  const partsetNameByPath = await loadPartsetNameByPath(
    archive,
    textProfile,
    allPartsets,
  );
  const templateDocument = await readEquDocument(
    archive,
    SUPPORT_TEMPLATE_PATH,
    textProfile,
  );
  const aiCharacterListPathById = await loadListedPathById(
    archive,
    AI_CHARACTER_LIST_PATH,
    "aicharacter",
    textProfile,
  );
  aiCharacterListPathById;
  const aiCharacterListDocument = parseEquDocument(
    await archive.readRenderedFile(AI_CHARACTER_LIST_PATH, textProfile),
  );
  const equipmentListDocument = parseEquDocument(
    await archive.readRenderedFile(EQUIPMENT_LIST_PATH, textProfile),
  );
  const supportSummonApc = await findAiCharacterByName(
    archive,
    textProfile,
    SUPPORT_SUMMON_SOURCE_NAME,
  );
  const supportSummonApcDocument = await readEquDocument(
    archive,
    supportSummonApc.path,
    textProfile,
  );
  const supportSummonDollId = findNextAvailableListedPathId(
    aiCharacterListPathById,
    supportSummonApc.id,
  );
  const supportSummonDollPath = buildSupportSummonDollPath(supportSummonApc.path);
  const files: GeneratedSupportFile[] = [];
  const overlays: PvfOverlayFile[] = [];
  const skipped: SkippedSupportFile[] = [];
  let nextEquipmentId = GENERATED_SUPPORT_ID_START;

  overlays.push({
    path: supportSummonDollPath,
    content: stringifyEquDocument(
      replaceTopLevelSection(
        supportSummonApcDocument,
        createSingleFloatLiteralSection(
          "attack damage rate",
          SUPPORT_SUMMON_ATTACK_DAMAGE_RATE,
        ),
      ),
    ),
    mode: "script",
  });
  overlays.push({
    path: AI_CHARACTER_LIST_PATH,
    content: stringifyEquDocument(
      updateListedPathDocument(
        aiCharacterListDocument,
        "aicharacter",
        [
          {
            id: supportSummonDollId,
            path: supportSummonDollPath,
          },
        ],
      ),
    ),
    mode: "script",
  });

  for (const [className, supportPaths] of [...supportPathsByClass].sort((left, right) =>
    comparePaths(left[1]?.[0] ?? "", right[1]?.[0] ?? ""),
  )) {
    const sourcePartsets = classPartsets.get(className) ?? [];

    if (sourcePartsets.length === 0) {
      for (const supportPath of supportPaths) {
        skipped.push({
          className,
          supportPath,
          reason: "No source partsets were listed in event_8382/event_8383.",
        });
      }
      continue;
    }

    const mergedBlocks = dedupeSkillEntryBlocks(
      sourcePartsets.flatMap((partsetPath) => blocksByPartset.get(partsetPath) ?? []),
    );

    if (mergedBlocks.length === 0) {
      for (const supportPath of supportPaths) {
        skipped.push({
          className,
          supportPath,
          reason: "Source partsets did not contain any 3/6/9 skill data up blocks.",
        });
      }
      continue;
    }

    const explainText = buildExplainText(sourcePartsets, partsetNameByPath);
    const skillDataUpSection = mergeSkillDataUpBlocks(mergedBlocks);

    for (const supportPath of supportPaths) {
      const sourceSupportDocument = await readEquDocument(
        archive,
        supportPath,
        textProfile,
      );
      const usableJobSection = getFirstSection(
        sourceSupportDocument.children,
        "usable job",
      );
      const characterItemCheckSection = getFirstSection(
        sourceSupportDocument.children,
        "character item check",
      );
      const equipmentId = nextEquipmentId;
      const outputPath = buildGeneratedSupportPath(equipmentId);
      let nextDocument = replaceTopLevelSection(
        templateDocument,
        createSingleStringSection("name", buildGeneratedSupportName(className)),
      );

      nextDocument = replaceTopLevelSection(
        nextDocument,
        createSingleStringSection("name2", ""),
      );

      if (usableJobSection) {
        nextDocument = replaceTopLevelSection(nextDocument, usableJobSection);
      }

      if (characterItemCheckSection) {
        nextDocument = replaceTopLevelSection(
          nextDocument,
          characterItemCheckSection,
          ["possible kiri protect", "icon mark"],
        );
      }

      for (const section of buildSupportSummonSections(supportSummonDollId)) {
        nextDocument = replaceTopLevelSection(
          nextDocument,
          section,
          ["skill data up", "possible kiri protect", "icon mark"],
        );
      }

      nextDocument = replaceTopLevelExplain(nextDocument, explainText);
      nextDocument = replaceTopLevelSkillDataUp(nextDocument, skillDataUpSection);

      overlays.push({
        path: outputPath,
        content: stringifyEquDocument(nextDocument),
        mode: "script",
      });
      files.push({
        className,
        supportPath,
        equipmentId,
        outputPath,
        sourcePartsets,
        skillEntryCount: mergedBlocks.length,
      });
      nextEquipmentId += 1;
    }
  }

  if (files.length > 0) {
    overlays.push({
      path: EQUIPMENT_LIST_PATH,
      content: stringifyEquDocument(
        updateListedPathDocument(
          equipmentListDocument,
          "equipment",
          files.map((file) => ({
            id: file.equipmentId,
            path: file.outputPath,
          })),
        ),
      ),
      mode: "script",
    });
  }

  return {
    archivePath,
    textProfile,
    overlays: sortOverlays(overlays),
    files: sortBySupportPath(files),
    skipped: sortBySupportPath(skipped),
  };
}

export async function buildChoroPartsetSkillUpMod(
  options: BuildChoroPartsetSkillUpModOptions = {},
): Promise<BuildChoroPartsetSkillUpModResult> {
  const archivePath = resolve(options.archivePath ?? DEFAULT_ARCHIVE_PATH);
  const textProfile = options.textProfile ?? DEFAULT_TEXT_PROFILE;
  const archive = new PvfArchive("mods/2_3_choro_partset_skill_up", archivePath);

  try {
    await archive.ensureLoaded();
    return await buildChoroPartsetSkillUpModFromArchive(
      archive,
      archivePath,
      textProfile,
    );
  } finally {
    await archive.close();
  }
}

export async function generateChoroPartsetSkillUpMod(
  options: GenerateChoroPartsetSkillUpModOptions = {},
): Promise<GenerateChoroPartsetSkillUpModResult> {
  const outputDir = resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const cleanOutput = options.cleanOutput ?? true;

  if (cleanOutput) {
    await rm(outputDir, { recursive: true, force: true });
  }

  await mkdir(outputDir, { recursive: true });

  const built = await buildChoroPartsetSkillUpMod(options);
  await writeOverlayDirectory(outputDir, built.overlays);

  const result: GenerateChoroPartsetSkillUpModResult = {
    ...built,
    outputDir,
  };

  await writeManifest(outputDir, result);
  return result;
}

export async function applyChoroPartsetSkillUpMod(
  options: ApplyChoroPartsetSkillUpModOptions,
): Promise<ApplyChoroPartsetSkillUpModResult> {
  const archivePath = resolve(options.archivePath ?? DEFAULT_ARCHIVE_PATH);
  const outputPath = resolve(options.outputPath);
  const textProfile = options.textProfile ?? DEFAULT_TEXT_PROFILE;
  const archive = new PvfArchive("mods/2_3_choro_partset_skill_up", archivePath);

  try {
    await archive.ensureLoaded();
    const built = await buildChoroPartsetSkillUpModFromArchive(
      archive,
      archivePath,
      textProfile,
    );
    const writeResult = await archive.write({
      outputPath,
      textProfile,
      overlays: built.overlays,
    });

    return {
      ...built,
      outputPath,
      fileCount: writeResult.fileCount,
      updatedPaths: writeResult.updatedPaths,
      addedPaths: writeResult.addedPaths,
      deletedPaths: writeResult.deletedPaths,
    };
  } finally {
    await archive.close();
  }
}

export async function readGeneratedManifest(
  outputDir = DEFAULT_OUTPUT_DIR,
): Promise<GeneratedChoroPartsetSkillUpManifest> {
  const content = await readFile(resolve(outputDir, "manifest.json"), "utf8");
  return JSON.parse(content) as GeneratedChoroPartsetSkillUpManifest;
}

export {
  DEFAULT_ARCHIVE_PATH,
  DEFAULT_OUTPUT_DIR,
  STACKABLE_PATHS,
};
