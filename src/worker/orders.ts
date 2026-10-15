import { ApiError } from "./http";
import { planExecution } from "./ledger";
import { AlpacaMarketData } from "./market";
import type { Env, OrderCommand, OrderSide, OrderStatus } from "./types";

interface OrderRow {
  id: string;
  accountId: string;
  idempotencyKey: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  status: OrderStatus;
  requestedAt: string;
  updatedAt: string;
  filledPriceCents: number | null;
  rejectionReason: string | null;
}

type PublicOrder = Omit<OrderRow, "accountId">;

interface TradeRow {
  symbol: string;
  side: OrderSide;
  quantity: number;
  priceCents: number;
}

interface AccountRow {
  id: string;
  cashCents: number;
  version: number;
}

interface PositionRow {
  symbol: string;
  quantity: number;
  averageCostCents: number;
  version: number;
}

export async function submitOrder(
  env: Env,
  accountId: string,
  input: { symbol: string; side: OrderSide; quantity: number; idempotencyKey: string }
): Promise<{ order: PublicOrder; replayed: boolean }> {
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders
      (id, account_id, idempotency_key, symbol, side, order_type, quantity, status, requested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'MARKET', ?, 'PENDING', ?, ?)`
  ).bind(orderId, accountId, input.idempotencyKey, input.symbol, input.side, input.quantity, now, now).run();

  const order = await findOrderByIdempotencyKey(env, accountId, input.idempotencyKey);
  if (!order) throw new ApiError(500, "ORDER_CREATE_FAILED", "The order could not be created");
  const created = result.meta.changes === 1;
  if (!created && (order.symbol !== input.symbol || order.side !== input.side || order.quantity !== input.quantity)) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different order");
  }
  if (created) await env.ORDER_QUEUE.send({ orderId: order.id, accountId });
  return { order: toPublicOrder(order), replayed: !created };
}

export async function listOrders(env: Env, accountId: string): Promise<PublicOrder[]> {
  return (await listOrdersPage(env, accountId)).orders;
}

export async function listOrdersPage(env: Env, accountId: string, cursor: string | null = null): Promise<{ orders: PublicOrder[]; nextCursor: string | null }> {
  let result: D1Result<OrderRow>;
  if (cursor !== null) {
    const anchor = await findOrder(env, cursor, accountId);
    if (!anchor) throw new ApiError(400, "INVALID_ORDER_CURSOR", "Order cursor is invalid");
    result = await env.DB.prepare(
      `${ORDER_SELECT} WHERE account_id = ? AND (requested_at < ? OR (requested_at = ? AND id < ?)) ORDER BY requested_at DESC, id DESC LIMIT 101`
    ).bind(accountId, anchor.requestedAt, anchor.requestedAt, anchor.id).all<OrderRow>();
  } else {
    result = await env.DB.prepare(
      `${ORDER_SELECT} WHERE account_id = ? ORDER BY requested_at DESC, id DESC LIMIT 101`
    ).bind(accountId).all<OrderRow>();
  }
  const page = result.results.slice(0, 100);
  return { orders: page.map(toPublicOrder), nextCursor: result.results.length > 100 ? page[page.length - 1].id : null };
}

export async function getOrder(env: Env, accountId: string, orderId: string): Promise<PublicOrder> {
  const order = await findOrder(env, orderId, accountId);
  if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order was not found");
  return toPublicOrder(order);
}

export async function recoverStalledOrders(env: Env, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const stale = await env.DB.prepare(
    "SELECT id, account_id AS accountId FROM orders WHERE status IN ('PENDING', 'PROCESSING') AND updated_at < ? ORDER BY updated_at LIMIT 100"
  ).bind(cutoff).all<{ id: string; accountId: string }>();
  let requeued = 0;
  for (const order of stale.results) {
    const result = await env.DB.prepare(
      "UPDATE orders SET status = 'PENDING', updated_at = ? WHERE id = ? AND status IN ('PENDING', 'PROCESSING') AND updated_at < ?"
    ).bind(now.toISOString(), order.id, cutoff).run();
    if (result.meta.changes !== 1) continue;
    await env.ORDER_QUEUE.send({ orderId: order.id, accountId: order.accountId });
    requeued += 1;
  }
  return requeued;
}

export async function getPortfolio(env: Env, accountId: string): Promise<{
  cashCents: number;
  version: number;
  realizedPnlCents: number;
  positions: PositionRow[];
}> {
  const account = await env.DB.prepare(
    "SELECT id, cash_cents AS cashCents, version FROM accounts WHERE id = ?"
  ).bind(accountId).first<AccountRow>();
  if (!account) throw new ApiError(404, "ACCOUNT_NOT_FOUND", "Demo account was not found");
  const positions = await env.DB.prepare(
    `SELECT symbol, quantity, average_cost_cents AS averageCostCents, version
     FROM positions WHERE account_id = ? AND quantity > 0 ORDER BY symbol`
  ).bind(accountId).all<PositionRow>();
  // Row insertion order is the ledger's fill order, including fills sharing a timestamp.
  const trades = await env.DB.prepare(
    "SELECT symbol, side, quantity, price_cents AS priceCents FROM trades WHERE account_id = ? ORDER BY rowid ASC"
  ).bind(accountId).all<TradeRow>();
  return {
    cashCents: account.cashCents,
    version: account.version,
    realizedPnlCents: calculateRealizedPnlCents(trades.results),
    positions: positions.results
  };
}

function calculateRealizedPnlCents(trades: TradeRow[]): number {
  const holdings = new Map<string, { quantity: number; averageCostCents: number }>();
  let realized = 0;
  for (const trade of trades) {
    const held = holdings.get(trade.symbol) ?? { quantity: 0, averageCostCents: 0 };
    const amount = trade.priceCents * trade.quantity;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new ApiError(500, "LEDGER_VALUE_INVALID", "A ledger value is outside the supported range");
    if (trade.side === "BUY") {
      const quantity = held.quantity + trade.quantity;
      const weightedCost = held.averageCostCents * held.quantity + amount;
      if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(weightedCost)) throw new ApiError(500, "LEDGER_VALUE_INVALID", "A ledger value is outside the supported range");
      holdings.set(trade.symbol, { quantity, averageCostCents: Math.round(weightedCost / quantity) });
    } else {
      if (held.quantity < trade.quantity) throw new ApiError(500, "LEDGER_HISTORY_INVALID", "Ledger fill history is inconsistent");
      realized += (trade.priceCents - held.averageCostCents) * trade.quantity;
      if (!Number.isSafeInteger(realized)) throw new ApiError(500, "LEDGER_VALUE_INVALID", "A ledger value is outside the supported range");
      holdings.set(trade.symbol, { ...held, quantity: held.quantity - trade.quantity });
    }
  }
  return realized;
}

export async function executeOrder(env: Env, command: OrderCommand): Promise<void> {
  const order = await findOrder(env, command.orderId, command.accountId);
  if (!order || order.status === "FILLED" || order.status === "REJECTED") return;

  const claimed = await env.DB.prepare(
    "UPDATE orders SET status = 'PROCESSING', updated_at = ? WHERE id = ? AND account_id = ? AND status = 'PENDING'"
  ).bind(new Date().toISOString(), order.id, order.accountId).run();
  if (claimed.meta.changes !== 1) return;

  try {
    const priceCents = await new AlpacaMarketData(env).latestPriceCents(order.symbol);
    const account = await env.DB.prepare(
      "SELECT id, cash_cents AS cashCents, version FROM accounts WHERE id = ?"
    ).bind(order.accountId).first<AccountRow>();
    const position = await env.DB.prepare(
      `SELECT symbol, quantity, average_cost_cents AS averageCostCents, version
       FROM positions WHERE account_id = ? AND symbol = ?`
    ).bind(order.accountId, order.symbol).first<PositionRow>();
    if (!account) return rejectOrder(env, order.id, "Account was not found");

    const plan = planExecution({
      side: order.side,
      quantity: order.quantity,
      priceCents,
      cashCents: account.cashCents,
      position
    });
    if (!plan.accepted) return rejectOrder(env, order.id, plan.reason);

    const now = new Date().toISOString();
    const tradeId = crypto.randomUUID();
    if (order.side === "BUY") {
      await env.DB.batch([
        insertTradeStatement(env, tradeId, order, priceCents, now),
        env.DB.prepare("UPDATE accounts SET cash_cents = cash_cents - ?, version = version + 1 WHERE id = ? AND cash_cents >= ? AND EXISTS (SELECT 1 FROM trades WHERE id = ?)")
          .bind(plan.totalCents, order.accountId, plan.totalCents, tradeId),
        env.DB.prepare(
          `INSERT INTO positions (account_id, symbol, quantity, average_cost_cents, version)
           SELECT ?, ?, ?, ?, 0 FROM trades WHERE id = ?
           ON CONFLICT(account_id, symbol) DO UPDATE SET
             quantity = excluded.quantity,
             average_cost_cents = excluded.average_cost_cents,
             version = positions.version + 1`
        ).bind(order.accountId, order.symbol, plan.nextQuantity, plan.nextAverageCostCents, tradeId),
        fillOrderStatement(env, order.id, priceCents, now, tradeId)
      ]);
    } else {
      await env.DB.batch([
        insertTradeStatement(env, tradeId, order, priceCents, now),
        env.DB.prepare("UPDATE accounts SET cash_cents = cash_cents + ?, version = version + 1 WHERE id = ? AND EXISTS (SELECT 1 FROM trades WHERE id = ?)")
          .bind(plan.totalCents, order.accountId, tradeId),
        env.DB.prepare(
          "UPDATE positions SET quantity = quantity - ?, version = version + 1 WHERE account_id = ? AND symbol = ? AND quantity >= ? AND EXISTS (SELECT 1 FROM trades WHERE id = ?)"
        ).bind(order.quantity, order.accountId, order.symbol, order.quantity, tradeId),
        fillOrderStatement(env, order.id, priceCents, now, tradeId)
      ]);
    }
  } catch (error) {
    try {
      await env.DB.prepare(
        "UPDATE orders SET status = 'PENDING', updated_at = ? WHERE id = ? AND status = 'PROCESSING'"
      ).bind(new Date().toISOString(), order.id).run();
    } catch (resetError) {
      console.error(JSON.stringify({ event: "order.reset_failed", orderId: order.id, error: resetError instanceof Error ? resetError.message : "unknown" }));
    }
    throw error;
  }
}

const ORDER_SELECT = `SELECT id, account_id AS accountId, idempotency_key AS idempotencyKey,
  symbol, side, quantity, status, requested_at AS requestedAt, updated_at AS updatedAt,
  filled_price_cents AS filledPriceCents, rejection_reason AS rejectionReason FROM orders`;

async function findOrder(env: Env, orderId: string, accountId: string): Promise<OrderRow | null> {
  return env.DB.prepare(`${ORDER_SELECT} WHERE id = ? AND account_id = ?`)
    .bind(orderId, accountId).first<OrderRow>();
}

async function findOrderByIdempotencyKey(env: Env, accountId: string, key: string): Promise<OrderRow | null> {
  return env.DB.prepare(`${ORDER_SELECT} WHERE account_id = ? AND idempotency_key = ?`)
    .bind(accountId, key).first<OrderRow>();
}

async function rejectOrder(env: Env, orderId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE orders SET status = 'REJECTED', rejection_reason = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING'"
  ).bind(reason, new Date().toISOString(), orderId).run();
}

function fillOrderStatement(env: Env, orderId: string, priceCents: number, now: string, tradeId: string): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE orders SET status = 'FILLED', filled_price_cents = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING' AND EXISTS (SELECT 1 FROM trades WHERE id = ?)"
  ).bind(priceCents, now, orderId, tradeId);
}

function insertTradeStatement(env: Env, tradeId: string, order: OrderRow, priceCents: number, now: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO trades (id, order_id, account_id, symbol, side, quantity, price_cents, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(tradeId, order.id, order.accountId, order.symbol, order.side, order.quantity, priceCents, now);
}

function toPublicOrder(order: OrderRow): PublicOrder {
  const { accountId: _accountId, ...safe } = order;
  return safe;
}
