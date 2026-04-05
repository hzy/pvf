import { resolve } from "node:path";

import {
  DEFAULT_ARCHIVE_PATH,
  DEFAULT_OUTPUT_DIR,
  generateChoroPartsetSkillUpMod,
} from "./index.ts";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

const archivePath = readFlag("--archive");
const outputDir = readFlag("--out");
const textProfile = readFlag("--text-profile");
const result = await generateChoroPartsetSkillUpMod({
  archivePath: archivePath ? resolve(archivePath) : DEFAULT_ARCHIVE_PATH,
  outputDir: outputDir ? resolve(outputDir) : DEFAULT_OUTPUT_DIR,
  textProfile: textProfile === "traditional" ? "traditional" : "simplified",
});

console.log(
  `Generated ${result.files.length} support files in ${result.outputDir}.`,
);
