import { performance } from "node:perf_hooks";

import { expectedStrings, fixturePath, samplePaths } from "./pvf.fixture.ts";
import { PvfArchive } from "./pvf.ts";

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  averageMs: number;
  minMs: number;
  maxMs: number;
}

const coldIterations = Number.parseInt(process.env["PVF_BENCH_COLD_ITERATIONS"] ?? "3", 10);
const renderIterations = Number.parseInt(process.env["PVF_BENCH_RENDER_ITERATIONS"] ?? "10", 10);
const listIterations = Number.parseInt(process.env["PVF_BENCH_LIST_ITERATIONS"] ?? "1000", 10);

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatMiB(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function printMemorySnapshot(label: string): void {
  const usage = process.memoryUsage();
  console.log(
    `${label.padEnd(28)} rss=${formatMiB(usage.rss).padStart(10)} heapUsed=${formatMiB(usage.heapUsed).padStart(10)}`,
  );
}

function printResult(result: BenchmarkResult): void {
  console.log(
    `${result.name.padEnd(32)} iterations=${String(result.iterations).padStart(5)}  total=${formatMs(result.totalMs).padStart(10)}  avg=${formatMs(result.averageMs).padStart(10)}  min=${formatMs(result.minMs).padStart(10)}  max=${formatMs(result.maxMs).padStart(10)}`,
  );
}

async function runAsyncBenchmark(
  name: string,
  iterations: number,
  fn: () => Promise<void>,
): Promise<BenchmarkResult> {
  const samples: number[] = [];

  for (let index = 0; index < iterations; index += 1) {
    globalThis.gc?.();
    const startedAt = performance.now();
    await fn();
    samples.push(performance.now() - startedAt);
  }

  const totalMs = samples.reduce((sum, value) => sum + value, 0);

  return {
    name,
    iterations,
    totalMs,
    averageMs: totalMs / iterations,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

async function runSyncBenchmark(
  name: string,
  iterations: number,
  fn: () => void,
): Promise<BenchmarkResult> {
  const samples: number[] = [];

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    fn();
    samples.push(performance.now() - startedAt);
  }

  const totalMs = samples.reduce((sum, value) => sum + value, 0);

  return {
    name,
    iterations,
    totalMs,
    averageMs: totalMs / iterations,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

async function benchmarkColdOpenIndex(): Promise<BenchmarkResult> {
  return runAsyncBenchmark("cold ensureLoaded()", coldIterations, async () => {
    const archive = new PvfArchive("Script.pvf", fixturePath);
    await archive.ensureLoaded();
    await archive.close();
  });
}

async function benchmarkColdFirstRender(): Promise<BenchmarkResult> {
  return runAsyncBenchmark("cold first render amulet", coldIterations, async () => {
    const archive = new PvfArchive("Script.pvf", fixturePath);
    await archive.ensureLoaded();
    const content = await archive.readRenderedFile(samplePaths.amulet, "simplified");

    if (!content.includes(expectedStrings.amuletName)) {
      throw new Error("Benchmark sanity check failed.");
    }

    await archive.close();
  });
}

async function benchmarkWarmOperations(): Promise<BenchmarkResult[]> {
  const archive = new PvfArchive("Script.pvf", fixturePath);
  await archive.ensureLoaded();
  printMemorySnapshot("after ensureLoaded()");

  const firstRender = await runAsyncBenchmark("warm-up first render", 1, async () => {
    const content = await archive.readRenderedFile(samplePaths.amulet, "simplified");

    if (!content.includes(expectedStrings.amuletName)) {
      throw new Error("Benchmark warm-up sanity check failed.");
    }
  });

  printMemorySnapshot("after text resources");

  const repeatedAmulet = await runAsyncBenchmark("warm render amulet", renderIterations, async () => {
    await archive.readRenderedFile(samplePaths.amulet, "simplified");
  });

  const repeatedList = await runAsyncBenchmark("warm render equipment.lst", renderIterations, async () => {
    await archive.readRenderedFile(samplePaths.equipmentList, "simplified");
  });

  const listRoot = await runSyncBenchmark("listDirectory(\"\")", listIterations, () => {
    archive.listDirectory("");
  });

  const listNested = await runSyncBenchmark(`listDirectory("${samplePaths.nestedDirectory}")`, listIterations, () => {
    archive.listDirectory(samplePaths.nestedDirectory);
  });

  await archive.close();
  return [firstRender, repeatedAmulet, repeatedList, listRoot, listNested];
}

async function main(): Promise<void> {
  console.log("PVF benchmark");
  console.log(`fixture: ${fixturePath}`);
  console.log(
    `config: coldIterations=${coldIterations}, renderIterations=${renderIterations}, listIterations=${listIterations}`,
  );
  printMemorySnapshot("start");

  const coldOpenIndex = await benchmarkColdOpenIndex();
  const coldFirstRender = await benchmarkColdFirstRender();
  const warmResults = await benchmarkWarmOperations();

  console.log("");
  printResult(coldOpenIndex);
  printResult(coldFirstRender);

  for (const result of warmResults) {
    printResult(result);
  }
}

await main();
