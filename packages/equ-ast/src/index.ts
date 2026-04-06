export const EQU_HEADER = "#PVF_File" as const;

export interface EquDocument {
  kind: "document";
  header: typeof EQU_HEADER;
  children: EquNode[];
}

export interface EquSectionNode {
  kind: "section";
  name: string;
  closable: boolean;
  children: EquNode[];
}

export interface EquStatementNode {
  kind: "statement";
  tokens: EquToken[];
}

export interface EquIntToken {
  kind: "int";
  value: number;
}

export interface EquFloatToken {
  kind: "float";
  value: number;
}

export interface EquStringToken {
  kind: "string";
  value: string;
}

export interface EquLinkToken {
  kind: "link";
  index: number;
  key: string;
  value: string;
}

export interface EquCommandToken {
  kind: "command";
  opcode: number;
  value: string;
}

export interface EquIdentifierToken {
  kind: "identifier";
  value: string;
}

export type EquToken =
  | EquIntToken
  | EquFloatToken
  | EquStringToken
  | EquLinkToken
  | EquCommandToken
  | EquIdentifierToken;

export type EquNode = EquSectionNode | EquStatementNode;

export interface EquVisitContext {
  document: EquDocument;
  parentSections: readonly EquSectionNode[];
  currentSection: EquSectionNode | null;
}

export interface EquVisitor {
  document?(document: EquDocument): void;
  enterSection?(section: EquSectionNode, context: EquVisitContext): void;
  exitSection?(section: EquSectionNode, context: EquVisitContext): void;
  statement?(statement: EquStatementNode, context: EquVisitContext): void;
  token?(token: EquToken, context: EquVisitContext): void;
  int?(token: EquIntToken, context: EquVisitContext): void;
  float?(token: EquFloatToken, context: EquVisitContext): void;
  string?(token: EquStringToken, context: EquVisitContext): void;
  link?(token: EquLinkToken, context: EquVisitContext): void;
  command?(token: EquCommandToken, context: EquVisitContext): void;
  identifier?(token: EquIdentifierToken, context: EquVisitContext): void;
}

export interface RenderedEquReader<TProfile = string> {
  readRenderedFile(path: string, textProfile?: TProfile): Promise<string>;
}

interface SectionMarker {
  name: string;
  closing: boolean;
}

interface ParseState {
  closableNames: ReadonlySet<string>;
  lines: string[];
  index: number;
}

export function createSection(
  name: string,
  children: EquNode[] = [],
  closable = false,
): EquSectionNode {
  return {
    kind: "section",
    name,
    closable,
    children,
  };
}

export function createStatement(tokens: EquToken[] = []): EquStatementNode {
  return {
    kind: "statement",
    tokens,
  };
}

export function createIntToken(value: number): EquIntToken {
  return {
    kind: "int",
    value,
  };
}

export function createFloatToken(value: number): EquFloatToken {
  return {
    kind: "float",
    value,
  };
}

export function createStringToken(value: string): EquStringToken {
  return {
    kind: "string",
    value,
  };
}

export function createLinkToken(
  index: number,
  key: string,
  value: string,
): EquLinkToken {
  return {
    kind: "link",
    index,
    key,
    value,
  };
}

export function createCommandToken(
  opcode: number,
  value: string,
): EquCommandToken {
  return {
    kind: "command",
    opcode,
    value,
  };
}

export function createIdentifierToken(value: string): EquIdentifierToken {
  return {
    kind: "identifier",
    value,
  };
}

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

function parseSectionMarker(line: string): SectionMarker | null {
  const match = /^\[(\/)?([^\]]+)\]$/u.exec(line);

  if (!match) {
    return null;
  }

  return {
    closing: match[1] === "/",
    name: match[2] ?? "",
  };
}

function collectClosableNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const marker = parseSectionMarker(line);

    if (marker?.closing) {
      names.add(marker.name);
    }
  }

  return names;
}

function parseNumberToken(value: string): EquIntToken | EquFloatToken | null {
  if (/^[+-]?\d+$/u.test(value)) {
    return createIntToken(Number.parseInt(value, 10));
  }

  if (/^[+-]?\d+\.\d+$/u.test(value)) {
    return createFloatToken(Number.parseFloat(value));
  }

  return null;
}

function parseTokenValue(rawToken: string): EquToken {
  if (rawToken.startsWith("`") && rawToken.endsWith("`")) {
    return createStringToken(rawToken.slice(1, -1));
  }

  const linkMatch = /^<([+-]?\d+)::([^`]+)`([^`]*)`>$/u.exec(rawToken);

  if (linkMatch) {
    return createLinkToken(
      Number.parseInt(linkMatch[1] ?? "0", 10),
      linkMatch[2] ?? "",
      linkMatch[3] ?? "",
    );
  }

  const commandMatch = /^\{([+-]?\d+)=`([^`]*)`\}$/u.exec(rawToken);

  if (commandMatch) {
    return createCommandToken(
      Number.parseInt(commandMatch[1] ?? "0", 10),
      commandMatch[2] ?? "",
    );
  }

  return parseNumberToken(rawToken) ?? createIdentifierToken(rawToken);
}

function parseStatementLine(line: string): EquStatementNode {
  const tokens: EquToken[] = [];
  let index = 0;

  while (index < line.length) {
    if (line[index] === "\t") {
      index += 1;
      continue;
    }

    if (line[index] === "`") {
      const endIndex = line.indexOf("`", index + 1);

      if (endIndex === -1) {
        throw new Error(`Unterminated string token in line: ${line}`);
      }

      tokens.push(createStringToken(line.slice(index + 1, endIndex)));
      index = endIndex + 1;
      continue;
    }

    if (line[index] === "<") {
      const linkMatch = /^<([+-]?\d+)::([^`]+)`([^`]*)`>/u.exec(
        line.slice(index),
      );

      if (!linkMatch) {
        throw new Error(`Unterminated link token in line: ${line}`);
      }

      const rawToken = linkMatch[0];
      tokens.push(parseTokenValue(rawToken));
      index += rawToken.length;
      continue;
    }

    if (line[index] === "{") {
      const endIndex = line.indexOf("}", index + 1);

      if (endIndex === -1) {
        throw new Error(`Unterminated command token in line: ${line}`);
      }

      tokens.push(parseTokenValue(line.slice(index, endIndex + 1)));
      index = endIndex + 1;
      continue;
    }

    let nextIndex = index;

    while (nextIndex < line.length && line[nextIndex] !== "\t") {
      nextIndex += 1;
    }

    const rawToken = line.slice(index, nextIndex);

    if (rawToken.length > 0) {
      tokens.push(parseTokenValue(rawToken));
    }

    index = nextIndex;
  }

  return createStatement(tokens);
}

function isUnterminatedTokenError(error: unknown): boolean {
  return error instanceof Error && /^Unterminated /u.test(error.message);
}

function parseStatementWithContinuation(state: ParseState): EquStatementNode {
  let combined = state.lines[state.index] ?? "";
  let endIndex = state.index;

  while (true) {
    try {
      state.index = endIndex + 1;
      return parseStatementLine(combined);
    } catch (error) {
      if (!isUnterminatedTokenError(error) || endIndex + 1 >= state.lines.length) {
        throw error;
      }

      endIndex += 1;
      combined += `\n${state.lines[endIndex] ?? ""}`;
    }
  }
}

function parseNodes(
  state: ParseState,
  expectedClosingName: string | null,
): EquNode[] {
  const nodes: EquNode[] = [];

  while (state.index < state.lines.length) {
    const rawLine = state.lines[state.index] ?? "";
    const line = rawLine.trim();

    if (line.length === 0 || line === EQU_HEADER) {
      state.index += 1;
      continue;
    }

    const marker = parseSectionMarker(line);

    if (marker) {
      if (marker.closing) {
        if (expectedClosingName === null) {
          throw new Error(`Unexpected closing section [/${marker.name}].`);
        }

        if (marker.name !== expectedClosingName) {
          throw new Error(
            `Unexpected closing section [/${marker.name}] while parsing [${expectedClosingName}].`,
          );
        }

        state.index += 1;
        return nodes;
      }

      state.index += 1;

      if (state.closableNames.has(marker.name)) {
        nodes.push(createSection(marker.name, parseNodes(state, marker.name), true));
        continue;
      }

      const children: EquNode[] = [];

      while (state.index < state.lines.length) {
        const nextRawLine = state.lines[state.index] ?? "";
        const nextLine = nextRawLine.trim();

        if (nextLine.length === 0) {
          state.index += 1;
          continue;
        }

        if (nextLine === EQU_HEADER || parseSectionMarker(nextLine)) {
          break;
        }

        children.push(parseStatementWithContinuation(state));
      }

      nodes.push(createSection(marker.name, children, false));
      continue;
    }

    nodes.push(parseStatementWithContinuation(state));
  }

  if (expectedClosingName !== null) {
    throw new Error(`Missing closing section [/${expectedClosingName}].`);
  }

  return nodes;
}

export function parseEquDocument(input: string): EquDocument {
  const normalizedInput = normalizeLineEndings(input);
  const lines = normalizedInput.split("\n");
  const firstContentLine = lines.find((line) => line.trim().length > 0)?.trim();

  if (firstContentLine !== EQU_HEADER) {
    throw new Error(`Expected ${EQU_HEADER} header.`);
  }

  const state: ParseState = {
    closableNames: collectClosableNames(lines),
    lines,
    index: 0,
  };

  return {
    kind: "document",
    header: EQU_HEADER,
    children: parseNodes(state, null),
  };
}

function stringifyToken(token: EquToken): string {
  switch (token.kind) {
    case "int":
    case "float":
      return String(token.value);
    case "string":
      return `\`${token.value}\``;
    case "link":
      return `<${token.index}::${token.key}\`${token.value}\`>`;
    case "command":
      return `{${token.opcode}=\`${token.value}\`}`;
    case "identifier":
      return token.value;
  }
}

function stringifyNodeLines(node: EquNode): string[] {
  if (node.kind === "statement") {
    return [node.tokens.map((token) => stringifyToken(token)).join("\t")];
  }

  const lines = [`[${node.name}]`];

  for (const child of node.children) {
    lines.push(...stringifyNodeLines(child));
  }

  if (node.closable) {
    lines.push(`[/${node.name}]`);
  }

  return lines;
}

export function stringifyEquDocument(document: EquDocument): string {
  const lines = [document.header, ""];

  document.children.forEach((child, index) => {
    lines.push(...stringifyNodeLines(child));

    if (index < document.children.length - 1) {
      lines.push("");
    }
  });

  return `${lines.join("\r\n")}\r\n`;
}

function createVisitContext(
  document: EquDocument,
  parentSections: readonly EquSectionNode[],
): EquVisitContext {
  return {
    document,
    parentSections,
    currentSection: parentSections.at(-1) ?? null,
  };
}

function visitNode(
  node: EquNode,
  document: EquDocument,
  parentSections: readonly EquSectionNode[],
  visitor: EquVisitor,
): void {
  const context = createVisitContext(document, parentSections);

  if (node.kind === "section") {
    visitor.enterSection?.(node, context);

    const nextParentSections = [...parentSections, node];

    for (const child of node.children) {
      visitNode(child, document, nextParentSections, visitor);
    }

    visitor.exitSection?.(node, context);
    return;
  }

  visitor.statement?.(node, context);

  for (const token of node.tokens) {
    visitor.token?.(token, context);

    switch (token.kind) {
      case "int":
        visitor.int?.(token, context);
        break;
      case "float":
        visitor.float?.(token, context);
        break;
      case "string":
        visitor.string?.(token, context);
        break;
      case "link":
        visitor.link?.(token, context);
        break;
      case "command":
        visitor.command?.(token, context);
        break;
      case "identifier":
        visitor.identifier?.(token, context);
        break;
    }
  }
}

export function visitEqu(document: EquDocument, visitor: EquVisitor): void {
  visitor.document?.(document);

  for (const child of document.children) {
    visitNode(child, document, [], visitor);
  }
}

export async function parseEquFromReader<TProfile = string>(
  reader: RenderedEquReader<TProfile>,
  path: string,
  textProfile?: TProfile,
): Promise<EquDocument> {
  return parseEquDocument(await reader.readRenderedFile(path, textProfile));
}
