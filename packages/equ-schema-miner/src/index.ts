import type { EquDocument, EquSectionNode, EquStatementNode } from "@pvf/equ-ast";
import { visitEqu } from "@pvf/equ-ast";

export const EQU_ROOT_SECTION = "<root>" as const;

export interface EquSchemaBucket<T> {
  value: T;
  count: number;
  examples: string[];
}

export interface EquSectionChildShapeStats {
  empty: number;
  mixed: number;
  onlySections: number;
  onlyStatements: number;
}

export interface EquSectionClosureStats {
  closable: number;
  nonClosable: number;
}

export interface EquSectionSchema {
  name: string;
  occurrences: number;
  closure: EquSectionClosureStats;
  directChildShapes: EquSectionChildShapeStats;
  childSections: EquSchemaBucket<string>[];
  childSectionSequences: EquSchemaBucket<readonly string[]>[];
  parentSections: EquSchemaBucket<string>[];
  statementShapes: EquSchemaBucket<string>[];
}

export interface EquSchema {
  documents: number;
  sections: Record<string, EquSectionSchema>;
  statements: number;
}

export interface EquDocumentInput {
  document: EquDocument;
  sourceId?: string;
}

export interface EquSchemaMinerOptions {
  maxExamplesPerBucket?: number;
}

export interface EquSchemaMiner {
  addDocument(document: EquDocument, sourceId?: string): void;
  finalize(): EquSchema;
}

export type EquSectionClosureMode =
  | "always-closable"
  | "mixed"
  | "never-closable";

export type EquSectionContentMode =
  | "empty"
  | "mixed"
  | "only-sections"
  | "only-statements"
  | "varied";

export interface EquInferredSectionConstraint {
  name: string;
  occurrences: number;
  closureMode: EquSectionClosureMode;
  contentMode: EquSectionContentMode;
  allowedChildSections: string[];
  statementShapes: string[];
}

interface BucketAccumulator<T> {
  count: number;
  examples: string[];
  value: T;
}

interface SectionAccumulator {
  occurrences: number;
  closure: EquSectionClosureStats;
  directChildShapes: EquSectionChildShapeStats;
  childSections: Map<string, BucketAccumulator<string>>;
  childSectionSequences: Map<string, BucketAccumulator<readonly string[]>>;
  parentSections: Map<string, BucketAccumulator<string>>;
  statementShapes: Map<string, BucketAccumulator<string>>;
}

interface EquSchemaAccumulator {
  documents: number;
  maxExamplesPerBucket: number;
  sections: Map<string, SectionAccumulator>;
  statements: number;
}

function createSectionAccumulator(): SectionAccumulator {
  return {
    occurrences: 0,
    closure: {
      closable: 0,
      nonClosable: 0,
    },
    directChildShapes: {
      empty: 0,
      mixed: 0,
      onlySections: 0,
      onlyStatements: 0,
    },
    childSections: new Map(),
    childSectionSequences: new Map(),
    parentSections: new Map(),
    statementShapes: new Map(),
  };
}

function createAccumulator(options: EquSchemaMinerOptions): EquSchemaAccumulator {
  return {
    documents: 0,
    maxExamplesPerBucket: options.maxExamplesPerBucket ?? 3,
    sections: new Map(),
    statements: 0,
  };
}

function getOrCreateSection(
  accumulator: EquSchemaAccumulator,
  name: string,
): SectionAccumulator {
  let section = accumulator.sections.get(name);

  if (!section) {
    section = createSectionAccumulator();
    accumulator.sections.set(name, section);
  }

  return section;
}

function addExample(examples: string[], sourceId: string | undefined, limit: number): void {
  if (!sourceId || examples.length >= limit || examples.includes(sourceId)) {
    return;
  }

  examples.push(sourceId);
}

function observeBucket<T>(
  buckets: Map<string, BucketAccumulator<T>>,
  key: string,
  value: T,
  sourceId: string | undefined,
  maxExamplesPerBucket: number,
): void {
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = {
      count: 0,
      examples: [],
      value,
    };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  addExample(bucket.examples, sourceId, maxExamplesPerBucket);
}

function serializeSequence(value: readonly string[]): string {
  return JSON.stringify(value);
}

function getStatementShape(statement: EquStatementNode): string {
  return statement.tokens.map((token) => token.kind).join(" ");
}

function getSectionContentMode(section: EquSectionNode): keyof EquSectionChildShapeStats {
  if (section.children.length === 0) {
    return "empty";
  }

  let sawSection = false;
  let sawStatement = false;

  for (const child of section.children) {
    if (child.kind === "section") {
      sawSection = true;
    } else {
      sawStatement = true;
    }
  }

  if (sawSection && sawStatement) {
    return "mixed";
  }

  if (sawSection) {
    return "onlySections";
  }

  return "onlyStatements";
}

function finalizeBuckets<T>(
  buckets: Map<string, BucketAccumulator<T>>,
): EquSchemaBucket<T>[] {
  return [...buckets.values()]
    .map((bucket) => ({
      value: bucket.value,
      count: bucket.count,
      examples: [...bucket.examples],
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return JSON.stringify(left.value).localeCompare(JSON.stringify(right.value));
    });
}

function addDocumentToAccumulator(
  accumulator: EquSchemaAccumulator,
  document: EquDocument,
  sourceId: string | undefined,
): void {
  accumulator.documents += 1;

  visitEqu(document, {
    enterSection(section, context) {
      const sectionAccumulator = getOrCreateSection(accumulator, section.name);
      sectionAccumulator.occurrences += 1;

      if (section.closable) {
        sectionAccumulator.closure.closable += 1;
      } else {
        sectionAccumulator.closure.nonClosable += 1;
      }

      const contentMode = getSectionContentMode(section);
      sectionAccumulator.directChildShapes[contentMode] += 1;

      const parentName = context.parentSections.at(-1)?.name ?? EQU_ROOT_SECTION;
      observeBucket(
        sectionAccumulator.parentSections,
        parentName,
        parentName,
        sourceId,
        accumulator.maxExamplesPerBucket,
      );

      const childSectionNames = section.children
        .filter((child): child is EquSectionNode => child.kind === "section")
        .map((child) => child.name);

      for (const childName of childSectionNames) {
        observeBucket(
          sectionAccumulator.childSections,
          childName,
          childName,
          sourceId,
          accumulator.maxExamplesPerBucket,
        );
      }

      if (childSectionNames.length > 0) {
        observeBucket(
          sectionAccumulator.childSectionSequences,
          serializeSequence(childSectionNames),
          childSectionNames,
          sourceId,
          accumulator.maxExamplesPerBucket,
        );
      }
    },
    statement(statement, context) {
      accumulator.statements += 1;

      const section = context.currentSection;

      if (!section) {
        return;
      }

      const sectionAccumulator = getOrCreateSection(accumulator, section.name);
      const shape = getStatementShape(statement);
      observeBucket(
        sectionAccumulator.statementShapes,
        shape,
        shape,
        sourceId,
        accumulator.maxExamplesPerBucket,
      );
    },
  });
}

function finalizeSchema(accumulator: EquSchemaAccumulator): EquSchema {
  const sections = Object.fromEntries(
    [...accumulator.sections.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, section]) => [
        name,
        {
          name,
          occurrences: section.occurrences,
          closure: {
            closable: section.closure.closable,
            nonClosable: section.closure.nonClosable,
          },
          directChildShapes: {
            empty: section.directChildShapes.empty,
            mixed: section.directChildShapes.mixed,
            onlySections: section.directChildShapes.onlySections,
            onlyStatements: section.directChildShapes.onlyStatements,
          },
          childSections: finalizeBuckets(section.childSections),
          childSectionSequences: finalizeBuckets(section.childSectionSequences),
          parentSections: finalizeBuckets(section.parentSections),
          statementShapes: finalizeBuckets(section.statementShapes),
        } satisfies EquSectionSchema,
      ]),
  );

  return {
    documents: accumulator.documents,
    sections,
    statements: accumulator.statements,
  };
}

export function createEquSchemaMiner(
  options: EquSchemaMinerOptions = {},
): EquSchemaMiner {
  const accumulator = createAccumulator(options);

  return {
    addDocument(document, sourceId) {
      addDocumentToAccumulator(accumulator, document, sourceId);
    },
    finalize() {
      return finalizeSchema(accumulator);
    },
  };
}

export function mineEquSchema(
  inputs: Iterable<EquDocument | EquDocumentInput>,
  options: EquSchemaMinerOptions = {},
): EquSchema {
  const miner = createEquSchemaMiner(options);

  for (const input of inputs) {
    if ("document" in input) {
      miner.addDocument(input.document, input.sourceId);
    } else {
      miner.addDocument(input);
    }
  }

  return miner.finalize();
}

export function getEquSectionSchema(
  schema: EquSchema,
  name: string,
): EquSectionSchema | null {
  return schema.sections[name] ?? null;
}

function inferClosureMode(section: EquSectionSchema): EquSectionClosureMode {
  if (section.closure.closable > 0 && section.closure.nonClosable === 0) {
    return "always-closable";
  }

  if (section.closure.nonClosable > 0 && section.closure.closable === 0) {
    return "never-closable";
  }

  return "mixed";
}

function inferContentMode(section: EquSectionSchema): EquSectionContentMode {
  const isEmptyOnly =
    section.directChildShapes.empty > 0 &&
    section.directChildShapes.mixed === 0 &&
    section.directChildShapes.onlySections === 0 &&
    section.directChildShapes.onlyStatements === 0;
  const isMixedOnly =
    section.directChildShapes.empty === 0 &&
    section.directChildShapes.mixed > 0 &&
    section.directChildShapes.onlySections === 0 &&
    section.directChildShapes.onlyStatements === 0;
  const isOnlySections =
    section.directChildShapes.empty === 0 &&
    section.directChildShapes.mixed === 0 &&
    section.directChildShapes.onlySections > 0 &&
    section.directChildShapes.onlyStatements === 0;
  const isOnlyStatements =
    section.directChildShapes.empty === 0 &&
    section.directChildShapes.mixed === 0 &&
    section.directChildShapes.onlySections === 0 &&
    section.directChildShapes.onlyStatements > 0;

  if (isEmptyOnly) {
    return "empty";
  }

  if (isMixedOnly) {
    return "mixed";
  }

  if (isOnlySections) {
    return "only-sections";
  }

  if (isOnlyStatements) {
    return "only-statements";
  }

  return "varied";
}

export function inferEquSectionConstraint(
  section: EquSectionSchema,
): EquInferredSectionConstraint {
  return {
    name: section.name,
    occurrences: section.occurrences,
    closureMode: inferClosureMode(section),
    contentMode: inferContentMode(section),
    allowedChildSections: section.childSections
      .map((bucket) => bucket.value)
      .sort((left, right) => left.localeCompare(right)),
    statementShapes: section.statementShapes
      .map((bucket) => bucket.value)
      .sort((left, right) => left.localeCompare(right)),
  };
}
