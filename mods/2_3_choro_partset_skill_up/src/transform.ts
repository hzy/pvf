import {
  createCommandToken,
  createIntToken,
  createSection,
  createStatement,
  createStringToken,
  type EquDocument,
  type EquSectionNode,
} from "@pvf/equ-ast";

import {
  compareArchivePaths,
  createSingleFloatLiteralSection,
  createSingleIntSection,
  createSingleStringSection,
  isSection,
  replaceTopLevelSection,
} from "@pvf/pvf-mod";

import {
  EXPLAIN_HEADING,
  GENERATED_SUPPORT_NAME_PREFIX,
  SUPPORT_NAME_SEPARATOR,
  SUPPORT_SUMMON_ATTACK_DAMAGE_RATE,
  SUPPORT_SUMMON_COOLDOWN,
  SUPPORT_SUMMON_EXPLAIN,
} from "./constants.ts";
import type { GeneratedSupportFile, SkillEntryBlock, SkippedSupportFile } from "./types.ts";

export function dedupeSkillEntryBlocks(blocks: readonly SkillEntryBlock[]): SkillEntryBlock[] {
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

export function mergeSkillDataUpBlocks(
  blocks: readonly SkillEntryBlock[],
): EquSectionNode {
  return createSection(
    "skill data up",
    blocks.flatMap((block) => block.statements),
    true,
  );
}

export function replaceTopLevelSkillDataUp(
  document: EquDocument,
  skillDataUpSection: EquSectionNode,
): EquDocument {
  const nextChildren = document.children.filter(
    (node) => !isSection(node) || node.name !== "skill data up",
  );
  const insertIndex = nextChildren.findIndex(
    (node) =>
      isSection(node)
      && (node.name === "possible kiri protect" || node.name === "icon mark"),
  );
  const safeInsertIndex = insertIndex === -1 ? nextChildren.length : insertIndex;

  nextChildren.splice(safeInsertIndex, 0, skillDataUpSection);

  return {
    ...document,
    children: nextChildren,
  };
}

export function buildExplainText(
  sourcePartsets: readonly string[],
  partsetNameByPath: Map<string, string>,
): string {
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

export function replaceTopLevelExplain(
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

export function buildSupportSummonSections(apcId: number): EquSectionNode[] {
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
            createIntToken(99),
            createIntToken(1),
          ]),
        ]),
      ],
      true,
    ),
  ];
}

export function buildGeneratedSupportName(className: string): string {
  return `${GENERATED_SUPPORT_NAME_PREFIX}${SUPPORT_NAME_SEPARATOR}${className}`;
}

export function buildGeneratedSupportPath(equipmentId: number): string {
  return `equipment/character/common/support/support_${equipmentId}.equ`;
}

export function buildSupportSummonDollPath(archivePath: string): string {
  if (!archivePath.endsWith(".aic")) {
    throw new Error(`Expected .aic path, received ${archivePath}.`);
  }

  return archivePath.replace(/\.aic$/u, "_doll.aic");
}

export function buildSupportSummonOverlayDocument(
  sourceDocument: EquDocument,
): EquDocument {
  return replaceTopLevelSection(
    sourceDocument,
    createSingleFloatLiteralSection(
      "attack damage rate",
      SUPPORT_SUMMON_ATTACK_DAMAGE_RATE,
    ),
  );
}

export function sortBySupportPath<T extends { supportPath: string }>(
  files: readonly T[],
): T[] {
  return [...files].sort((left, right) => compareArchivePaths(left.supportPath, right.supportPath));
}

export function sortGeneratedSupportFiles(
  files: readonly GeneratedSupportFile[],
): GeneratedSupportFile[] {
  return sortBySupportPath(files);
}

export function sortSkippedSupportFiles(
  files: readonly SkippedSupportFile[],
): SkippedSupportFile[] {
  return sortBySupportPath(files);
}

export { createSingleIntSection, createSingleStringSection, replaceTopLevelSection };
