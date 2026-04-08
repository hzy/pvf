import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureStore } from "./fixture-store.ts";
import { DEFAULT_TEXT_PROFILE, type TextProfile } from "./pvf.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, "../../..");
const fixturesDir = path.resolve(workspaceRoot, "fixtures");
const publicDir = path.resolve(currentDir, "../public");
const store = new FixtureStore(fixturesDir);

function sendJson(
  response: ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
): void {
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

function parseTextProfile(value: string | null): TextProfile {
  return value === "traditional" ? "traditional" : DEFAULT_TEXT_PROFILE;
}

function getErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) {
    return 500;
  }

  if (/missing|expected/i.test(error.message)) {
    return 400;
  }

  if (/version mismatch|stale/i.test(error.message)) {
    return 409;
  }

  if (/not found/i.test(error.message)) {
    return 404;
  }

  return 500;
}

async function handleApiRequest(
  request: IncomingMessage,
  requestUrl: URL,
  response: ServerResponse,
): Promise<void> {
  if (requestUrl.pathname === "/api/archives") {
    sendJson(response, 200, { archives: await store.listArchives() });
    return;
  }

  const archiveId = requestUrl.searchParams.get("archive");

  if (!archiveId) {
    sendJson(response, 400, { error: "Missing archive query parameter." });
    return;
  }

  if (requestUrl.pathname === "/api/tree") {
    const archive = await store.getArchive(archiveId);
    await archive.ensureLoaded();
    const treePath = requestUrl.searchParams.get("path") ?? "";
    sendJson(response, 200, {
      archive: archiveId,
      path: treePath,
      fileCount: archive.fileCount,
      children: archive.listDirectory(treePath),
    });
    return;
  }

  if (requestUrl.pathname === "/api/file/open") {
    if (request.method === "POST") {
      const payload = await readJsonBody(request);
      const filePath = typeof payload["path"] === "string" ? payload["path"] : "";
      const textProfile = parseTextProfile(
        typeof payload["textProfile"] === "string" ? payload["textProfile"] : null,
      );

      if (!filePath) {
        sendJson(response, 400, { error: "Missing path in request body." });
        return;
      }

      sendJson(response, 200, await store.openArchiveFile(archiveId, filePath, textProfile));
      return;
    }

    sendJson(response, 405, { error: "Unsupported method for /api/file/open." });
    return;
  }

  if (requestUrl.pathname === "/api/file/save") {
    if (request.method === "POST") {
      const payload = await readJsonBody(request);
      const sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : "";
      const version = typeof payload["version"] === "number" ? payload["version"] : Number.NaN;
      const content = typeof payload["content"] === "string" ? payload["content"] : "";

      if (sessionId.length === 0 || !Number.isInteger(version)) {
        sendJson(response, 400, { error: "Missing sessionId or version in request body." });
        return;
      }

      sendJson(
        response,
        200,
        await store.saveArchiveSession(sessionId, content, version),
      );
      return;
    }

    sendJson(response, 405, { error: "Unsupported method for /api/file/save." });
    return;
  }

  if (requestUrl.pathname === "/api/file/close") {
    if (request.method === "POST") {
      const payload = await readJsonBody(request);
      const sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : "";

      if (sessionId.length === 0) {
        sendJson(response, 400, { error: "Missing sessionId in request body." });
        return;
      }

      store.closeArchiveSession(sessionId);
      sendJson(response, 200, { closed: true, sessionId });
      return;
    }

    sendJson(response, 405, { error: "Unsupported method for /api/file/close." });
    return;
  }

  sendJson(response, 404, { error: "Unknown API endpoint." });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > 4 * 1024 * 1024) {
      throw new Error("Request body too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(text) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object body.");
  }

  return parsed as Record<string, unknown>;
}

async function handleStaticRequest(
  requestUrl: URL,
  response: ServerResponse,
): Promise<void> {
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
      await handleApiRequest(request, requestUrl, response);
      return;
    }

    await handleStaticRequest(requestUrl, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    sendJson(response, getErrorStatus(error), { error: message });
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
