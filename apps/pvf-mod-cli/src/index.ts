import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, Option } from "commander";

import type { TextProfile } from "@pvf/pvf-core";
import {
  applyPvfPipeline,
  buildPvfPipelineToDirectory,
  createPvfPipelineManifest,
  resolvePathWithinDirectory,
  writePvfPipelineManifest,
} from "@pvf/pvf-mod";
import type { PvfPipelineConfig } from "@pvf/pvf-mod";

import {
  defaultPipelineId,
  pipelineDefinitions,
  pipelineDefinitionsById,
} from "../../../mods/pipelines.ts";
import { modDefinitions, modRegistry } from "../../../mods/registry.ts";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = resolve(APP_ROOT, "../..");
const DEFAULT_OUTPUT_BASE_DIR = resolve(REPO_ROOT, "out");
const TEXT_PROFILE_CHOICES = ["simplified", "traditional"] as const;

export const DEFAULT_ARCHIVE_PATH = resolve(REPO_ROOT, "fixtures/Script.pvf");

type CliTextProfile = (typeof TEXT_PROFILE_CHOICES)[number];

interface SharedCliOptions {
  archive?: string;
  textProfile?: CliTextProfile;
  pipeline?: string;
  mod: string[];
}

interface BuildCliOptions extends SharedCliOptions {
  out?: string;
  manifestOut?: string;
}

interface ApplyCliOptions extends SharedCliOptions {
  manifestOut?: string;
  pvfOut?: string;
}

interface CliOutput {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

function collectRepeatedOption(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

function configureSharedPipelineOptions<TCommand extends Command>(command: TCommand): TCommand {
  return command
    .option("--archive <path>", "PVF archive to read", DEFAULT_ARCHIVE_PATH)
    .addOption(
      new Option("--text-profile <profile>", "Rendered text profile")
        .choices([...TEXT_PROFILE_CHOICES])
        .default("simplified"),
    )
    .option("--pipeline <id>", "Registered pipeline id or ad-hoc pipeline id")
    .option(
      "--mod <id>",
      "Append a mod to an ad-hoc pipeline in execution order",
      collectRepeatedOption,
      [] as string[],
    );
}

function resolveTextProfile(value: CliTextProfile | undefined): TextProfile {
  return value === "traditional" ? "traditional" : "simplified";
}

function resolvePipeline(options: SharedCliOptions): PvfPipelineConfig {
  if (options.mod.length > 0) {
    return {
      id: options.pipeline ?? "adhoc",
      description: "Ad-hoc pipeline assembled from explicit --mod flags.",
      mods: options.mod.map((id) => ({ id })),
    };
  }

  const pipelineId = options.pipeline ?? defaultPipelineId;
  const resolvedPipeline = pipelineDefinitionsById.get(pipelineId);

  if (!resolvedPipeline) {
    throw new Error(`Unknown pipeline "${pipelineId}".`);
  }

  return resolvedPipeline;
}

function resolveDefaultPipelineOutputPath(
  pipelineId: string,
  pathValue: string,
  explicitFlag: "--out" | "--pvf-out",
): string {
  try {
    return resolvePathWithinDirectory(
      DEFAULT_OUTPUT_BASE_DIR,
      pathValue,
      `Default output for pipeline "${pipelineId}"`,
    );
  } catch (error) {
    throw new Error(
      `Pipeline id "${pipelineId}" cannot be used for the default output path under ${DEFAULT_OUTPUT_BASE_DIR}; pass ${explicitFlag} explicitly.`,
      { cause: error },
    );
  }
}

function renderListOutput(): string {
  const lines = ["Pipelines:"];

  for (const pipeline of pipelineDefinitions) {
    lines.push(`- ${pipeline.id}: ${pipeline.description ?? "No description."}`);
    lines.push(`  mods: ${pipeline.mods.map((mod) => mod.id).join(" -> ")}`);
  }

  lines.push("");
  lines.push("Mods:");

  for (const mod of modDefinitions) {
    lines.push(`- ${mod.id}: ${mod.description ?? "No description."}`);
  }

  return lines.join("\n");
}

function createProgram(output: CliOutput): Command {
  const program = new Command()
    .name("pvf-mod-cli")
    .description("List, build, and apply ordered PVF mod pipelines.")
    .exitOverride()
    .configureOutput({
      outputError: (text, write) => write(text),
      writeErr: (text) => output.writeStderr(text),
      writeOut: (text) => output.writeStdout(text),
    });

  program
    .command("list")
    .description("List registered pipelines and mods.")
    .action(() => {
      output.writeStdout(renderListOutput());
    });

  configureSharedPipelineOptions(
    program
      .command("build")
      .description("Build overlays and a manifest for a pipeline."),
  )
    .option("--out <dir>", "Output overlay directory")
    .option("--manifest-out <path>", "Manifest output path")
    .action(async (options: BuildCliOptions) => {
      const pipeline = resolvePipeline(options);
      const archivePath = resolve(options.archive ?? DEFAULT_ARCHIVE_PATH);
      const textProfile = resolveTextProfile(options.textProfile);
      const outputDir = options.out
        ? resolve(options.out)
        : resolveDefaultPipelineOutputPath(pipeline.id, pipeline.id, "--out");
      const manifestOutputPath = resolve(
        options.manifestOut ?? `${outputDir}/manifest.json`,
      );
      const { result } = await buildPvfPipelineToDirectory({
        archivePath,
        outputDir,
        manifestOutputPath,
        textProfile,
        registry: modRegistry,
        pipeline,
      });

      output.writeStdout([
        `Built pipeline ${pipeline.id}.`,
        `Archive: ${archivePath}`,
        `Overlay dir: ${outputDir}`,
        `Manifest: ${manifestOutputPath}`,
        `Mods: ${result.mods.map((mod) => mod.id).join(" -> ")}`,
        `Overlays: ${result.overlays.length}`,
      ].join("\n"));
    });

  configureSharedPipelineOptions(
    program
      .command("apply")
      .description("Apply a pipeline and write a PVF plus manifest."),
  )
    .option("--pvf-out <path>", "Output PVF path")
    .option("--manifest-out <path>", "Manifest output path")
    .action(async (options: ApplyCliOptions) => {
      const pipeline = resolvePipeline(options);
      const archivePath = resolve(options.archive ?? DEFAULT_ARCHIVE_PATH);
      const textProfile = resolveTextProfile(options.textProfile);
      const outputPath = options.pvfOut
        ? resolve(options.pvfOut)
        : resolveDefaultPipelineOutputPath(pipeline.id, `${pipeline.id}.pvf`, "--pvf-out");
      const manifestOutputPath = resolve(
        options.manifestOut ?? `${outputPath}.manifest.json`,
      );
      const result = await applyPvfPipeline({
        archivePath,
        outputPath,
        textProfile,
        registry: modRegistry,
        pipeline,
      });
      await writePvfPipelineManifest(
        manifestOutputPath,
        createPvfPipelineManifest(result),
      );

      output.writeStdout([
        `Applied pipeline ${pipeline.id}.`,
        `Archive: ${archivePath}`,
        `Output PVF: ${outputPath}`,
        `Manifest: ${manifestOutputPath}`,
        `Mods: ${result.mods.map((mod) => mod.id).join(" -> ")}`,
        `Updated: ${result.updatedPaths.length}`,
        `Added: ${result.addedPaths.length}`,
        `Deleted: ${result.deletedPaths.length}`,
      ].join("\n"));
    });

  return program;
}

export async function runCli(args: readonly string[]): Promise<string> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    await createProgram({
      writeStdout(text) {
        stdout.push(text);
      },
      writeStderr(text) {
        stderr.push(text);
      },
    }).parseAsync(args.length === 0 ? ["list"] : [...args], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") {
        return stdout.join("").trimEnd();
      }

      throw new Error(stderr.join("").trim() || error.message, { cause: error });
    }

    throw error;
  }

  return stdout.join("").trimEnd();
}
