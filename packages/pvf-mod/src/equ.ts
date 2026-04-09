import {
  createIdentifierToken,
  createIntToken,
  createSection,
  createStatement,
  createStringToken,
  parseEquDocument,
} from "@pvf/equ-ast";
import type {
  EquDocument,
  EquNode,
  EquSectionNode,
  EquStatementNode,
  RenderedEquReader,
} from "@pvf/equ-ast";
import type { TextProfile } from "@pvf/pvf-core";

export function isSection(node: EquNode): node is EquSectionNode {
  return node.kind === "section";
}

export function isStatement(node: EquNode): node is EquStatementNode {
  return node.kind === "statement";
}

export async function readEquDocument(
  reader: RenderedEquReader<TextProfile>,
  path: string,
  textProfile: TextProfile,
): Promise<EquDocument> {
  return parseEquDocument(await reader.readRenderedFile(path, textProfile));
}

export function getSections(nodes: readonly EquNode[], name: string): EquSectionNode[] {
  return nodes.filter(
    (node): node is EquSectionNode => isSection(node) && node.name === name,
  );
}

export function getFirstSection(
  nodes: readonly EquNode[],
  name: string,
): EquSectionNode | undefined {
  return getSections(nodes, name)[0];
}

export function getStatementInts(statement: EquStatementNode): number[] {
  return statement.tokens.flatMap((token) => token.kind === "int" ? [token.value] : []);
}

export function getFirstSectionInt(
  nodes: readonly EquNode[],
  name: string,
): number | undefined {
  const section = getFirstSection(nodes, name);
  const statement = section?.children.find(isStatement);
  return statement?.tokens.find((token) => token.kind === "int")?.value;
}

export function getFirstSectionString(
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

export function replaceTopLevelSection(
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

export function createSingleStringSection(name: string, value: string): EquSectionNode {
  return createSection(name, [createStatement([createStringToken(value)])]);
}

export function createSingleIntSection(name: string, value: number): EquSectionNode {
  return createSection(name, [createStatement([createIntToken(value)])]);
}

export function createSingleFloatLiteralSection(name: string, value: string): EquSectionNode {
  return createSection(name, [createStatement([createIdentifierToken(value)])]);
}
