import { ApiError } from "./http";
import type { Env } from "./types";

const COOKIE_NAME = "alphatrack_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export interface Session {
  accountId: string;
  expiresAt: string;
}

export async function createSession(env: Env, secure: boolean): Promise<{ session: Session; cookie: string }> {
  if (!env.SESSION_PEPPER) {
    throw new ApiError(503, "SESSION_NOT_CONFIGURED", "Session security is not configured");
  }
  const token = randomToken();
  const accountId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString();
  const tokenHash = await hashToken(token, env.SESSION_PEPPER);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, cash_cents, version, created_at) VALUES (?, 10000000, 0, ?)")
      .bind(accountId, now.toISOString()),
    env.DB.prepare("INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(tokenHash, accountId, expiresAt, now.toISOString())
  ]);

  const secureAttribute = secure ? "; Secure" : "";
  const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secureAttribute}`;
  return { session: { accountId, expiresAt }, cookie };
}

export async function requireSession(request: Request, env: Env): Promise<Session> {
  if (!env.SESSION_PEPPER) {
    throw new ApiError(503, "SESSION_NOT_CONFIGURED", "Session security is not configured");
  }
  const token = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (!token) {
    throw new ApiError(401, "SESSION_REQUIRED", "Create a demo session before using the paper-trading API");
  }
  const tokenHash = await hashToken(token, env.SESSION_PEPPER);
  const row = await env.DB.prepare(
    "SELECT account_id AS accountId, expires_at AS expiresAt FROM sessions WHERE token_hash = ? AND expires_at > ?"
  ).bind(tokenHash, new Date().toISOString()).first<Session>();
  if (!row) {
    throw new ApiError(401, "SESSION_EXPIRED", "The demo session is missing or expired");
  }
  return row;
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

async function hashToken(token: string, pepper: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${token}.${pepper}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
