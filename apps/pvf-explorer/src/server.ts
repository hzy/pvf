import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureStore } from "./fixture-store.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../../..");
const fixturesDir = path.resolve(workspaceRoot, "fixtures");
const publicDir = path.resolve(currentDir, "../public");
const store = new FixtureStore(fixturesDir);

function sendJson(response: ServerResponse, statusCode: number, data: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function getStaticContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }

  return "text/html; charset=utf-8";
}

async function handleApiRequest(requestUrl: URL, response: ServerResponse): Promise<void> {
  if (requestUrl.pathname === "/api/archives") {
    sendJson(response, 200, { archives: await store.listArchives() });
    return;
  }

  const archiveId = requestUrl.searchParams.get("archive");

  if (!archiveId) {
    sendJson(response, 400, { error: "Missing archive query parameter." });
    return;
  }

  const archive = await store.getArchive(archiveId);
  await archive.ensureLoaded();

  if (requestUrl.pathname === "/api/tree") {
    const treePath = requestUrl.searchParams.get("path") ?? "";
    sendJson(response, 200, {
      archive: archiveId,
      path: treePath,
      fileCount: archive.fileCount,
      children: archive.listDirectory(treePath),
    });
    return;
  }

  if (requestUrl.pathname === "/api/file") {
    const filePath = requestUrl.searchParams.get("path");

    if (!filePath) {
      sendJson(response, 400, { error: "Missing path query parameter." });
      return;
    }

    sendJson(response, 200, {
      archive: archiveId,
      path: filePath,
      content: await archive.readRenderedFile(filePath),
    });
    return;
  }

  sendJson(response, 404, { error: "Unknown API endpoint." });
}

async function handleStaticRequest(requestUrl: URL, response: ServerResponse): Promise<void> {
  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const filePath = path.resolve(publicDir, relativePath);

  if (!filePath.startsWith(publicDir)) {
    sendText(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  const content = await readFile(filePath, "utf8");
  sendText(response, 200, content, getStaticContentType(filePath));
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApiRequest(requestUrl, response);
      return;
    }

    await handleStaticRequest(requestUrl, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    sendJson(response, 500, { error: message });
  }
});

const port = Number(process.env["PVF_EXPLORER_PORT"] ?? "4318");

server.listen(port, "127.0.0.1", () => {
  console.log(`PVF Explorer listening at http://127.0.0.1:${port}`);
  console.log(`Fixtures directory: ${fixturesDir}`);
});

async function shutdown(): Promise<void> {
  await store.close();
  server.close();
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
