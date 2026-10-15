import { ApiError, json, problem, readJson } from "./http";
import { AlpacaMarketData } from "./market";
import { executeOrder, getPortfolio, listOrders, recoverStalledOrders, submitOrder } from "./orders";
import { enforceRateLimit, requestClientKey } from "./rate-limit";
import { createSession, loginUser, logoutUser, parseCredentials, registerUser, requireSession } from "./session";
import type { Env, OrderCommand } from "./types";
import { parseOrder, parsePeriod, parseSymbol } from "./validation";

const worker: ExportedHandler<Env, OrderCommand> = {
  async fetch(request, env): Promise<Response> {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const started = Date.now();
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: allowHeaders() });

      let response: Response;
      if (url.pathname === "/api/health" && request.method === "GET") {
        await env.DB.prepare("SELECT 1").first();
        response = json({ status: "ok", environment: env.APP_ENV, timestamp: new Date().toISOString() });
      } else if ((url.pathname === "/api/session" || url.pathname === "/api/auth/me") && request.method === "GET") {
        const session = await requireSession(request, env);
        response = json({ user: { id: session.userId, username: session.username, kind: session.kind }, session: { expiresAt: session.expiresAt } });
      } else if ((url.pathname === "/api/session" || url.pathname === "/api/auth/demo") && request.method === "POST") {
        await enforceRateLimit(env, await requestClientKey(request, env.SESSION_PEPPER ?? "unconfigured"), { scope: "session:create", limit: 10, windowSeconds: 3600 });
        const result = await createSession(env, url.protocol === "https:");
        response = json({ user: { id: result.session.userId, username: null, kind: "demo" }, session: { expiresAt: result.session.expiresAt }, account: { startingCash: 100000 } }, 201, {
          "set-cookie": result.cookie
        });
      } else if (url.pathname === "/api/auth/register" && request.method === "POST") {
        await enforceRateLimit(env, await requestClientKey(request, env.SESSION_PEPPER ?? "unconfigured"), { scope: "auth:register", limit: 5, windowSeconds: 3600 });
        const result = await registerUser(env, parseCredentials(await readJson(request)), url.protocol === "https:");
        response = json({ user: { id: result.session.userId, username: result.session.username, kind: "registered" }, session: { expiresAt: result.session.expiresAt } }, 201, {
          "set-cookie": result.cookie
        });
      } else if (url.pathname === "/api/auth/login" && request.method === "POST") {
        await enforceRateLimit(env, await requestClientKey(request, env.SESSION_PEPPER ?? "unconfigured"), { scope: "auth:login", limit: 10, windowSeconds: 3600 });
        const result = await loginUser(env, parseCredentials(await readJson(request)), url.protocol === "https:");
        response = json({ user: { id: result.session.userId, username: result.session.username, kind: "registered" }, session: { expiresAt: result.session.expiresAt } }, 200, {
          "set-cookie": result.cookie
        });
      } else if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        response = json({ signedOut: true }, 200, { "set-cookie": await logoutUser(request, env, url.protocol === "https:") });
      } else if (url.pathname.startsWith("/api/market/") && request.method === "GET") {
        await enforceRateLimit(env, await requestClientKey(request, env.SESSION_PEPPER ?? "unconfigured"), { scope: "market:read", limit: 120, windowSeconds: 60 });
        const symbol = parseSymbol(decodeURIComponent(url.pathname.slice("/api/market/".length)));
        const period = parsePeriod(url.searchParams.get("period"));
        response = json(await new AlpacaMarketData(env).history(symbol, period));
      } else if (url.pathname === "/api/portfolio" && request.method === "GET") {
        const session = await requireSession(request, env);
        response = json(await getPortfolio(env, session.userId));
      } else if (url.pathname === "/api/orders" && request.method === "GET") {
        const session = await requireSession(request, env);
        response = json({ orders: await listOrders(env, session.userId) });
      } else if (url.pathname === "/api/orders" && request.method === "POST") {
        const session = await requireSession(request, env);
        await enforceRateLimit(env, session.userId, { scope: "order:create", limit: 30, windowSeconds: 60 });
        const input = parseOrder(await readJson(request));
        const result = await submitOrder(env, session.userId, input);
        response = json({ order: result.order, replayed: result.replayed }, result.replayed ? 200 : 202);
      } else if (url.pathname === "/api/system" && request.method === "GET") {
        const session = await requireSession(request, env);
        const counts = await env.DB.prepare(
          "SELECT status, COUNT(*) AS count FROM orders WHERE account_id = ? GROUP BY status"
        ).bind(session.userId).all<{ status: string; count: number }>();
        response = json({
          observedAt: new Date().toISOString(),
          database: "ok",
          session: { authenticated: true, kind: session.kind, userId: session.userId, expiresAt: session.expiresAt },
          orderCounts: Object.fromEntries(["PENDING", "PROCESSING", "FILLED", "REJECTED"].map(status =>
            [status, counts.results.find(row => row.status === status)?.count ?? 0])),
          queue: { configured: Boolean(env.ORDER_QUEUE), depth: null, dlqDepth: null },
          rateLimits: { registrationPerHour: 5, loginPerHour: 10, demoPerHour: 10, marketPerMinute: 120, ordersPerMinute: 30 }
        });
      } else if (url.pathname.startsWith("/api/")) {
        response = problem(404, "ROUTE_NOT_FOUND", "API route was not found", requestId);
      } else {
        response = await env.ASSETS.fetch(request);
      }
      console.log(JSON.stringify({ event: "request.complete", requestId, method: request.method, path: url.pathname, status: response.status, durationMs: Date.now() - started }));
      return withRequestHeaders(response, requestId);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred");
      console.error(JSON.stringify({ event: "request.error", requestId, code: apiError.code, status: apiError.status, durationMs: Date.now() - started }));
      return withRequestHeaders(problem(apiError.status, apiError.code, apiError.message, requestId), requestId);
    }
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await executeOrder(env, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "order.retry", orderId: message.body.orderId, error: error instanceof Error ? error.message : "unknown" }));
        message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
      }
    }
  },

  async scheduled(controller, env): Promise<void> {
    const requeued = await recoverStalledOrders(env);
    console.log(JSON.stringify({ event: "order.recovery", requeued }));
    if (controller.cron !== "0 4 * * *") return;
    const now = new Date();
    const accountCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rateLimitCutoff = now.getTime() - 2 * 24 * 60 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()),
      env.DB.prepare(
        "DELETE FROM accounts WHERE created_at < ? AND id IN (SELECT id FROM users WHERE kind = 'demo') AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.account_id = accounts.id) AND NOT EXISTS (SELECT 1 FROM trades WHERE trades.account_id = accounts.id)"
      ).bind(accountCutoff),
      env.DB.prepare("DELETE FROM users WHERE kind = 'demo' AND id NOT IN (SELECT id FROM accounts)"),
      env.DB.prepare("DELETE FROM rate_limits WHERE bucket_start < ?").bind(rateLimitCutoff)
    ]);
  }
};

function withRequestHeaders(response: Response, requestId: string): Response {
  const wrapped = new Response(response.body, response);
  wrapped.headers.set("x-request-id", requestId);
  wrapped.headers.set("x-frame-options", "DENY");
  wrapped.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return wrapped;
}

function allowHeaders(): HeadersInit {
  return {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  };
}

export default worker;
