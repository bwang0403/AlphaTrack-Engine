import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, requireSession } from "../src/worker/session";
import { executeOrder, getPortfolio, listOrders, recoverStalledOrders, submitOrder } from "../src/worker/orders";
import { testEnvironment } from "./sqlite-harness";
import worker from "../src/worker/index";
import type { OrderCommand } from "../src/worker/types";

const opened: ReturnType<typeof testEnvironment>[] = [];
function setup() {
  const result = testEnvironment();
  opened.push(result);
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    latestTrade: { p: 125, t: "2026-09-16T20:00:00Z" }
  }), { status: 200 })));
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const fixture of opened.splice(0)) fixture.sqlite.close();
});

describe("D1 and Queue order pipeline", () => {
  it("validates HTTP auth → order route → Queue consumer → D1 buy/sell fills and both idempotent replays", async () => {
    const { env, messages, sqlite } = setup();
    const route = (path: string, init?: RequestInit) => worker.fetch!(
      new Request(`https://example.com${path}`, init) as Parameters<NonNullable<typeof worker.fetch>>[0], env, {} as ExecutionContext
    );
    expect((await route("/api/orders", { method: "POST" })).status).toBe(401);
    expect((await route("/api/system")).status).toBe(401);
    const signIn = await route("/api/auth/demo", { method: "POST" });
    expect(signIn.status).toBe(201);
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
    const auth = { cookie, "content-type": "application/json" };
    const submit = (side: "BUY" | "SELL", key: string) => route("/api/orders", {
      method: "POST", headers: auth, body: JSON.stringify({ symbol: "NVDA", side, quantity: 2, idempotencyKey: key })
    });
    const buy = await submit("BUY", "buy-order-key-0001");
    const buyBody = await buy.json() as { order: { id: string; idempotencyKey: string }; replayed: boolean };
    expect(buy.status).toBe(202);
    expect(buyBody.order.idempotencyKey).toBe("buy-order-key-0001");
    const buyReplay = await submit("BUY", "buy-order-key-0001");
    expect(buyReplay.status).toBe(200);
    expect(await buyReplay.json()).toMatchObject({ order: { id: buyBody.order.id }, replayed: true });
    expect(messages).toHaveLength(1);
    const consume = async (command: OrderCommand) => {
      const ack = vi.fn();
      await worker.queue!({ messages: [{ body: command, attempts: 1, ack, retry: vi.fn() }] } as unknown as MessageBatch<OrderCommand>, env, {} as ExecutionContext);
      expect(ack).toHaveBeenCalledOnce();
    };
    await consume(messages[0]);
    await consume(messages[0]);
    const afterBuy = await route("/api/portfolio", { headers: { cookie } });
    expect(await afterBuy.json()).toMatchObject({ cashCents: 9_975_000, realizedPnlCents: 0, positions: [{ quantity: 2 }] });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ latestTrade: { p: 135, t: "2026-09-16T20:00:00Z" } }), { status: 200 })));
    const sell = await submit("SELL", "sell-order-key-0001");
    const sellBody = await sell.json() as { order: { id: string; idempotencyKey: string } };
    expect(sell.status).toBe(202);
    expect(sellBody.order.idempotencyKey).toBe("sell-order-key-0001");
    const sellReplay = await submit("SELL", "sell-order-key-0001");
    expect(sellReplay.status).toBe(200);
    expect(await sellReplay.json()).toMatchObject({ order: { id: sellBody.order.id }, replayed: true });
    expect(messages).toHaveLength(2);
    await consume(messages[1]);
    await consume(messages[1]);
    const portfolio = await route("/api/portfolio", { headers: { cookie } });
    expect(await portfolio.json()).toMatchObject({ cashCents: 10_002_000, realizedPnlCents: 2_000, positions: [] });
    const orders = await route("/api/orders", { headers: { cookie } });
    const orderHistory = (await orders.json() as { orders: Array<{ status: string; idempotencyKey: string }> }).orders;
    expect(orderHistory.map(order => order.status)).toEqual(["FILLED", "FILLED"]);
    expect(orderHistory.map(order => order.idempotencyKey)).toEqual(["sell-order-key-0001", "buy-order-key-0001"]);
    const single = await route(`/api/orders/${buyBody.order.id}`, { headers: { cookie } });
    expect(await single.json()).toMatchObject({ order: { id: buyBody.order.id, idempotencyKey: "buy-order-key-0001" } });
    const filledReplay = await submit("SELL", "sell-order-key-0001");
    expect(filledReplay.status).toBe(200);
    expect(await filledReplay.json()).toMatchObject({ replayed: true, order: { id: sellBody.order.id } });
    expect((await (await route("/api/portfolio", { headers: { cookie } })).json())).toMatchObject({ cashCents: 10_002_000, realizedPnlCents: 2_000 });
    expect(messages).toHaveLength(2);
    const system = await route("/api/system", { headers: { cookie } });
    expect(await system.json()).toMatchObject({ database: "ok", session: { authenticated: true }, orderCounts: { FILLED: 2, PENDING: 0 } });
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM trades").get() as { count: number }).count).toBe(2);
  });

  it("registers and logs in a user with a 256-bit hashed cookie and user-scoped ledger", async () => {
    const { env, sqlite } = setup();
    const route = (path: string, init?: RequestInit) => worker.fetch!(
      new Request(`https://example.com${path}`, init) as Parameters<NonNullable<typeof worker.fetch>>[0], env, {} as ExecutionContext
    );
    const credentials = { username: "alice_test", passcode: "strong-passcode-123" };
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    const register = await route("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
    expect(register.status).toBe(201);
    expect(deriveBits).toHaveBeenCalledWith(expect.objectContaining({ name: "PBKDF2", iterations: 100_000, hash: "SHA-256" }), expect.anything(), 256);
    const registered = await register.json() as { user: { id: string; kind: string } };
    expect(registered.user.kind).toBe("registered");
    const cookie = register.headers.get("set-cookie")!;
    const token = cookie.match(/^alphatrack_session=([a-f0-9]{64});/)?.[1];
    expect(token).toHaveLength(64);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const stored = sqlite.prepare("SELECT token_hash AS tokenHash FROM sessions WHERE user_id = ?").get(registered.user.id) as { tokenHash: string };
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.tokenHash).not.toBe(token);
    const password = sqlite.prepare("SELECT password_hash AS hash, password_salt AS salt FROM users WHERE id = ?").get(registered.user.id) as { hash: string; salt: string };
    expect(password.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(password.hash).not.toBe(credentials.passcode);
    expect(password.salt).toMatch(/^[a-f0-9]{64}$/);
    expect((await requireSession(new Request("https://example.com", { headers: { cookie } }), env)).userId).toBe(registered.user.id);
    await expect(requireSession(new Request("https://example.com", { headers: { cookie: "alphatrack_session=invalid" } }), env)).rejects.toMatchObject({ status: 401 });
    const signOut = await route("/api/auth/logout", { method: "POST", headers: { cookie } });
    expect(signOut.status).toBe(200);
    expect((await route("/api/portfolio", { headers: { cookie } })).status).toBe(401);
    const badLogin = await route("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...credentials, passcode: "wrong-passcode-123" }) });
    expect(badLogin.status).toBe(401);
    const login = await route("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
    expect(login.status).toBe(200);
    const loginCookie = login.headers.get("set-cookie")!;
    expect((await route("/api/portfolio", { headers: { cookie: loginCookie } })).status).toBe(200);
    const registeredOrder = await route("/api/orders", {
      method: "POST", headers: { cookie: loginCookie, "content-type": "application/json" },
      body: JSON.stringify({ symbol: "NVDA", side: "BUY", quantity: 1, idempotencyKey: "registered-user-key-01" })
    });
    expect(registeredOrder.status).toBe(202);
    const another = await route("/api/auth/demo", { method: "POST" });
    const anotherCookie = another.headers.get("set-cookie")!;
    expect((await route("/api/system", { headers: { cookie: anotherCookie } })).status).toBe(200);
    expect((await requireSession(new Request("https://example.com", { headers: { cookie: anotherCookie } }), env)).userId).not.toBe(registered.user.id);
    expect(await (await route("/api/orders", { headers: { cookie: anotherCookie } })).json()).toEqual({ orders: [] });
    expect((await route(`/api/orders/${(await registeredOrder.json() as { order: { id: string } }).order.id}`, { headers: { cookie: anotherCookie } })).status).toBe(404);
    expect(await (await route("/api/portfolio", { headers: { cookie: anotherCookie } })).json()).toMatchObject({ realizedPnlCents: 0 });
  });

  it("rejects overspending and computes realized P&L from weighted-cost partial sells", async () => {
    const { env, messages, sqlite } = setup();
    const { session } = await createSession(env, true);
    await submitOrder(env, session.accountId, { symbol: "NVDA", side: "BUY", quantity: 1000, idempotencyKey: "expensive-order-01" });
    await executeOrder(env, messages[0]);
    expect((await listOrders(env, session.accountId))[0]).toMatchObject({ status: "REJECTED", rejectionReason: "Insufficient buying power" });
    expect((await getPortfolio(env, session.accountId)).cashCents).toBe(10_000_000);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM trades").get() as { count: number }).count).toBe(0);
    for (const [price, key, side, quantity] of [
      [100, "first-weighted-buy", "BUY", 2],
      [150, "second-weighted-buy", "BUY", 2],
      [200, "partial-profit-sell", "SELL", 1]
    ] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ latestTrade: { p: price, t: "2026-09-16T20:00:00Z" } }))));
      await submitOrder(env, session.accountId, { symbol: "NVDA", side, quantity, idempotencyKey: key });
      await executeOrder(env, messages.at(-1)!);
    }
    expect(await getPortfolio(env, session.accountId)).toMatchObject({
      cashCents: 9_970_000,
      realizedPnlCents: 7_500,
      positions: [{ symbol: "NVDA", quantity: 3, averageCostCents: 12_500 }]
    });
  });

  it("rejects a reused idempotency key with a different order payload", async () => {
    const { env, messages } = setup();
    const { session } = await createSession(env, true);
    await submitOrder(env, session.accountId, { symbol: "NVDA", side: "BUY", quantity: 1, idempotencyKey: "same-key-new-payload" });
    await expect(submitOrder(env, session.accountId, { symbol: "NVDA", side: "SELL", quantity: 1, idempotencyKey: "same-key-new-payload" })).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(messages).toHaveLength(1);
  });

  it("returns a failed provider call to PENDING for retry without ledger mutation", async () => {
    const { env, messages } = setup();
    const { session } = await createSession(env, true);
    await submitOrder(env, session.accountId, { symbol: "NVDA", side: "BUY", quantity: 1, idempotencyKey: "provider-fails-0001" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(executeOrder(env, messages[0])).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect((await listOrders(env, session.accountId))[0].status).toBe("PENDING");
    expect((await getPortfolio(env, session.accountId)).cashCents).toBe(10_000_000);
  });

  it("recovers a stalled claim without double-debiting when the original worker resumes", async () => {
    const { env, messages, sqlite } = setup();
    const { session } = await createSession(env, true);
    await submitOrder(env, session.accountId, { symbol: "NVDA", side: "BUY", quantity: 1, idempotencyKey: "stalled-order-0001" });
    let releaseFirst!: (response: Response) => void;
    let fetchCount = 0;
    const response = () => new Response(JSON.stringify({ latestTrade: { p: 125, t: "2026-09-16T20:00:00Z" } }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      fetchCount += 1;
      return fetchCount === 1 ? new Promise<Response>(resolve => { releaseFirst = resolve; }) : Promise.resolve(response());
    }));
    const originalExecution = executeOrder(env, messages[0]);
    await vi.waitFor(() => expect(fetchCount).toBe(1));
    expect(await recoverStalledOrders(env, new Date(Date.now() + 11 * 60_000))).toBe(1);
    expect(messages).toHaveLength(2);
    await executeOrder(env, messages[1]);
    releaseFirst(response());
    await originalExecution;
    expect((await listOrders(env, session.accountId))[0].status).toBe("FILLED");
    expect((await getPortfolio(env, session.accountId)).cashCents).toBe(9_987_500);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM trades").get() as { count: number }).count).toBe(1);
  });
});
