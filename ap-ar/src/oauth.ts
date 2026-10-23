/**
 * OAuth for the HTTP transport, with Google as the identity provider
 *
 * MCP clients (e.g. Claude.ai connectors) register and authorize against this
 * server. The user signs in with Google, and only verified emails listed in
 * BILL_ALLOWED_EMAILS receive tokens.
 *
 * Everything this server issues (client IDs, authorization codes, access and
 * refresh tokens) is an HMAC-signed, self-contained value, so no database is
 * needed and tokens survive restarts and redeploys. Every token is checked
 * against the current allow list, so removing an email revokes its access at
 * the next request; rotating OAUTH_SIGNING_SECRET revokes everything.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";
export const MIN_SIGNING_SECRET_LENGTH = 32;

const AUTH_REQUEST_TTL_SECONDS = 10 * 60;
const AUTH_CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface GoogleOAuthConfig {
  /** Public base URL of this server, e.g. https://bill-mcp.up.railway.app */
  publicUrl: URL;
  googleClientId: string;
  googleClientSecret: string;
  /** Emails allowed to sign in (compared case-insensitively) */
  allowedEmails: string[];
  /** Secret used to sign everything this server issues */
  signingSecret: string;
  /** Optional static token accepted in addition to OAuth (bypasses the email check) */
  staticToken?: string;
}

type TokenType = "client" | "authreq" | "code" | "access" | "refresh";

interface AuthRequestPayload {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
}

interface CodePayload extends AuthRequestPayload {
  email: string;
  jti: string;
}

interface TokenPayload {
  clientId: string;
  email: string;
  scopes: string[];
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Signs and verifies self-contained values. The token type is part of the
 * signed payload, so a value of one type can never be used as another.
 */
export class Signer {
  constructor(private readonly secret: string) {
    if (secret.length < MIN_SIGNING_SECRET_LENGTH) {
      throw new Error(
        `OAUTH_SIGNING_SECRET must be at least ${MIN_SIGNING_SECRET_LENGTH} characters long.`
      );
    }
  }

  private mac(data: string): string {
    return createHmac("sha256", this.secret).update(data).digest("base64url");
  }

  sign(type: TokenType, payload: object, ttlSeconds?: number): string {
    const body = base64url(
      JSON.stringify({ ...payload, typ: type, ...(ttlSeconds ? { exp: nowSeconds() + ttlSeconds } : {}) })
    );
    return `${body}.${this.mac(body)}`;
  }

  verify<T>(type: TokenType, value: string): T | undefined {
    const [body, mac, extra] = value.split(".");
    if (!body || !mac || extra !== undefined || !safeEqual(mac, this.mac(body))) {
      return undefined;
    }
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (payload.typ !== type || (payload.exp !== undefined && payload.exp < nowSeconds())) {
        return undefined;
      }
      return payload as T;
    } catch {
      return undefined;
    }
  }

  /** Deterministic secret for a client, so registrations need no storage */
  clientSecret(clientId: string): string {
    return this.mac(`client-secret:${clientId}`);
  }
}

/**
 * OAuth authorization server that delegates sign-in to Google
 */
export class GoogleOAuthProvider implements OAuthServerProvider {
  private readonly signer: Signer;
  private readonly allowedEmails: Set<string>;
  /** Authorization codes already exchanged (best effort; PKCE also guards codes) */
  private readonly usedCodes = new Map<string, number>();

  constructor(private readonly config: GoogleOAuthConfig) {
    this.signer = new Signer(config.signingSecret);
    this.allowedEmails = new Set(config.allowedEmails.map((email) => email.trim().toLowerCase()));
    if (this.allowedEmails.size === 0) {
      throw new Error("BILL_ALLOWED_EMAILS must list at least one email.");
    }
  }

  isEmailAllowed(email: string): boolean {
    return this.allowedEmails.has(email.toLowerCase());
  }

  get callbackUrl(): string {
    return new URL(GOOGLE_CALLBACK_PATH, this.config.publicUrl).href;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const client = this.signer.verify<Omit<OAuthClientInformationFull, "client_id">>("client", clientId);
        if (!client) {
          return undefined;
        }
        const { typ: _typ, ...metadata } = client as typeof client & { typ: string };
        return {
          ...metadata,
          client_id: clientId,
          ...(metadata.token_endpoint_auth_method === "none"
            ? {}
            : { client_secret: this.signer.clientSecret(clientId) }),
        };
      },
      registerClient: (client) => {
        const { client_secret: _secret, client_secret_expires_at: _expiry, ...metadata } = client;
        const clientId = this.signer.sign("client", {
          ...metadata,
          client_id_issued_at: nowSeconds(),
        });
        const isPublic = metadata.token_endpoint_auth_method === "none";
        return {
          ...metadata,
          client_id: clientId,
          client_id_issued_at: nowSeconds(),
          ...(isPublic ? {} : { client_secret: this.signer.clientSecret(clientId), client_secret_expires_at: 0 }),
        };
      },
    };
  }

  /**
   * Start authorization: remember the client's request in a signed state value
   * and send the user to Google
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request: AuthRequestPayload = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
    };
    const googleUrl = new URL(GOOGLE_AUTH_URL);
    googleUrl.search = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: this.callbackUrl,
      response_type: "code",
      scope: "openid email",
      prompt: "select_account",
      state: this.signer.sign("authreq", request, AUTH_REQUEST_TTL_SECONDS),
    }).toString();
    res.redirect(googleUrl.href);
  }

  /**
   * Google redirects here after sign-in. Verifies the email and sends the user
   * back to the MCP client with an authorization code, or an access_denied error.
   */
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const request = this.signer.verify<AuthRequestPayload>("authreq", state);
    if (!request) {
      res.status(400).send("Invalid or expired sign-in request. Please try connecting again.");
      return;
    }

    const redirect = new URL(request.redirectUri);
    if (request.state !== undefined) {
      redirect.searchParams.set("state", request.state);
    }
    const deny = (description: string) => {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", description);
      res.redirect(redirect.href);
    };

    const googleCode = typeof req.query.code === "string" ? req.query.code : undefined;
    if (!googleCode) {
      deny("Google sign-in was cancelled.");
      return;
    }

    let email: string;
    try {
      email = await this.fetchVerifiedEmail(googleCode);
    } catch (error) {
      console.error("[Bill.com MCP Server] Google sign-in failed:", error instanceof Error ? error.message : error);
      deny("Google sign-in failed.");
      return;
    }

    if (!this.isEmailAllowed(email)) {
      console.error(`[Bill.com MCP Server] Access denied for ${email}`);
      deny(`${email} is not allowed to use this server.`);
      return;
    }

    console.error(`[Bill.com MCP Server] Signed in: ${email}`);
    const code: CodePayload = { ...request, email, jti: base64url(randomBytes(16)) };
    redirect.searchParams.set("code", this.signer.sign("code", code, AUTH_CODE_TTL_SECONDS));
    res.redirect(redirect.href);
  }

  /**
   * Exchange Google's code for an ID token and return its verified email.
   *
   * The ID token comes straight from Google's token endpoint over TLS, so per
   * OpenID Connect Core 3.1.3.7 its signature need not be checked; the issuer,
   * audience and expiry still are.
   */
  private async fetchVerifiedEmail(googleCode: string): Promise<string> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: googleCode,
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        redirect_uri: this.callbackUrl,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) {
      throw new Error(`Google token endpoint returned ${response.status}: ${await response.text()}`);
    }
    const { id_token: idToken } = (await response.json()) as { id_token?: string };
    const claims = JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (
      !GOOGLE_ISSUERS.includes(claims.iss) ||
      claims.aud !== this.config.googleClientId ||
      typeof claims.exp !== "number" ||
      claims.exp < nowSeconds() ||
      claims.email_verified !== true ||
      typeof claims.email !== "string"
    ) {
      throw new Error("Google ID token is invalid or the email is not verified");
    }
    return claims.email.toLowerCase();
  }

  private verifyCode(client: OAuthClientInformationFull, authorizationCode: string): CodePayload {
    const code = this.signer.verify<CodePayload>("code", authorizationCode);
    if (!code || code.clientId !== client.client_id || this.usedCodes.has(code.jti)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.verifyCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const code = this.verifyCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.markCodeUsed(code.jti);
    return this.issueTokens({ clientId: code.clientId, email: code.email, scopes: code.scopes });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const token = this.signer.verify<TokenPayload>("refresh", refreshToken);
    if (!token || token.clientId !== client.client_id || !this.isEmailAllowed(token.email)) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    return this.issueTokens(token);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.config.staticToken && safeEqual(token, this.config.staticToken)) {
      return { token, clientId: "static-token", scopes: [], expiresAt: nowSeconds() + ACCESS_TOKEN_TTL_SECONDS };
    }
    const payload = this.signer.verify<TokenPayload & { exp: number }>("access", token);
    if (!payload || !this.isEmailAllowed(payload.email)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scopes,
      expiresAt: payload.exp,
      extra: { email: payload.email },
    };
  }

  private issueTokens({ clientId, email, scopes }: TokenPayload): OAuthTokens {
    const payload: TokenPayload = { clientId, email, scopes };
    return {
      access_token: this.signer.sign("access", payload, ACCESS_TOKEN_TTL_SECONDS),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: this.signer.sign("refresh", payload, REFRESH_TOKEN_TTL_SECONDS),
      ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
    };
  }

  private markCodeUsed(jti: string): void {
    const now = Date.now();
    for (const [usedJti, expiresAt] of this.usedCodes) {
      if (expiresAt < now) {
        this.usedCodes.delete(usedJti);
      }
    }
    this.usedCodes.set(jti, now + AUTH_CODE_TTL_SECONDS * 1000);
  }
}
