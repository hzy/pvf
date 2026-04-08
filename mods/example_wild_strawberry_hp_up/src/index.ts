import {
  createIntToken,
  type EquDocument,
  type EquNode,
  type EquSectionNode,
  type EquStatementNode,
} from "@pvf/equ-ast";

import {
  getFirstSection,
  getFirstSectionString,
  isSection,
  isStatement,
  type PvfMod,
  type PvfModSession,
  type PvfRegisteredMod,
} from "@pvf/pvf-mod";

export const EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID = "example_wild_strawberry_hp_up";
export const WILD_STRAWBERRY_PATH = "stackable/pharmaceutical/food_strawberry.stk";
export const WILD_STRAWBERRY_NAME = "野草莓";
export const ORIGINAL_WILD_STRAWBERRY_HP_RECOVERY = 60;
export const UPDATED_WILD_STRAWBERRY_HP_RECOVERY = 600;

export interface ExampleWildStrawberryHpUpSummary {
  path: string;
  previousRecovery: number;
  nextRecovery: number;
}

function replaceChildAt<T>(items: readonly T[], index: number, value: T): T[] {
  const nextItems = [...items];
  nextItems[index] = value;
  return nextItems;
}

function updateRecoveryStatement(statement: EquStatementNode): EquStatementNode {
  const firstToken = statement.tokens[0];

  if (firstToken?.kind !== "int") {
    throw new Error("Expected hp recovery statement to start with an int token.");
  }

  return {
    ...statement,
    tokens: [
      createIntToken(UPDATED_WILD_STRAWBERRY_HP_RECOVERY),
      ...statement.tokens.slice(1),
    ],
  };
}

function updateWildStrawberryDocument(
  document: EquDocument,
): {
  document: EquDocument;
  summary: ExampleWildStrawberryHpUpSummary;
} {
  const name = getFirstSectionString(document.children, "name");

  if (name !== WILD_STRAWBERRY_NAME) {
    throw new Error(
      `Expected ${WILD_STRAWBERRY_PATH} to be ${WILD_STRAWBERRY_NAME}, got ${name ?? "unknown"}.`,
    );
  }

  const hpRecoverySection = getFirstSection(document.children, "hp recovery");

  if (!hpRecoverySection) {
    throw new Error(`Missing hp recovery section in ${WILD_STRAWBERRY_PATH}.`);
  }

  const recoveryStatementIndex = hpRecoverySection.children.findIndex((child) =>
    isStatement(child) && child.tokens[0]?.kind === "int"
  );

  if (recoveryStatementIndex === -1) {
    throw new Error(`Missing numeric hp recovery statement in ${WILD_STRAWBERRY_PATH}.`);
  }

  const recoveryStatement = hpRecoverySection.children[recoveryStatementIndex];

  if (!recoveryStatement || !isStatement(recoveryStatement)) {
    throw new Error(`Invalid hp recovery statement in ${WILD_STRAWBERRY_PATH}.`);
  }

  const previousRecovery = recoveryStatement.tokens[0]?.kind === "int"
    ? recoveryStatement.tokens[0].value
    : undefined;

  if (previousRecovery !== ORIGINAL_WILD_STRAWBERRY_HP_RECOVERY) {
    throw new Error(
      `Expected ${WILD_STRAWBERRY_PATH} hp recovery to be ${ORIGINAL_WILD_STRAWBERRY_HP_RECOVERY}, got ${
        previousRecovery ?? "unknown"
      }.`,
    );
  }

  const nextSection: EquSectionNode = {
    ...hpRecoverySection,
    children: replaceChildAt(
      hpRecoverySection.children,
      recoveryStatementIndex,
      updateRecoveryStatement(recoveryStatement),
    ),
  };
  const nextChildren: EquNode[] = document.children.map((child) =>
    isSection(child) && child.name === "hp recovery" ? nextSection : child
  );

  return {
    document: {
      ...document,
      children: nextChildren,
    },
    summary: {
      path: WILD_STRAWBERRY_PATH,
      previousRecovery,
      nextRecovery: UPDATED_WILD_STRAWBERRY_HP_RECOVERY,
    },
  };
}

export function createExampleWildStrawberryHpUpMod(): PvfMod<ExampleWildStrawberryHpUpSummary> {
  return {
    id: EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID,
    async apply(session: PvfModSession): Promise<ExampleWildStrawberryHpUpSummary> {
      const currentDocument = await session.readScriptDocument(WILD_STRAWBERRY_PATH);
      const { document, summary } = updateWildStrawberryDocument(currentDocument);
      session.writeScriptDocument(WILD_STRAWBERRY_PATH, document);
      return summary;
    },
  };
}

export const exampleWildStrawberryHpUpModDefinition: PvfRegisteredMod<
  undefined,
  ExampleWildStrawberryHpUpSummary
> = {
  id: EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID,
  description: "Changes Wild Strawberry healing from 60 HP to 600 HP.",
  create() {
    return createExampleWildStrawberryHpUpMod();
  },
};
