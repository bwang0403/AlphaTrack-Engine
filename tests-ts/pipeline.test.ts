import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, requireSession } from "../src/worker/session";
import { executeOrder, getPortfolio, listOrders, recoverStalledOrders, submitOrder } from "../src/worker/orders";
import { testEnvironment } from "./sqlite-harness";

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
  for (const fixture of opened.splice(0)) fixture.sqlite.close();
});

describe("D1 and Queue order pipeline", () => {
  it("fills buy and sell once despite an idempotent replay and duplicate queue delivery", async () => {
    const { env, messages, sqlite } = setup();
    const { session } = await createSession(env, true);
    const input = { symbol: "NVDA", side: "BUY" as const, quantity: 2, idempotencyKey: "buy-order-key-0001" };
    const first = await submitOrder(env, session.accountId, input);
    const replay = await submitOrder(env, session.accountId, input);
    expect(first.order.id).toBe(replay.order.id);
    expect(replay.replayed).toBe(true);
    expect(messages).toHaveLength(1);
    await executeOrder(env, messages[0]);
    await executeOrder(env, messages[0]);
    expect((await getPortfolio(env, session.accountId)).cashCents).toBe(9_975_000);
    expect((await getPortfolio(env, session.accountId)).positions[0].quantity).toBe(2);
    const sell = await submitOrder(env, session.accountId, { symbol: "NVDA", side: "SELL", quantity: 2, idempotencyKey: "sell-order-key-0001" });
    await executeOrder(env, messages[1]);
    expect(sell.order.status).toBe("PENDING");
    expect((await getPortfolio(env, session.accountId)).cashCents).toBe(10_000_000);
    expect((await getPortfolio(env, session.accountId)).positions).toHaveLength(0);
    expect((await listOrders(env, session.accountId)).map(order => order.status)).toEqual(["FILLED", "FILLED"]);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM trades").get() as { count: number }).count).toBe(2);
  });

  it("verifies an opaque 256-bit cookie against only a stored peppered hash", async () => {
    const { env, sqlite } = setup();
    const { session, cookie } = await createSession(env, true);
    const token = cookie.match(/^alphatrack_session=([a-f0-9]{64});/)?.[1];
    expect(token).toHaveLength(64);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const stored = sqlite.prepare("SELECT token_hash AS tokenHash FROM sessions").get() as { tokenHash: string };
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.tokenHash).not.toBe(token);
    expect((await requireSession(new Request("https://example.com", { headers: { cookie } }), env)).accountId).toBe(session.accountId);
    await expect(requireSession(new Request("https://example.com", { headers: { cookie: "alphatrack_session=invalid" } }), env)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects overspending without changing cash, positions, or trades", async () => {
    const { env, messages, sqlite } = setup();
    const { session } = await createSession(env, true);
    await submitOrder(env, session.accountId, { symbol: "NVDA", side: "BUY", quantity: 1000, idempotencyKey: "expensive-order-01" });
    await executeOrder(env, messages[0]);
    expect((await listOrders(env, session.accountId))[0]).toMatchObject({ status: "REJECTED", rejectionReason: "Insufficient buying power" });
    expect((await getPortfolio(env, session.accountId)).cashCents).toBe(10_000_000);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM trades").get() as { count: number }).count).toBe(0);
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
