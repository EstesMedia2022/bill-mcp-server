/**
 * HTTP transport for remote deployments (e.g. Railway)
 *
 * Serves the MCP Streamable HTTP protocol in stateless mode on `/mcp`, with a
 * bearer token required on every request, plus an unauthenticated `/health`
 * endpoint for platform health checks.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
export const MIN_AUTH_TOKEN_LENGTH = 32;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Constant-time check of the `Authorization: Bearer <token>` header
 */
export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  const match = /^Bearer (.+)$/.exec(authorizationHeader ?? "");
  if (!match) {
    return false;
  }
  return timingSafeEqual(sha256(match[1]), sha256(expectedToken));
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers?: Record<string, string>) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Create the HTTP server
 *
 * @param createMcpServer - builds a fresh MCP server per request (stateless mode)
 * @param authToken - token clients must send as `Authorization: Bearer <token>`
 */
export function createMcpHttpServer(createMcpServer: () => Server, authToken: string): HttpServer {
  if (authToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters long.`);
  }

  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (path !== "/mcp") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (!isAuthorized(req.headers.authorization, authToken)) {
      jsonRpcError(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }

    // Stateless mode only supports POST; there are no sessions to stream or delete
    if (req.method !== "POST") {
      jsonRpcError(res, 405, "Method not allowed", { Allow: "POST" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid request body";
      jsonRpcError(res, 400, message);
      return;
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("[Bill.com MCP Server] HTTP request error:", error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, "Internal server error");
      }
    }
  });
}
