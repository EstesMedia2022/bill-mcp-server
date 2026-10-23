/**
 * HTTP transport for remote deployments (e.g. Railway)
 *
 * Serves the MCP Streamable HTTP protocol in stateless mode on `/mcp`, plus an
 * unauthenticated `/health` endpoint for platform health checks. Every `/mcp`
 * request needs a bearer token: either a static token, or an OAuth access token
 * issued after the user signs in with Google (see oauth.ts).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { GOOGLE_CALLBACK_PATH, GoogleOAuthProvider } from "./oauth.js";

const MAX_BODY = "1mb";
export const MIN_AUTH_TOKEN_LENGTH = 32;

export type HttpAuth =
  | { kind: "static"; token: string }
  | { kind: "oauth"; provider: GoogleOAuthProvider; publicUrl: URL };

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

function staticTokenVerifier(expectedToken: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      if (!isAuthorized(`Bearer ${token}`, expectedToken)) {
        throw new InvalidTokenError("Invalid token");
      }
      return { token, clientId: "static-token", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
  };
}

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * Create the Express app
 *
 * @param createMcpServer - builds a fresh MCP server per request (stateless mode)
 * @param auth - how `/mcp` requests are authenticated
 */
export function createMcpHttpApp(createMcpServer: () => Server, auth: HttpAuth): express.Express {
  if (auth.kind === "static" && auth.token.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters long.`);
  }

  const app = express();
  // Railway (and most platforms) terminate TLS at a proxy; needed for rate limiting
  app.set("trust proxy", 1);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  let verifier: OAuthTokenVerifier;
  let resourceMetadataUrl: string | undefined;
  if (auth.kind === "oauth") {
    const mcpUrl = new URL("/mcp", auth.publicUrl);
    app.use(
      mcpAuthRouter({
        provider: auth.provider,
        issuerUrl: auth.publicUrl,
        resourceServerUrl: mcpUrl,
        resourceName: "Bill.com MCP Server",
      })
    );
    app.get(GOOGLE_CALLBACK_PATH, (req, res, next) => {
      auth.provider.handleGoogleCallback(req, res).catch(next);
    });
    verifier = auth.provider;
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
  } else {
    verifier = staticTokenVerifier(auth.token);
  }

  const requireAuth = requireBearerAuth({ verifier, resourceMetadataUrl });

  app.post("/mcp", requireAuth, express.json({ limit: MAX_BODY }), async (req: Request, res: Response) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[Bill.com MCP Server] HTTP request error:", error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  // Stateless mode only supports POST; there are no sessions to stream or delete
  app.all("/mcp", requireAuth, (_req, res) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, "Method not allowed");
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Malformed JSON and oversized bodies from express.json()
  app.use((error: { status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) {
      console.error("[Bill.com MCP Server] HTTP error:", error);
    }
    jsonRpcError(res, status, status === 500 ? "Internal server error" : error.message ?? "Bad request");
  });

  return app;
}
