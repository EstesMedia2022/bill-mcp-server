#!/usr/bin/env node

/**
 * Bill.com MCP Server
 *
 * This server provides MCP (Model Context Protocol) integration with Bill.com API,
 * allowing AI assistants to interact with Bill.com accounting and payment services.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AuthType, BillClient, BillConfig } from "./bill-client.js";
import { createMcpHttpApp, HttpAuth } from "./http-server.js";
import { GoogleOAuthProvider } from "./oauth.js";
import { selectTools, Tool, tools } from "./tools/index.js";

type Transport = "stdio" | "http";

/**
 * Get Bill.com API configuration from environment variables
 *
 * Environment variables:
 * - BILL_DEV_KEY: Developer key from Bill.com (required)
 * - BILL_ENVIRONMENT: "sandbox" or "production" (default: production; required for http transport)
 * - BILL_AUTH_TYPE: "sync_token", "full_access", or "session_token" (default: sync_token)
 *
 * For sync_token and full_access auth:
 * - BILL_USERNAME: For sync_token: token name. For full_access: user email
 * - BILL_PASSWORD: For sync_token: token value. For full_access: user password
 * - BILL_ORGANIZATION_ID: Organization identifier
 *
 * For session_token auth (external auth handling):
 * - BILL_SESSION_TOKEN: Pre-authenticated session token from external system
 *
 * Auth type differences:
 * - sync_token: Limited access (read data, no payments/invoicing), 48-hour session
 * - full_access: Full access (all operations), 35-minute session
 * - session_token: Uses externally-provided token, no login performed
 */
function getBillConfig(transport: Transport): BillConfig {
  const devKey = process.env.BILL_DEV_KEY;
  const environment = process.env.BILL_ENVIRONMENT || (transport === "stdio" ? "production" : undefined);
  const authType = process.env.BILL_AUTH_TYPE || "sync_token";

  if (!devKey) {
    throw new Error("BILL_DEV_KEY environment variable is required.");
  }

  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(
      `Invalid BILL_ENVIRONMENT: "${environment ?? ""}". Must be "sandbox" or "production".`
    );
  }

  if (authType !== "sync_token" && authType !== "full_access" && authType !== "session_token") {
    throw new Error(
      `Invalid BILL_AUTH_TYPE: "${authType}". Must be "sync_token", "full_access", or "session_token".`
    );
  }

  // For session_token auth, only need the session token
  if (authType === "session_token") {
    const sessionToken = process.env.BILL_SESSION_TOKEN;
    if (!sessionToken) {
      throw new Error(
        "BILL_SESSION_TOKEN environment variable is required for session_token auth type."
      );
    }
    return {
      devKey,
      environment: environment as "sandbox" | "production",
      authType: authType as AuthType,
      sessionToken,
    };
  }

  // For sync_token and full_access, need login credentials
  const username = process.env.BILL_USERNAME;
  const password = process.env.BILL_PASSWORD;
  const organizationId = process.env.BILL_ORGANIZATION_ID;

  if (!username || !password || !organizationId) {
    throw new Error(
      "Bill.com credentials not found. Please set BILL_USERNAME, BILL_PASSWORD, and BILL_ORGANIZATION_ID environment variables."
    );
  }

  return {
    devKey,
    username,
    password,
    organizationId,
    environment: environment as "sandbox" | "production",
    authType: authType as AuthType,
  };
}

/**
 * Transport: MCP_TRANSPORT ("stdio" or "http"), defaulting to http when the
 * platform provides a PORT (as Railway does) and stdio otherwise
 */
function getTransport(): Transport {
  const transport = process.env.MCP_TRANSPORT || (process.env.PORT ? "http" : "stdio");
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid MCP_TRANSPORT: "${transport}". Must be "stdio" or "http".`);
  }
  return transport;
}

/**
 * Tools to expose, from environment variables:
 * - BILL_READ_ONLY: "true" exposes only list_* and get_* tools
 *   (default: true for http transport, false for stdio)
 * - BILL_ALLOWED_TOOLS: optional comma-separated list of tool names to expose
 */
function getEnabledTools(transport: Transport): Tool[] {
  const readOnlySetting = process.env.BILL_READ_ONLY ?? (transport === "http" ? "true" : "false");
  if (readOnlySetting !== "true" && readOnlySetting !== "false") {
    throw new Error(`Invalid BILL_READ_ONLY: "${readOnlySetting}". Must be "true" or "false".`);
  }
  const allowList = (process.env.BILL_ALLOWED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return selectTools(tools, { readOnly: readOnlySetting === "true", allowList });
}

/**
 * Authentication for the http transport, from environment variables.
 *
 * With GOOGLE_CLIENT_ID set, users sign in with Google (OAuth) and only emails
 * in BILL_ALLOWED_EMAILS get access. Requires:
 * - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: Google OAuth client credentials
 * - BILL_ALLOWED_EMAILS: comma-separated list of allowed emails
 * - OAUTH_SIGNING_SECRET: random secret of at least 32 characters
 * - PUBLIC_URL: public base URL (defaults to https://$RAILWAY_PUBLIC_DOMAIN)
 * MCP_AUTH_TOKEN is then optional and, if set, is accepted without sign-in.
 *
 * Otherwise every request needs MCP_AUTH_TOKEN as a bearer token.
 */
function getHttpAuth(): HttpAuth {
  const staticToken = process.env.MCP_AUTH_TOKEN || undefined;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;

  if (!googleClientId) {
    if (!staticToken) {
      throw new Error(
        "Set GOOGLE_CLIENT_ID (Google sign-in) or MCP_AUTH_TOKEN (static token) for http transport."
      );
    }
    console.error("[Bill.com MCP Server] Auth: static token");
    return { kind: "static", token: staticToken };
  }

  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const signingSecret = process.env.OAUTH_SIGNING_SECRET;
  const allowedEmails = (process.env.BILL_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  const publicUrl =
    process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);

  if (!googleClientSecret || !signingSecret || !publicUrl) {
    throw new Error(
      "Google sign-in requires GOOGLE_CLIENT_SECRET, OAUTH_SIGNING_SECRET and PUBLIC_URL (or RAILWAY_PUBLIC_DOMAIN)."
    );
  }

  const provider = new GoogleOAuthProvider({
    publicUrl: new URL(publicUrl),
    googleClientId,
    googleClientSecret,
    allowedEmails,
    signingSecret,
    staticToken,
  });
  console.error(`[Bill.com MCP Server] Auth: Google sign-in, ${allowedEmails.length} allowed email(s)`);
  if (staticToken) {
    console.error("[Bill.com MCP Server] MCP_AUTH_TOKEN is also accepted and bypasses the email allow list");
  }
  return { kind: "oauth", provider, publicUrl: new URL(publicUrl) };
}

/**
 * Build an MCP server exposing the given tools
 */
function createMcpServer(billClient: BillClient, enabledTools: Tool[]): Server {
  const server = new Server(
    {
      name: "bill-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error("[Bill.com MCP Server] Listing available tools");
    return {
      tools: enabledTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(`[Bill.com MCP Server] Tool called: ${name}`);

    const tool = enabledTools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const result = await tool.handler(args, billClient);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Bill.com MCP Server] Tool execution error:`, errorMessage);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: errorMessage,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Main server initialization
 */
async function main() {
  console.error("[Bill.com MCP Server] Starting...");

  // Get configuration
  const transport = getTransport();
  const config = getBillConfig(transport);
  const enabledTools = getEnabledTools(transport);
  console.error(`[Bill.com MCP Server] Environment: ${config.environment}`);
  console.error(`[Bill.com MCP Server] Auth type: ${config.authType}`);
  console.error(`[Bill.com MCP Server] Transport: ${transport}`);
  console.error(`[Bill.com MCP Server] Tools enabled: ${enabledTools.length} of ${tools.length}`);

  // Initialize Bill.com API client, shared by all requests so the session is reused
  const billClient = new BillClient(config);

  if (transport === "stdio") {
    const server = createMcpServer(billClient, enabledTools);
    await server.connect(new StdioServerTransport());
    console.error("[Bill.com MCP Server] Server started successfully");
    return;
  }

  const port = Number(process.env.PORT || 3000);
  const app = createMcpHttpApp(() => createMcpServer(billClient, enabledTools), getHttpAuth());
  app.listen(port, () => {
    console.error(`[Bill.com MCP Server] Listening on port ${port} (POST /mcp, GET /health)`);
  });
}

// Run the server
main().catch((error) => {
  console.error("[Bill.com MCP Server] Fatal error:", error);
  process.exit(1);
});
