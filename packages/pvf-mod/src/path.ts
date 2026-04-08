import { isAbsolute, relative, resolve } from "node:path";

export function isPathWithinDirectory(baseDir: string, candidatePath: string): boolean {
  const resolvedBaseDir = resolve(baseDir);
  const resolvedCandidatePath = resolve(candidatePath);
  const relativePath = relative(resolvedBaseDir, resolvedCandidatePath);

  return relativePath === ""
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function resolvePathWithinDirectory(
  baseDir: string,
  pathValue: string,
  label: string,
): string {
  const resolvedBaseDir = resolve(baseDir);
  const resolvedPath = resolve(resolvedBaseDir, pathValue);

  if (!isPathWithinDirectory(resolvedBaseDir, resolvedPath)) {
    throw new Error(`${label} must stay within ${resolvedBaseDir}, received ${pathValue}.`);
  }

  return resolvedPath;
}
