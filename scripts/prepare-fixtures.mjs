import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { once } from "node:events";
import { createGunzip } from "node:zlib";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "..");
const fixturesDir = path.resolve(
  workspaceRoot,
  process.env["PVF_FIXTURES_DIR"] ?? "fixtures",
);
const archiveUrl =
  process.env["PVF_ARCHIVE_URL"] ??
  "https://github.com/llnut/dnf/raw/refs/heads/main/build/dnf_data/home/template/init/Script.tgz";
const pvfPath = path.resolve(
  fixturesDir,
  process.env["PVF_OUTPUT_NAME"] ?? "Script.pvf",
);
const targetBaseName = path.basename(pvfPath);

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) {
      return false;
    }
  }

  return true;
}

function parseTarString(block) {
  return block.toString("utf8").replace(/\0.*$/u, "");
}

function parseTarSize(block) {
  const octalText = block.toString("ascii").replace(/\0.*$/u, "").trim();
  return octalText.length === 0 ? 0 : Number.parseInt(octalText, 8);
}

function isRegularTarEntry(typeFlag) {
  return typeFlag === 0 || typeFlag === "0".charCodeAt(0);
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeChunk(stream, chunk) {
  if (chunk.length === 0) {
    return;
  }

  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function downloadAndExtractArchive() {
  console.log(`Downloading and extracting ${archiveUrl}`);
  const response = await fetch(archiveUrl);

  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status}.`);
  }

  const gunzip = createGunzip();
  const source = Readable.fromWeb(response.body);
  source.pipe(gunzip);

  let tarBuffer = Buffer.alloc(0);
  let archiveDone = false;
  let targetFound = false;
  let output;
  let remainingEntryBytes = 0;
  let remainingPaddingBytes = 0;
  let writingTargetEntry = false;

  try {
    for await (const rawChunk of gunzip) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      tarBuffer =
        tarBuffer.length === 0 ? chunk : Buffer.concat([tarBuffer, chunk]);

      while (tarBuffer.length > 0) {
        if (remainingEntryBytes > 0) {
          const chunkLength = Math.min(remainingEntryBytes, tarBuffer.length);
          const contentChunk = tarBuffer.subarray(0, chunkLength);

          if (writingTargetEntry && output) {
            await writeChunk(output, contentChunk);
          }

          tarBuffer = tarBuffer.subarray(chunkLength);
          remainingEntryBytes -= chunkLength;
          continue;
        }

        if (remainingPaddingBytes > 0) {
          const paddingLength = Math.min(
            remainingPaddingBytes,
            tarBuffer.length,
          );
          tarBuffer = tarBuffer.subarray(paddingLength);
          remainingPaddingBytes -= paddingLength;

          if (remainingPaddingBytes === 0 && writingTargetEntry && output) {
            output.end();
            await finished(output);
            output = undefined;
            writingTargetEntry = false;
          }

          continue;
        }

        if (tarBuffer.length < 512) {
          break;
        }

        const header = tarBuffer.subarray(0, 512);
        tarBuffer = tarBuffer.subarray(512);

        if (isZeroBlock(header)) {
          archiveDone = true;
          break;
        }

        const name = parseTarString(header.subarray(0, 100));
        const prefix = parseTarString(header.subarray(345, 500));
        const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
        const entrySize = parseTarSize(header.subarray(124, 136));
        const typeFlag = header[156] ?? 0;

        writingTargetEntry = false;
        remainingEntryBytes = entrySize;
        remainingPaddingBytes = (512 - (entrySize % 512)) % 512;

        if (
          !isRegularTarEntry(typeFlag) ||
          path.posix.basename(fullName) !== targetBaseName
        ) {
          continue;
        }

        if (targetFound) {
          throw new Error(
            `Archive contains multiple entries named ${targetBaseName}.`,
          );
        }

        targetFound = true;
        output = createWriteStream(pvfPath, { flags: "w" });
        writingTargetEntry = true;

        if (entrySize === 0) {
          output.end();
          await finished(output);
          output = undefined;
          writingTargetEntry = false;
        }
      }

      if (archiveDone) {
        break;
      }
    }

    if (output) {
      output.end();
      await finished(output);
      output = undefined;
    }
  } catch (error) {
    if (output) {
      output.destroy();
    }

    await rm(pvfPath, { force: true });
    throw error;
  }

  if (!targetFound) {
    await rm(pvfPath, { force: true });
    throw new Error(`Archive did not contain ${targetBaseName}.`);
  }

  if (!(await pathExists(pvfPath))) {
    throw new Error(`Extraction completed but ${pvfPath} was not found.`);
  }
}

async function main() {
  await mkdir(fixturesDir, { recursive: true });

  if (await pathExists(pvfPath)) {
    console.log(`Fixture already present at ${pvfPath}, skipping download.`);
    return;
  }

  await downloadAndExtractArchive();
  console.log(`Fixture prepared at ${pvfPath}`);
}

await main();
