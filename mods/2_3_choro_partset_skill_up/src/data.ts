import type { EquDocument, EquStatementNode } from "@pvf/equ-ast";
import {
  compareArchivePaths,
  findNextAvailableListedPathId,
  getFirstSection,
  getFirstSectionInt,
  getFirstSectionString,
  getSections,
  getStatementInts,
  isStatement,
  loadListedPathById,
  readEquDocument,
} from "@pvf/pvf-mod";
import type { ListedPathEntry, PvfModSession } from "@pvf/pvf-mod";

import {
  AI_CHARACTER_LIST_PATH,
  EQUIPMENT_LIST_PATH,
  EQUIPMENT_PARTSET_PATH,
  STACKABLE_PATHS,
  SUPPORT_NAME_SEPARATOR,
  TARGET_PIECE_COUNTS,
} from "./constants.ts";
import type { SkillEntryBlock } from "./types.ts";

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

function extractEquipmentIds(section: import("@pvf/equ-ast").EquSectionNode | undefined): number[] {
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
      getStatementInts(
        categorySection.children.find(isStatement) ?? {
          kind: "statement",
          tokens: [],
        },
      )
    )
    .filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined);
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
        token.kind === "string" || token.kind === "link" ? [token.value] : []
      )
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

function createDocumentCache(
  session: PvfModSession,
): (path: string) => Promise<EquDocument> {
  const cache = new Map<string, Promise<EquDocument>>();

  return async (path: string): Promise<EquDocument> => {
    const existing = cache.get(path);

    if (existing) {
      return existing;
    }

    const created = readEquDocument(session, path, session.textProfile);
    cache.set(path, created);
    return created;
  };
}

export async function loadEquipmentPathById(
  session: PvfModSession,
): Promise<Map<number, string>> {
  return loadListedPathById(
    session,
    EQUIPMENT_LIST_PATH,
    "equipment",
    session.textProfile,
  );
}

export async function loadPartsetPathByIndex(
  session: PvfModSession,
): Promise<Map<number, string>> {
  const document = await readEquDocument(session, EQUIPMENT_PARTSET_PATH, session.textProfile);
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

export async function loadClassPartsets(
  session: PvfModSession,
  equipmentPathById: Map<number, string>,
  partsetPathByIndex: Map<number, string>,
): Promise<Map<string, string[]>> {
  const classEquipmentIds = new Map<string, Set<number>>();

  for (const stackablePath of STACKABLE_PATHS) {
    const document = await readEquDocument(session, stackablePath, session.textProfile);
    mergeClassEquipmentIds(classEquipmentIds, extractClassEquipmentIds(document));
  }

  const readDocument = createDocumentCache(session);
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

    classPartsets.set(className, [...partsetPaths].sort(compareArchivePaths));
  }

  return classPartsets;
}

function isJobMarkerStatement(statement: EquStatementNode): boolean {
  return (
    statement.tokens.length === 1
    && statement.tokens[0]?.kind === "string"
    && statement.tokens[0].value.startsWith("[")
    && statement.tokens[0].value.endsWith("]")
  );
}

function extractTrailingJobMarker(
  statement: EquStatementNode,
): EquStatementNode | undefined {
  const lastToken = statement.tokens.at(-1);

  if (
    statement.tokens.length < 2
    || lastToken?.kind !== "string"
    || !lastToken.value.startsWith("[")
    || !lastToken.value.endsWith("]")
  ) {
    return undefined;
  }

  return {
    kind: "statement",
    tokens: [lastToken],
  };
}

function stripTrailingJobMarker(statement: EquStatementNode): EquStatementNode {
  if (!extractTrailingJobMarker(statement)) {
    return statement;
  }

  return {
    kind: "statement",
    tokens: statement.tokens.slice(0, -1),
  };
}

function extractSkillEntryBlocks(
  section: import("@pvf/equ-ast").EquSectionNode,
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
      !firstStatement
      || !secondStatement
      || !thirdStatement
      || !fourthStatement
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

export async function loadSkillEntryBlocksByPartset(
  session: PvfModSession,
  partsetPaths: Iterable<string>,
): Promise<Map<string, SkillEntryBlock[]>> {
  const blocksByPartset = new Map<string, SkillEntryBlock[]>();

  for (const partsetPath of partsetPaths) {
    const document = await readEquDocument(session, partsetPath, session.textProfile);
    const blocks: SkillEntryBlock[] = [];

    for (const section of getSections(document.children, "piece set ability")) {
      const pieceCount = getStatementInts(
        section.children.find(isStatement) ?? {
          kind: "statement",
          tokens: [],
        },
      ).at(0);

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

export async function loadPartsetNameByPath(
  session: PvfModSession,
  partsetPaths: Iterable<string>,
): Promise<Map<string, string>> {
  const namesByPath = new Map<string, string>();

  for (const partsetPath of partsetPaths) {
    const document = await readEquDocument(session, partsetPath, session.textProfile);
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

export async function loadSupportPathsByClass(
  session: PvfModSession,
  equipmentPathById: Map<number, string>,
): Promise<Map<string, string[]>> {
  const supportPathsByClass = new Map<string, string[]>();

  for (const equipmentPath of equipmentPathById.values()) {
    if (!/support_3choro\d+\.equ$/iu.test(equipmentPath)) {
      continue;
    }

    const document = await readEquDocument(session, equipmentPath, session.textProfile);
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

export async function findAiCharacterByName(
  session: PvfModSession,
  targetName: string,
): Promise<ListedPathEntry> {
  const pathById = await loadListedPathById(
    session,
    AI_CHARACTER_LIST_PATH,
    "aicharacter",
    session.textProfile,
  );

  for (
    const [aicId, aicPath] of [...pathById.entries()].sort(
      (left, right) => left[0] - right[0],
    )
  ) {
    const document = await readEquDocument(session, aicPath, session.textProfile);
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

export { findNextAvailableListedPathId };
