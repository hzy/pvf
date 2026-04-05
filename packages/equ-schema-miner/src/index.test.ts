import assert from "node:assert/strict";
import test from "node:test";

import { parseEquDocument } from "@pvf/equ-ast";

import {
  EQU_ROOT_SECTION,
  getEquSectionSchema,
  inferEquSectionConstraint,
  mineEquSchema,
} from "./index.ts";

const controlFlowSample = parseEquDocument(`#PVF_File

[if]
[cooltime]
15000
[/cooltime]
[attack success]
1
[/attack success]
[/if]

[then]
[target]
\`enemy\`
-1
[stat by condition]
\`physical attack\`
\`+\`
50
[stat by condition]
\`magical attack\`
\`+\`
50
[/then]

[multiple then]
[then]
[then probability]
50.000000
[target]
\`enemy\`
-1
[/then]
[then]
[then probability]
50.000000
[target]
\`party\`
-1
[/then]
[/multiple then]
`);

const additionalThenSample = parseEquDocument(`#PVF_File

[then]
[target]
\`myself\`
-1
[probability]
5
[/then]
`);

test("mines section closure, parentage, and child section observations", () => {
  const schema = mineEquSchema(
    [
      { document: controlFlowSample, sourceId: "control-flow.equ" },
      { document: additionalThenSample, sourceId: "then-only.equ" },
    ],
    { maxExamplesPerBucket: 2 },
  );

  assert.equal(schema.documents, 2);

  const ifSection = getEquSectionSchema(schema, "if");
  assert.ok(ifSection);
  assert.equal(ifSection.closure.closable, 1);
  assert.equal(ifSection.closure.nonClosable, 0);
  assert.equal(ifSection.directChildShapes.onlySections, 1);
  assert.deepEqual(
    ifSection.childSections.map((bucket) => bucket.value),
    ["attack success", "cooltime"],
  );
  assert.deepEqual(ifSection.parentSections, [
    {
      value: EQU_ROOT_SECTION,
      count: 1,
      examples: ["control-flow.equ"],
    },
  ]);
});

test("captures statement shapes for non-closable field sections", () => {
  const schema = mineEquSchema([{ document: controlFlowSample, sourceId: "control-flow.equ" }]);
  const statByCondition = getEquSectionSchema(schema, "stat by condition");

  assert.ok(statByCondition);
  assert.equal(statByCondition.closure.closable, 0);
  assert.equal(statByCondition.closure.nonClosable, 2);
  assert.equal(statByCondition.directChildShapes.onlyStatements, 2);
  assert.deepEqual(statByCondition.statementShapes, [
    {
      value: "string",
      count: 4,
      examples: ["control-flow.equ"],
    },
    {
      value: "int",
      count: 2,
      examples: ["control-flow.equ"],
    },
  ]);
});

test("infers high-level section constraints from mined observations", () => {
  const schema = mineEquSchema([
    { document: controlFlowSample, sourceId: "control-flow.equ" },
    { document: additionalThenSample, sourceId: "then-only.equ" },
  ]);

  const multipleThen = getEquSectionSchema(schema, "multiple then");
  assert.ok(multipleThen);

  const multipleThenConstraint = inferEquSectionConstraint(multipleThen);
  assert.equal(multipleThenConstraint.closureMode, "always-closable");
  assert.equal(multipleThenConstraint.contentMode, "only-sections");
  assert.deepEqual(multipleThenConstraint.allowedChildSections, ["then"]);

  const thenSection = getEquSectionSchema(schema, "then");
  assert.ok(thenSection);
  const thenConstraint = inferEquSectionConstraint(thenSection);
  assert.equal(thenConstraint.closureMode, "always-closable");
  assert.equal(thenConstraint.contentMode, "only-sections");
  assert.deepEqual(thenConstraint.allowedChildSections, [
    "probability",
    "stat by condition",
    "target",
    "then probability",
  ]);
});
