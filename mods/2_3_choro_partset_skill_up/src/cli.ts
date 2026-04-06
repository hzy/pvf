import { resolve } from "node:path";

import {
  applyChoroPartsetSkillUpMod,
  DEFAULT_ARCHIVE_PATH,
  DEFAULT_OUTPUT_DIR,
  generateChoroPartsetSkillUpMod,
} from "./index.ts";

function readFlag(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const inlinePrefix = `${flag}=`;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (!current) {
      continue;
    }

    if (current === flag) {
      const next = args[index + 1];

      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }

      return next;
    }

    if (current.startsWith(inlinePrefix)) {
      const value = current.slice(inlinePrefix.length);

      if (value.length === 0) {
        throw new Error(`Missing value for ${flag}`);
      }

      return value;
    }
  }

  return undefined;
}

const archivePath = readFlag("--archive");
const outputDir = readFlag("--out");
const pvfOutputPath = readFlag("--pvf-out");
const textProfile = readFlag("--text-profile");
const resolvedArchivePath = archivePath ? resolve(archivePath) : DEFAULT_ARCHIVE_PATH;
const resolvedTextProfile = textProfile === "traditional" ? "traditional" : "simplified";

if (pvfOutputPath) {
  const result = await applyChoroPartsetSkillUpMod({
    archivePath: resolvedArchivePath,
    outputPath: resolve(pvfOutputPath),
    textProfile: resolvedTextProfile,
  });

  console.log(
    `Applied ${result.overlays.length} overlays (${result.files.length} support files) to ${result.outputPath}.`,
  );
} else {
  const result = await generateChoroPartsetSkillUpMod({
    archivePath: resolvedArchivePath,
    outputDir: outputDir ? resolve(outputDir) : DEFAULT_OUTPUT_DIR,
    textProfile: resolvedTextProfile,
  });

  console.log(
    `Generated ${result.overlays.length} overlays (${result.files.length} support files) in ${result.outputDir}.`,
  );
}
