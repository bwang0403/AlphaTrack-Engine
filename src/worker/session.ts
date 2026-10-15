import { ApiError } from "./http";
import type { Env } from "./types";

const COOKIE_NAME = "alphatrack_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
// Cloudflare Workers WebCrypto rejects a single PBKDF2 derivation above 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;

export interface Session {
  userId: string;
  accountId: string;
  username: string | null;
  kind: "registered" | "demo";
  expiresAt: string;
}

interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  kind: "registered";
}

function requirePepper(env: Env): string {
  if (!env.SESSION_PEPPER) throw new ApiError(503, "SESSION_NOT_CONFIGURED", "Session security is not configured");
  return env.SESSION_PEPPER;
}

export function parseCredentials(body: Record<string, unknown>): { username: string; passcode: string } {
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const passcode = body.passcode;
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    throw new ApiError(400, "INVALID_USERNAME", "Username must be 3–32 lowercase letters, digits, or underscores");
  }
  if (typeof passcode !== "string" || passcode.length < 10 || passcode.length > 128) {
    throw new ApiError(400, "INVALID_PASSCODE", "Passcode must be 10–128 characters");
  }
  return { username, passcode };
}

export async function createSession(env: Env, secure: boolean): Promise<{ session: Session; cookie: string }> {
  requirePepper(env);
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const issued = await issueSession(env, userId, null, "demo", secure);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, kind, created_at) VALUES (?, 'demo', ?)").bind(userId, now),
    env.DB.prepare("INSERT INTO accounts (id, cash_cents, version, created_at) VALUES (?, 10000000, 0, ?)").bind(userId, now),
    sessionInsert(env, issued.tokenHash, userId, issued.session.expiresAt, now)
  ]);
  return { session: issued.session, cookie: issued.cookie };
}

export async function registerUser(env: Env, credentials: { username: string; passcode: string }, secure: boolean): Promise<{ session: Session; cookie: string }> {
  requirePepper(env);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(credentials.username).first();
  if (existing) throw new ApiError(409, "USERNAME_TAKEN", "Username is already in use");
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const salt = randomToken();
  const passwordHash = await derivePasscode(credentials.passcode, salt, env.SESSION_PEPPER!);
  const issued = await issueSession(env, userId, credentials.username, "registered", secure);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, username, password_hash, password_salt, kind, created_at) VALUES (?, ?, ?, ?, 'registered', ?)")
        .bind(userId, credentials.username, passwordHash, salt, now),
      env.DB.prepare("INSERT INTO accounts (id, cash_cents, version, created_at) VALUES (?, 10000000, 0, ?)").bind(userId, now),
      sessionInsert(env, issued.tokenHash, userId, issued.session.expiresAt, now)
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: users.username/i.test(error.message)) {
      throw new ApiError(409, "USERNAME_TAKEN", "Username is already in use");
    }
    throw error;
  }
  return { session: issued.session, cookie: issued.cookie };
}

export async function loginUser(env: Env, credentials: { username: string; passcode: string }, secure: boolean): Promise<{ session: Session; cookie: string }> {
  requirePepper(env);
  const user = await env.DB.prepare(
    "SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt, kind FROM users WHERE username = ? AND kind = 'registered'"
  ).bind(credentials.username).first<UserRow>();
  const actual = await derivePasscode(credentials.passcode, user?.passwordSalt ?? "0".repeat(64), env.SESSION_PEPPER!);
  if (!user || !constantTimeEqual(actual, user.passwordHash)) throw new ApiError(401, "INVALID_CREDENTIALS", "Username or passcode is incorrect");
  const issued = await issueSession(env, user.id, user.username, user.kind, secure);
  await sessionInsert(env, issued.tokenHash, user.id, issued.session.expiresAt, new Date().toISOString()).run();
  return { session: issued.session, cookie: issued.cookie };
}

export async function requireSession(request: Request, env: Env): Promise<Session> {
  const pepper = requirePepper(env);
  const token = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, "SESSION_REQUIRED", "Sign in before using the paper-trading API");
  const tokenHash = await hashToken(token, pepper);
  const row = await env.DB.prepare(
    `SELECT sessions.user_id AS userId, sessions.account_id AS accountId, users.username,
            users.kind, sessions.expires_at AS expiresAt
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.account_id = users.id`
  ).bind(tokenHash, new Date().toISOString()).first<Session>();
  if (!row) throw new ApiError(401, "SESSION_EXPIRED", "Sign-in session is missing or expired");
  return row;
}

export async function logoutUser(request: Request, env: Env, secure: boolean): Promise<string> {
  const token = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token, requirePepper(env))).run();
  }
  return cookieHeader("", secure, 0);
}

function sessionInsert(env: Env, tokenHash: string, userId: string, expiresAt: string, createdAt: string): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO sessions (token_hash, account_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(tokenHash, userId, userId, expiresAt, createdAt);
}

async function issueSession(env: Env, userId: string, username: string | null, kind: Session["kind"], secure: boolean) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  return {
    session: { userId, accountId: userId, username, kind, expiresAt },
    tokenHash: await hashToken(token, requirePepper(env)),
    cookie: cookieHeader(token, secure, SESSION_SECONDS)
  };
}

function cookieHeader(token: string, secure: boolean, maxAge: number): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}.${pepper}`));
  return hex(new Uint8Array(digest));
}

async function derivePasscode(passcode: string, salt: string, pepper: string): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${passcode}.${pepper}`), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: PASSWORD_ITERATIONS, hash: "SHA-256" }, material, 256);
  return hex(new Uint8Array(bits));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
