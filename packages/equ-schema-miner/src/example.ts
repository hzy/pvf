import { parseEquDocument } from "@pvf/equ-ast";

import { getEquSectionSchema, inferEquSectionConstraint, mineEquSchema } from "./index.ts";

const sampleDocuments = [
  {
    sourceId: "sample-if-then.equ",
    document: parseEquDocument(`#PVF_File

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
[/then]
`),
  },
  {
    sourceId: "sample-multiple-then.equ",
    document: parseEquDocument(`#PVF_File

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
`),
  },
];

const schema = mineEquSchema(sampleDocuments);

for (const sectionName of ["if", "then", "multiple then", "stat by condition"]) {
  const section = getEquSectionSchema(schema, sectionName);

  if (!section) {
    continue;
  }

  console.log(JSON.stringify(inferEquSectionConstraint(section), null, 2));
}
