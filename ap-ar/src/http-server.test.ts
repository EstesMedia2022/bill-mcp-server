import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AddressInfo } from "node:net";
import { Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHttpServer, isAuthorized } from "./http-server.js";

const TOKEN = "a".repeat(40);

function createTestMcpServer(): Server {
  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "list_bills", description: "List bills", inputSchema: { type: "object", properties: {} } }],
  }));
  return server;
}

describe("isAuthorized", () => {
  it("should accept the exact bearer token", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([undefined, "", TOKEN, `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, "Bearer "])("should reject %s", (header) => {
    expect(isAuthorized(header, TOKEN)).toBe(false);
  });
});

describe("createMcpHttpServer", () => {
  let httpServer: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createMcpHttpServer(createTestMcpServer, TOKEN);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const listTools = (headers: Record<string, string>) =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("should refuse a short auth token", () => {
    expect(() => createMcpHttpServer(createTestMcpServer, "short")).toThrow("at least 32");
  });

  it("should serve /health without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("should reject /mcp without a token", async () => {
    const res = await listTools({});
    expect(res.status).toBe(401);
  });

  it("should reject /mcp with a wrong token", async () => {
    const res = await listTools({ Authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("should answer MCP requests with the right token", async () => {
    const res = await listTools({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("list_bills");
  });

  it("should reject non-POST methods", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });

  it("should reject invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("should return 404 for other paths", async () => {
    const res = await fetch(`${baseUrl}/other`);
    expect(res.status).toBe(404);
  });
});
