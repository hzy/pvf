import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createStatement,
  createSection,
  stringifyEquDocument,
  type EquDocument,
  type EquNode,
  type EquSectionNode,
  type EquStatementNode,
} from "@pvf/equ-ast";

import {
  DEFAULT_TEXT_PROFILE,
  PvfArchive,
  type TextProfile,
} from "../../../apps/pvf-explorer/src/pvf.ts";

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
const SUPPORT_NAME_SEPARATOR = " - ";
const TARGET_PIECE_COUNTS = new Set([3, 6, 9]);

export interface GenerateChoroPartsetSkillUpModOptions {
  archivePath?: string;
  outputDir?: string;
  textProfile?: TextProfile;
  cleanOutput?: boolean;
}

export interface GeneratedSupportFile {
  className: string;
  supportPath: string;
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
  files: GeneratedSupportFile[];
  skipped: SkippedSupportFile[];
}

interface SkillEntryBlock {
  pieceCount: number;
  sourcePartsetPath: string;
  statements: EquStatementNode[];
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
  const categoryNames = new Map<string, string>();
  const section = getFirstSection(document.children, "booster category name");

  if (!section) {
    return categoryNames;
  }

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
  const content = await archive.readRenderedFile(EQUIPMENT_LIST_PATH, textProfile);
  const equipmentPathById = new Map<number, string>();

  for (const rawLine of content.split(/\r?\n/u)) {
    const match = /^(\d+)\t`(.+)`$/u.exec(rawLine.trim());

    if (!match) {
      continue;
    }

    equipmentPathById.set(
      Number.parseInt(match[1] ?? "0", 10),
      `equipment/${match[2] ?? ""}`,
    );
  }

  return equipmentPathById;
}

async function loadPartsetPathByIndex(
  archive: PvfArchive,
  textProfile: TextProfile,
): Promise<Map<number, string>> {
  const document = await archive.readEquDocument(EQUIPMENT_PARTSET_PATH, textProfile);
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

async function loadSupportPathByClass(
  archive: PvfArchive,
  equipmentPathById: Map<number, string>,
  textProfile: TextProfile,
): Promise<Map<string, string>> {
  const supportPathByClass = new Map<string, string>();

  for (const equipmentPath of equipmentPathById.values()) {
    if (!/support_3choro\d+\.equ$/iu.test(equipmentPath)) {
      continue;
    }

    const document = await archive.readEquDocument(equipmentPath, textProfile);
    const name = getFirstSectionString(document.children, "name");

    if (!name?.includes(SUPPORT_NAME_SEPARATOR)) {
      continue;
    }

    const className = name.split(SUPPORT_NAME_SEPARATOR).at(-1)?.trim();

    if (!className || supportPathByClass.has(className)) {
      continue;
    }

    supportPathByClass.set(className, equipmentPath);
  }

  return supportPathByClass;
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

    const created = archive.readEquDocument(path, textProfile);
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
    const document = await archive.readEquDocument(stackablePath, textProfile);
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
    const document = await archive.readEquDocument(partsetPath, textProfile);
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

function sortBySupportPath<T extends { supportPath: string }>(
  files: readonly T[],
): T[] {
  return [...files].sort((left, right) => comparePaths(left.supportPath, right.supportPath));
}

async function writeGeneratedSupportFile(
  outputDir: string,
  supportPath: string,
  document: EquDocument,
): Promise<string> {
  const outputPath = resolve(outputDir, supportPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, stringifyEquDocument(document), "utf8");
  return outputPath;
}

async function writeManifest(
  outputDir: string,
  result: GenerateChoroPartsetSkillUpModResult,
): Promise<void> {
  await writeFile(
    resolve(outputDir, "manifest.json"),
    JSON.stringify(
      {
        archivePath: result.archivePath,
        outputDir: result.outputDir,
        textProfile: result.textProfile,
        files: result.files,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function generateChoroPartsetSkillUpMod(
  options: GenerateChoroPartsetSkillUpModOptions = {},
): Promise<GenerateChoroPartsetSkillUpModResult> {
  const archivePath = resolve(options.archivePath ?? DEFAULT_ARCHIVE_PATH);
  const outputDir = resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const textProfile = options.textProfile ?? DEFAULT_TEXT_PROFILE;
  const cleanOutput = options.cleanOutput ?? true;

  if (cleanOutput) {
    await rm(outputDir, { recursive: true, force: true });
  }

  await mkdir(outputDir, { recursive: true });

  const archive = new PvfArchive("mods/2_3_choro_partset_skill_up", archivePath);

  try {
    await archive.ensureLoaded();

    const equipmentPathById = await loadEquipmentPathById(archive, textProfile);
    const partsetPathByIndex = await loadPartsetPathByIndex(archive, textProfile);
    const supportPathByClass = await loadSupportPathByClass(
      archive,
      equipmentPathById,
      textProfile,
    );
    const classPartsets = await loadClassPartsets(
      archive,
      textProfile,
      equipmentPathById,
      partsetPathByIndex,
    );

    const allPartsets = [
      ...new Set(Array.from(classPartsets.values()).flat()),
    ].sort(comparePaths);
    const blocksByPartset = await loadSkillEntryBlocksByPartset(
      archive,
      textProfile,
      allPartsets,
    );
    const files: GeneratedSupportFile[] = [];
    const skipped: SkippedSupportFile[] = [];

    for (const [className, supportPath] of [...supportPathByClass].sort((left, right) =>
      comparePaths(left[1], right[1]),
    )) {
      const sourcePartsets = classPartsets.get(className) ?? [];

      if (sourcePartsets.length === 0) {
        skipped.push({
          className,
          supportPath,
          reason: "No source partsets were listed in event_8382/event_8383.",
        });
        continue;
      }

      const mergedBlocks = dedupeSkillEntryBlocks(
        sourcePartsets.flatMap((partsetPath) => blocksByPartset.get(partsetPath) ?? []),
      );

      if (mergedBlocks.length === 0) {
        skipped.push({
          className,
          supportPath,
          reason: "Source partsets did not contain any 3/6/9 skill data up blocks.",
        });
        continue;
      }

      const supportDocument = await archive.readEquDocument(supportPath, textProfile);
      const nextDocument = replaceTopLevelSkillDataUp(
        supportDocument,
        mergeSkillDataUpBlocks(mergedBlocks),
      );

      await writeGeneratedSupportFile(outputDir, supportPath, nextDocument);
      files.push({
        className,
        supportPath,
        outputPath: supportPath,
        sourcePartsets,
        skillEntryCount: mergedBlocks.length,
      });
    }

    const result: GenerateChoroPartsetSkillUpModResult = {
      archivePath,
      outputDir,
      textProfile,
      files: sortBySupportPath(files),
      skipped: sortBySupportPath(skipped),
    };

    await writeManifest(outputDir, result);
    return result;
  } finally {
    await archive.close();
  }
}

export async function readGeneratedManifest(
  outputDir = DEFAULT_OUTPUT_DIR,
): Promise<GenerateChoroPartsetSkillUpModResult> {
  const content = await readFile(resolve(outputDir, "manifest.json"), "utf8");
  return JSON.parse(content) as GenerateChoroPartsetSkillUpModResult;
}

export {
  DEFAULT_ARCHIVE_PATH,
  DEFAULT_OUTPUT_DIR,
  STACKABLE_PATHS,
};
