import { ApiError } from "./http";
import type { Env } from "./types";

export interface RateLimitPolicy {
  scope: string;
  limit: number;
  windowSeconds: number;
}

export function rateLimitBucket(nowMs: number, windowSeconds: number): number {
  const windowMs = windowSeconds * 1000;
  return Math.floor(nowMs / windowMs) * windowMs;
}

export async function enforceRateLimit(
  env: Env,
  key: string,
  policy: RateLimitPolicy,
  nowMs = Date.now()
): Promise<void> {
  const bucketStart = rateLimitBucket(nowMs, policy.windowSeconds);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (scope, limit_key, bucket_start, request_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (scope, limit_key, bucket_start)
     DO UPDATE SET request_count = request_count + 1
     RETURNING request_count AS requestCount`
  ).bind(policy.scope, key, bucketStart).first<{ requestCount: number }>();

  if (!row || row.requestCount > policy.limit) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests; retry after the current rate-limit window");
  }
}

export async function requestClientKey(request: Request, pepper: string): Promise<string> {
  const address = request.headers.get("cf-connecting-ip")?.trim() || "local";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${address}.${pepper}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
