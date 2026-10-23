import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { AddressInfo } from "node:net";
import { createServer, Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHttpApp } from "./http-server.js";
import { GoogleOAuthProvider, Signer } from "./oauth.js";

const GOOGLE_CLIENT_ID = "google-client-id.apps.googleusercontent.com";
const SIGNING_SECRET = "s".repeat(48);
const STATIC_TOKEN = "t".repeat(40);
const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function createTestMcpServer(): Server {
  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "list_bills", description: "List bills", inputSchema: { type: "object", properties: {} } }],
  }));
  return server;
}

/** Fake Google ID token (unsigned; the server trusts Google's token endpoint over TLS) */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email_verified: true,
    ...claims,
  })}.signature`;
}

describe("Signer", () => {
  const signer = new Signer(SIGNING_SECRET);

  it("should round-trip a payload", () => {
    expect(signer.verify("access", signer.sign("access", { a: 1 }, 60))).toMatchObject({ a: 1, typ: "access" });
  });

  it("should reject a tampered value", () => {
    const [body, mac] = signer.sign("access", { email: "a@x.com" }, 60).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), email: "evil@x.com" })
    ).toString("base64url");
    expect(signer.verify("access", `${forged}.${mac}`)).toBeUndefined();
  });

  it("should reject a value of another type", () => {
    expect(signer.verify("access", signer.sign("refresh", {}, 60))).toBeUndefined();
  });

  it("should reject an expired value", () => {
    vi.useFakeTimers();
    const value = signer.sign("access", {}, 60);
    vi.advanceTimersByTime(61_000);
    expect(signer.verify("access", value)).toBeUndefined();
    vi.useRealTimers();
  });

  it("should reject a value signed with another secret", () => {
    expect(new Signer("x".repeat(48)).verify("access", signer.sign("access", {}, 60))).toBeUndefined();
  });

  it("should require a long secret", () => {
    expect(() => new Signer("short")).toThrow("at least 32");
  });
});

describe("Google OAuth flow", () => {
  let httpServer: HttpServer;
  let baseUrl: string;
  let googleEmail: string;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ id_token: idToken({ email: googleEmail }) }), { status: 200 });
      }
      return realFetch(input, init);
    });

    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const provider = new GoogleOAuthProvider({
      publicUrl: new URL(baseUrl),
      googleClientId: GOOGLE_CLIENT_ID,
      googleClientSecret: "google-secret",
      allowedEmails: ["Daniel@EstesMedia.com", "joshua@estesmedia.com"],
      signingSecret: SIGNING_SECRET,
      staticToken: STATIC_TOKEN,
    });
    httpServer.on("request", createMcpHttpApp(createTestMcpServer, { kind: "oauth", provider, publicUrl: new URL(baseUrl) }));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const register = async (metadata: Record<string, unknown> = {}) => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none", ...metadata }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string; client_secret?: string };
  };

  /** Runs /authorize and the Google callback; returns the redirect back to the client */
  const signIn = async (clientId: string, email: string, verifier: string) => {
    googleEmail = email;
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await fetch(
      `${baseUrl}/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "client-state",
      })}`,
      { redirect: "manual" }
    );
    expect(authorize.status).toBe(302);
    const google = new URL(authorize.headers.get("location")!);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.searchParams.get("redirect_uri")).toBe(`${baseUrl}/oauth/google/callback`);

    const callback = await fetch(
      `${baseUrl}/oauth/google/callback?${new URLSearchParams({ code: "google-code", state: google.searchParams.get("state")! })}`,
      { redirect: "manual" }
    );
    expect(callback.status).toBe(302);
    return new URL(callback.headers.get("location")!);
  };

  const token = (params: Record<string, string>) =>
    fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });

  const listTools = (accessToken: string) =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("should advertise OAuth metadata", async () => {
    const resource: any = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource.resource).toBe(`${baseUrl}/mcp`);
    const server: any = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(server.registration_endpoint).toBe(`${baseUrl}/register`);
  });

  it("should point unauthenticated clients to the resource metadata", async () => {
    const res = await listTools("nope");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("should sign in an allowed email (case-insensitive) and serve MCP", async () => {
    const { client_id } = await register();
    const verifier = randomBytes(32).toString("base64url");
    const back = await signIn(client_id, "daniel@estesmedia.com", verifier);

    expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("state")).toBe("client-state");
    const code = back.searchParams.get("code")!;

    const res = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: CLIENT_REDIRECT });
    expect(res.status).toBe(200);
    const tokens: any = await res.json();
    expect(tokens.token_type).toBe("Bearer");

    const mcp = await listTools(tokens.access_token);
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain("list_bills");

    // A code works only once
    const replay = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: CLIENT_REDIRECT });
    expect(replay.status).toBe(400);

    // Refresh tokens work and are not access tokens
    expect((await listTools(tokens.refresh_token)).status).toBe(401);
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id });
    expect(refreshed.status).toBe(200);
    expect((await listTools(((await refreshed.json()) as any).access_token)).status).toBe(200);
  });

  it("should deny an email that is not allowed", async () => {
    const { client_id } = await register();
    const back = await signIn(client_id, "someone@estesmedia.com", randomBytes(32).toString("base64url"));
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("state")).toBe("client-state");
  });

  it("should reject a code without the right PKCE verifier", async () => {
    const { client_id } = await register();
    const back = await signIn(client_id, "joshua@estesmedia.com", randomBytes(32).toString("base64url"));
    const res = await token({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: randomBytes(32).toString("base64url"),
      client_id,
      redirect_uri: CLIENT_REDIRECT,
    });
    expect(res.status).toBe(400);
  });

  it("should reject a code issued to another client", async () => {
    const first = await register();
    const second = await register();
    const verifier = randomBytes(32).toString("base64url");
    const back = await signIn(first.client_id, "joshua@estesmedia.com", verifier);
    const res = await token({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: second.client_id,
      redirect_uri: CLIENT_REDIRECT,
    });
    expect(res.status).toBe(400);
  });

  it("should support confidential clients with a derived secret", async () => {
    const client = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(client.client_secret).toBeTruthy();
    const verifier = randomBytes(32).toString("base64url");
    const back = await signIn(client.client_id, "joshua@estesmedia.com", verifier);
    const params = {
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
    };
    const wrong = await token({ ...params, client_secret: "wrong" });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).error).toBe("invalid_client");
    expect((await token({ ...params, client_secret: client.client_secret! })).status).toBe(200);
  });

  it("should reject an unregistered redirect URI", async () => {
    const { client_id } = await register();
    const res = await fetch(
      `${baseUrl}/authorize?${new URLSearchParams({
        client_id,
        redirect_uri: "https://evil.example/callback",
        response_type: "code",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(400);
  });

  it("should reject a forged callback state", async () => {
    const res = await fetch(`${baseUrl}/oauth/google/callback?code=x&state=forged.state`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("should still accept the static token", async () => {
    expect((await listTools(STATIC_TOKEN)).status).toBe(200);
  });

  it("should require at least one allowed email", () => {
    expect(
      () =>
        new GoogleOAuthProvider({
          publicUrl: new URL(baseUrl),
          googleClientId: GOOGLE_CLIENT_ID,
          googleClientSecret: "x",
          allowedEmails: [],
          signingSecret: SIGNING_SECRET,
        })
    ).toThrow("BILL_ALLOWED_EMAILS");
  });
});
