import { createIntToken, createStatement, createStringToken } from "@pvf/equ-ast";
import type { EquDocument, EquStatementNode, RenderedEquReader } from "@pvf/equ-ast";
import type { TextProfile } from "@pvf/pvf-core";

import { isStatement } from "./equ.ts";

export interface ListedPathEntry {
  id: number;
  path: string;
}

export async function loadListedPathById(
  reader: RenderedEquReader<TextProfile>,
  listPath: string,
  rootPath: string,
  textProfile: TextProfile,
): Promise<Map<number, string>> {
  const content = await reader.readRenderedFile(listPath, textProfile);
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

export function findNextAvailableListedPathId(
  pathById: ReadonlyMap<number, string>,
  startId: number,
): number {
  let nextId = startId + 1;

  while (pathById.has(nextId)) {
    nextId += 1;
  }

  return nextId;
}

export function toListedPathRelativePath(
  archivePath: string,
  rootPath: string,
): string {
  const prefix = `${rootPath}/`;

  if (!archivePath.startsWith(prefix)) {
    throw new Error(`Expected ${rootPath} path, received ${archivePath}.`);
  }

  return archivePath.slice(prefix.length);
}

export function createListedPathStatement(
  id: number,
  archivePath: string,
  rootPath: string,
): EquStatementNode {
  return createStatement([
    createIntToken(id),
    createStringToken(toListedPathRelativePath(archivePath, rootPath)),
  ]);
}

export function updateListedPathDocument(
  document: EquDocument,
  rootPath: string,
  files: readonly ListedPathEntry[],
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
      (entry) => !overridesById.has(entry.id) && !overridePaths.has(entry.relativePath),
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
      )
    ),
  };
}
