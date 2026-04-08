import { stringifyEquDocument, visitEqu } from "./equ.ts";
import { expectedStrings, fixturePath, samplePaths } from "./pvf.fixture.ts";
import { PvfArchive } from "./pvf.ts";

async function main(): Promise<void> {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();

  const document = await archive.readEquDocument(samplePaths.amulet, "simplified");

  visitEqu(document, {
    link(token, context) {
      if (context.currentSection?.name === "name") {
        token.value = expectedStrings.modifiedAmuletName;
      }
    },
    int(token, context) {
      if (context.currentSection?.name === "minimum level") {
        token.value = 80;
      }
    },
  });

  console.log(stringifyEquDocument(document));
  await archive.close();
}

if (import.meta.main) {
  await main();
}
