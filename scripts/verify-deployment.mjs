import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.argv[2];
const mode = process.argv[3] ?? "read";
if (!base || !["read", "full", "auth"].includes(mode)) {
  throw new Error("Usage: node scripts/verify-deployment.mjs <base-url> [read|full|auth]");
}
const origin = new URL(base).origin;
let cookie = "";

async function call(path, init = {}) {
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers: { ...(cookie ? { cookie } : {}), ...init.headers }
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return response;
}

async function json(path, init, expected) {
  const response = await call(path, init);
  assert.equal(response.status, expected, `${path}: expected ${expected}, got ${response.status}`);
  return response.json();
}

const page = await call("/");
assert.equal(page.status, 200);
const html = await page.text();
const scriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
assert.ok(scriptPath, "Built JavaScript asset is linked from the page");
const asset = await call(scriptPath);
assert.equal(asset.status, 200);
const bundle = await asset.text();
for (const marker of ["INSTANT DEMO ACCOUNT SIGN-IN", "LIVE D1 ORDER STATES", "AUTHENTICATION AND RATE LIMITS"]) {
  assert.ok(bundle.includes(marker), `Missing live UI marker: ${marker}`);
}

const health = await json("/api/health", undefined, 200);
assert.equal(health.status, "ok");
await json("/api/auth/me", undefined, 401);
const demo = await json("/api/auth/demo", { method: "POST" }, 201);
assert.equal(demo.user.kind, "demo");
const current = await json("/api/auth/me", undefined, 200);
assert.equal(current.user.id, demo.user.id);
const system = await json("/api/system", undefined, 200);
assert.equal(system.database, "ok");
assert.equal(system.session.userId, demo.user.id);
assert.equal(system.session.authenticated, true);
assert.equal(typeof system.orderCounts.FILLED, "number");
assert.equal(system.queue.depth, null);
const market = await json("/api/market/NVDA?period=5d", undefined, 200);
assert.equal(market.feed, "iex");
assert.ok(["LIVE", "DELAYED", "STALE"].includes(market.freshness));
assert.ok(market.bars.length >= 2);

if (mode === "full") {
  async function submit(side, idempotencyKey, expected) {
    return json("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "NVDA", side, quantity: 1, idempotencyKey })
    }, expected);
  }
  async function waitForFill(id) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const { orders } = await json("/api/orders", undefined, 200);
      const order = orders.find(item => item.id === id);
      if (order?.status === "FILLED") return order;
      if (order?.status === "REJECTED") throw new Error(`Paper order rejected: ${order.rejectionReason}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Paper order did not fill within 15 seconds");
  }
  for (const side of ["BUY", "SELL"]) {
    const key = randomUUID();
    const first = await submit(side, key, 202);
    const replay = await submit(side, key, 200);
    assert.equal(replay.replayed, true);
    assert.equal(first.order.id, replay.order.id);
    await waitForFill(first.order.id);
  }
  const portfolio = await json("/api/portfolio", undefined, 200);
  assert.equal(portfolio.positions.length, 0);
  const final = await json("/api/system", undefined, 200);
  assert.equal(final.orderCounts.FILLED, 2);
}

if (mode === "auth") {
  const username = `verify_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const passcode = `verify-${randomUUID()}`;
  const body = JSON.stringify({ username, passcode });
  const registered = await json("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body }, 201);
  assert.equal(registered.user.kind, "registered");
  assert.equal((await json("/api/auth/me", undefined, 200)).user.id, registered.user.id);
  await json("/api/auth/logout", { method: "POST" }, 200);
  await json("/api/auth/me", undefined, 401);
  const loggedIn = await json("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body }, 200);
  assert.equal(loggedIn.user.id, registered.user.id);
  assert.equal((await json("/api/system", undefined, 200)).session.kind, "registered");
}

console.log(JSON.stringify({
  base: origin,
  mode,
  appAsset: "ok",
  health: health.status,
  authenticatedUser: "ok",
  system: "ok",
  alpacaFeed: market.feed,
  freshness: market.freshness,
  buySellReplay: mode === "full" ? "ok" : "not requested",
  registeredLogin: mode === "auth" ? "ok" : "not requested"
}));
