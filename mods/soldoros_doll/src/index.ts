import type { EquDocument, EquSectionNode, EquStatementNode } from "@pvf/equ-ast";
import {
  createSingleFloatLiteralSection,
  findNextAvailableListedPathId,
  getFirstSection,
  getFirstSectionString,
  isStatement,
  loadListedPathById,
  readEquDocument,
  removeTopLevelSection,
  replaceTopLevelSection,
  updateListedPathDocument,
} from "@pvf/pvf-mod";
import type { ListedPathEntry, PvfMod, PvfModSession, PvfRegisteredMod } from "@pvf/pvf-mod";

export const SOLDOROS_DOLL_MOD_ID = "soldoros_doll";
export const AI_CHARACTER_LIST_PATH = "aicharacter/aicharacter.lst";
export const SUPPORT_SUMMON_SOURCE_NAME = "\u5251\u5723\u7d22\u5fb7\u7f57\u65af";
export const SUPPORT_SUMMON_DOLL_NAME = "\u7d22\u5fb7\u7f57\u65af";
export const SUPPORT_SUMMON_ATTACK_DAMAGE_RATE = "1.0";
export const SUPPORT_SUMMON_SOURCE_HP_ITEM_ID = 1000;
export const SUPPORT_SUMMON_SOURCE_MP_ITEM_ID = 1002;
export const SUPPORT_SUMMON_DOLL_HP_ITEM_ID = 2600253;
export const SUPPORT_SUMMON_DOLL_MP_ITEM_ID = 2600254;

export interface SoldorosDollModSummary {
  sourceAicId: number;
  sourcePath: string;
  dollAicId: number;
  dollPath: string;
  created: boolean;
}

export function buildSupportSummonDollPath(archivePath: string): string {
  if (!archivePath.endsWith(".aic")) {
    throw new Error(`Expected .aic path, received ${archivePath}.`);
  }

  return archivePath.replace(/\.aic$/u, "_doll.aic");
}

function replaceMinimumInfoName(
  document: EquDocument,
  nextName: string,
): EquDocument {
  const minimumInfoSection = getFirstSection(document.children, "minimum info");

  if (!minimumInfoSection) {
    throw new Error("Missing [minimum info] section in summon APC source document.");
  }

  const statementIndex = minimumInfoSection.children.findIndex((child) => isStatement(child));
  const statement = minimumInfoSection.children[statementIndex];

  if (!statement || !isStatement(statement)) {
    throw new Error("Missing [minimum info] statement in summon APC source document.");
  }

  const nameTokenIndex = statement.tokens.findIndex(
    (token) => token.kind === "string" || token.kind === "link",
  );

  if (nameTokenIndex === -1) {
    throw new Error("Missing summon APC name token in [minimum info].");
  }

  const nextStatement: EquStatementNode = {
    ...statement,
    tokens: statement.tokens.map((token, index) =>
      index === nameTokenIndex && (token.kind === "string" || token.kind === "link")
        ? { ...token, value: nextName }
        : token
    ),
  };
  const nextMinimumInfoSection: EquSectionNode = {
    ...minimumInfoSection,
    children: minimumInfoSection.children.map((child, index) =>
      index === statementIndex ? nextStatement : child
    ),
  };

  return replaceTopLevelSection(document, nextMinimumInfoSection);
}

export function buildSupportSummonDollDocument(
  sourceDocument: EquDocument,
): EquDocument {
  const withName = replaceMinimumInfoName(sourceDocument, SUPPORT_SUMMON_DOLL_NAME);
  const withDamageRate = replaceTopLevelSection(
    withName,
    createSingleFloatLiteralSection(
      "attack damage rate",
      SUPPORT_SUMMON_ATTACK_DAMAGE_RATE,
    ),
  );
  const withoutArmorSubtype = removeTopLevelSection(withDamageRate, "armor subtype");
  const filteredEtcAction = filterEtcAction(withoutArmorSubtype);
  return replaceQuickItems(filteredEtcAction);
}

function filterEtcAction(document: EquDocument): EquDocument {
  const etcActionSection = getFirstSection(document.children, "etc action");

  if (!etcActionSection) {
    return document;
  }

  const filteredSection: EquSectionNode = {
    ...etcActionSection,
    children: etcActionSection.children.filter((child) => {
      if (!isStatement(child)) {
        return true;
      }

      return !child.tokens.some(
        (token) =>
          (token.kind === "string" || token.kind === "identifier")
          && token.value === "action/ex2.act",
      );
    }),
  };

  return replaceTopLevelSection(document, filteredSection);
}

function replaceQuickItems(document: EquDocument): EquDocument {
  const quickItemSection = getFirstSection(document.children, "quick item");

  if (!quickItemSection) {
    throw new Error("Missing [quick item] section in summon APC source document.");
  }

  const statementIndex = quickItemSection.children.findIndex((child) => isStatement(child));
  const statement = quickItemSection.children[statementIndex];

  if (!statement || !isStatement(statement)) {
    throw new Error("Missing [quick item] statement in summon APC source document.");
  }

  let intTokenIndex = -1;
  let replacedIds = 0;
  const nextStatement: EquStatementNode = {
    ...statement,
    tokens: statement.tokens.map((token) => {
      if (token.kind !== "int") {
        return token;
      }

      intTokenIndex += 1;

      if (intTokenIndex === 0) {
        if (token.value !== SUPPORT_SUMMON_SOURCE_HP_ITEM_ID) {
          throw new Error(
            `Expected first quick item id to be ${SUPPORT_SUMMON_SOURCE_HP_ITEM_ID}, received ${token.value}.`,
          );
        }

        replacedIds += 1;
        return {
          ...token,
          value: SUPPORT_SUMMON_DOLL_HP_ITEM_ID,
        };
      }

      if (intTokenIndex === 2) {
        if (token.value !== SUPPORT_SUMMON_SOURCE_MP_ITEM_ID) {
          throw new Error(
            `Expected second quick item id to be ${SUPPORT_SUMMON_SOURCE_MP_ITEM_ID}, received ${token.value}.`,
          );
        }

        replacedIds += 1;
        return {
          ...token,
          value: SUPPORT_SUMMON_DOLL_MP_ITEM_ID,
        };
      }

      return token;
    }),
  };

  if (replacedIds !== 2) {
    throw new Error("Expected to replace two quick item ids in summon APC source document.");
  }

  const nextQuickItemSection: EquSectionNode = {
    ...quickItemSection,
    children: quickItemSection.children.map((child, index) =>
      index === statementIndex ? nextStatement : child
    ),
  };

  return replaceTopLevelSection(document, nextQuickItemSection);
}

export async function tryFindAiCharacterByName(
  session: PvfModSession,
  targetName: string,
  options: {
    pathIncludes?: string;
  } = {},
): Promise<ListedPathEntry | undefined> {
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
    if (options.pathIncludes && !aicPath.includes(options.pathIncludes)) {
      continue;
    }

    const document = await readEquDocument(session, aicPath, session.textProfile);
    const minimumInfoName = getFirstSectionString(document.children, "minimum info")?.trim();

    if (minimumInfoName === targetName) {
      return {
        id: aicId,
        path: aicPath,
      };
    }
  }

  return undefined;
}

async function findAiCharacterByName(
  session: PvfModSession,
  targetName: string,
): Promise<ListedPathEntry> {
  const found = await tryFindAiCharacterByName(session, targetName);

  if (found) {
    return found;
  }

  throw new Error(`Unable to find APC id for ${targetName}.`);
}

export function createSoldorosDollMod(): PvfMod<SoldorosDollModSummary> {
  return {
    id: SOLDOROS_DOLL_MOD_ID,
    async apply(session: PvfModSession): Promise<SoldorosDollModSummary> {
      const sourceApc = await findAiCharacterByName(session, SUPPORT_SUMMON_SOURCE_NAME);
      const existingDoll = await tryFindAiCharacterByName(session, SUPPORT_SUMMON_DOLL_NAME, {
        pathIncludes: "_doll",
      });

      if (existingDoll) {
        const existingDollDocument = await session.readScriptDocument(existingDoll.path);

        session.writeScriptDocument(
          existingDoll.path,
          buildSupportSummonDollDocument(existingDollDocument),
        );

        return {
          sourceAicId: sourceApc.id,
          sourcePath: sourceApc.path,
          dollAicId: existingDoll.id,
          dollPath: existingDoll.path,
          created: false,
        };
      }

      const aiCharacterListPathById = await loadListedPathById(
        session,
        AI_CHARACTER_LIST_PATH,
        "aicharacter",
        session.textProfile,
      );
      const aiCharacterListDocument = await session.readScriptDocument(
        AI_CHARACTER_LIST_PATH,
      );
      const sourceApcDocument = await session.readScriptDocument(sourceApc.path);
      const dollAicId = findNextAvailableListedPathId(aiCharacterListPathById, sourceApc.id);
      const dollPath = buildSupportSummonDollPath(sourceApc.path);

      session.writeScriptDocument(
        dollPath,
        buildSupportSummonDollDocument(sourceApcDocument),
      );
      session.writeScriptDocument(
        AI_CHARACTER_LIST_PATH,
        updateListedPathDocument(
          aiCharacterListDocument,
          "aicharacter",
          [
            {
              id: dollAicId,
              path: dollPath,
            },
          ],
        ),
      );

      return {
        sourceAicId: sourceApc.id,
        sourcePath: sourceApc.path,
        dollAicId,
        dollPath,
        created: true,
      };
    },
  };
}

export const soldorosDollModDefinition: PvfRegisteredMod<
  undefined,
  SoldorosDollModSummary
> = {
  id: SOLDOROS_DOLL_MOD_ID,
  description: "Ensures a Soldoros doll APC entry exists before support equipment generation.",
  create() {
    return createSoldorosDollMod();
  },
};
