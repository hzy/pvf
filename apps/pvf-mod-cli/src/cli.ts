import { runCli } from "./index.ts";

try {
  const output = await runCli(process.argv.slice(2));

  if (output.length > 0) {
    process.stdout.write(`${output}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
