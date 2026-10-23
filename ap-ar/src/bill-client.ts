/**
 * Bill.com API Client
 *
 * Provides a wrapper around the Bill.com AP/AR API with session-based authentication
 * and error handling.
 */

import axios, { AxiosInstance, AxiosError, AxiosResponse } from "axios";

/**
 * Authentication type for Bill.com API
 *
 * - sync_token: Uses AP/AR sync token (limited access, 48-hour session)
 *   Username = sync token name, Password = sync token value
 *   Cannot: pay bills, void payments, charge customers, manage users, send invoices
 *
 * - full_access: Uses real user credentials (full access, 35-minute session)
 *   Username = user email, Password = user password
 *   Can: all operations including payments, user management, and invoicing
 *
 * - session_token: Uses an externally-provided session token (no login required)
 *   Useful when auth is handled by an external system
 *   Session management is external - token is used as-is
 */
export type AuthType = "sync_token" | "full_access" | "session_token";

export interface BillConfig {
  devKey: string;
  environment: "sandbox" | "production";
  authType: AuthType;
  // Required for sync_token and full_access auth types
  username?: string;
  password?: string;
  organizationId?: string;
  // Required for session_token auth type
  sessionToken?: string;
}

export class BillApiError extends Error {
  public readonly errorType: string;
  public readonly status: number;

  constructor(message: string, status: number, errorType: string) {
    super(message);
    this.name = "BillApiError";
    this.errorType = errorType;
    this.status = status;
  }
}

/**
 * Bill.com API Client with session management
 */
export class BillClient {
  private client: AxiosInstance;
  private readonly baseUrl: string;
  private readonly devKey: string;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly organizationId: string | undefined;
  private readonly authType: AuthType;
  private sessionId: string | null = null;
  private sessionExpiresAt: number = 0;

  constructor(config: BillConfig) {
    this.devKey = config.devKey;
    this.authType = config.authType;

    if (config.authType === "session_token") {
      // For session_token auth, use the provided token directly
      if (!config.sessionToken) {
        throw new Error("sessionToken is required for session_token auth type");
      }
      this.sessionId = config.sessionToken;
      // External session - no expiration tracking (managed externally)
      this.sessionExpiresAt = Number.MAX_SAFE_INTEGER;
    } else {
      // For sync_token and full_access, require login credentials
      if (!config.username || !config.password || !config.organizationId) {
        throw new Error(
          "username, password, and organizationId are required for sync_token and full_access auth types"
        );
      }
      this.username = config.username;
      this.password = config.password;
      this.organizationId = config.organizationId;
    }

    // Set base URL based on environment - AP/AR API uses /v3
    this.baseUrl =
      config.environment === "production"
        ? "https://gateway.prod.bill.com/connect/v3"
        : "https://gateway.stage.bill.com/connect/v3";

    // Create axios instance with default configuration
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000, // 30 second timeout
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        return Promise.reject(this.handleError(error));
      }
    );
  }

  /**
   * Login and get session ID
   */
  private async login(): Promise<void> {
    // For session_token auth, we don't login - session is managed externally
    if (this.authType === "session_token") {
      if (!this.sessionId) {
        throw new Error("Session token was not provided or has been cleared");
      }
      return;
    }

    console.error(`[Bill.com API] Logging in (${this.authType})...`);
    try {
      const response = await this.client.post("/login", {
        username: this.username,
        password: this.password,
        organizationId: this.organizationId,
        devKey: this.devKey,
      });

      this.sessionId = response.data.sessionId;
      if (!this.sessionId) {
        throw new Error("No sessionId in login response");
      }

      // Session expiration depends on auth type:
      // - sync_token: 48 hours (when idle)
      // - full_access: 35 minutes (when idle)
      const sessionDurationMs =
        this.authType === "sync_token"
          ? 48 * 60 * 60 * 1000 // 48 hours
          : 35 * 60 * 1000; // 35 minutes

      this.sessionExpiresAt = Date.now() + sessionDurationMs;
      console.error(
        `[Bill.com API] Login successful (${this.authType}), session expires in ${
          this.authType === "sync_token" ? "48 hours" : "35 minutes"
        }`
      );
    } catch (error) {
      console.error("[Bill.com API] Login failed:", error);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to login to Bill.com API: ${detail}`);
    }
  }

  /**
   * Ensure we have a valid session
   */
  private async ensureSession(): Promise<void> {
    // Check if session exists and is not expired (with 5 min buffer)
    const bufferMs = 5 * 60 * 1000;
    if (this.sessionId && Date.now() < this.sessionExpiresAt - bufferMs) {
      return;
    }

    // Login to get new session
    await this.login();
  }

  /**
   * Get headers including session ID
   */
  private async getHeaders(): Promise<Record<string, string>> {
    await this.ensureSession();
    return {
      sessionId: this.sessionId!,
      devKey: this.devKey,
    };
  }

  /**
   * Handle API errors and convert to a standard format
   */
  private handleError(error: AxiosError): BillApiError {
    console.error("[Bill.com API] Error details:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    if (error.response) {
      const errorData = error.response.data as any;
      const detail =
        errorData?.message ||
        errorData?.error ||
        JSON.stringify(errorData) ||
        error.message ||
        "Unknown API error";
      return new BillApiError(
        `Bill.com API error (${error.response.status}): ${detail}`,
        error.response.status,
        "api_error"
      );
    } else if (error.request) {
      return new BillApiError(
        "No response received from Bill.com API",
        0,
        "network_error"
      );
    } else {
      return new BillApiError(
        error.message || "Unknown client error",
        0,
        "client_error"
      );
    }
  }

  /**
   * Reject endpoints that could escape the intended API path.
   *
   * Tool handlers interpolate IDs supplied by the model straight into the
   * path (e.g. `/bills/${id}`), so an ID such as `../users` would otherwise
   * reach a different endpoint. Bill.com IDs are plain alphanumeric strings.
   */
  private assertSafeEndpoint(endpoint: string): void {
    const segments = endpoint.split("/").slice(1);
    const valid =
      endpoint.startsWith("/") &&
      segments.length > 0 &&
      segments.every(
        (segment) =>
          /^[A-Za-z0-9_~.-]+$/.test(segment) && segment !== "." && segment !== ".."
      );
    if (!valid) {
      throw new BillApiError(
        `Invalid Bill.com API endpoint or ID: ${JSON.stringify(endpoint)}`,
        0,
        "client_error"
      );
    }
  }

  /**
   * Send a request, logging in again once if Bill.com rejects the session.
   *
   * Sessions can be invalidated before the expiry we track (logout, password
   * change, idle timeout on Bill.com's side), so a 401 triggers a fresh login.
   */
  private async request<T>(
    endpoint: string,
    send: (headers: Record<string, string>) => Promise<AxiosResponse<T>>
  ): Promise<T> {
    this.assertSafeEndpoint(endpoint);
    try {
      const response = await send(await this.getHeaders());
      return response.data;
    } catch (error) {
      const sessionRejected = error instanceof BillApiError && error.status === 401;
      if (!sessionRejected || this.authType === "session_token") {
        throw error;
      }
      console.error("[Bill.com API] Session rejected (401), logging in again...");
      this.sessionId = null;
      this.sessionExpiresAt = 0;
      const response = await send(await this.getHeaders());
      return response.data;
    }
  }

  /**
   * Make a GET request to the Bill.com API
   */
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<T> {
    console.error(`[Bill.com API] GET ${endpoint}`);
    return this.request(endpoint, (headers) =>
      this.client.get<T>(endpoint, { params, headers })
    );
  }

  /**
   * Make a POST request to the Bill.com API
   */
  async post<T = any>(endpoint: string, data?: Record<string, any>): Promise<T> {
    return this.request(endpoint, (headers) =>
      this.client.post<T>(endpoint, data, { headers })
    );
  }

  /**
   * Make a PUT request to the Bill.com API
   */
  async put<T = any>(endpoint: string, data?: Record<string, any>): Promise<T> {
    return this.request(endpoint, (headers) =>
      this.client.put<T>(endpoint, data, { headers })
    );
  }

  /**
   * Make a PATCH request to the Bill.com API
   */
  async patch<T = any>(endpoint: string, data?: Record<string, any>): Promise<T> {
    return this.request(endpoint, (headers) =>
      this.client.patch<T>(endpoint, data, { headers })
    );
  }

  /**
   * Make a DELETE request to the Bill.com API
   */
  async delete<T = any>(endpoint: string): Promise<T> {
    return this.request(endpoint, (headers) =>
      this.client.delete<T>(endpoint, { headers })
    );
  }
}
