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

type PublicOrder = Omit<OrderRow, "accountId" | "idempotencyKey">;

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
  if (created) await env.ORDER_QUEUE.send({ orderId: order.id, accountId });
  return { order: toPublicOrder(order), replayed: !created };
}

export async function listOrders(env: Env, accountId: string): Promise<PublicOrder[]> {
  const result = await env.DB.prepare(
    `${ORDER_SELECT} WHERE account_id = ? ORDER BY requested_at DESC LIMIT 100`
  ).bind(accountId).all<OrderRow>();
  return result.results.map(toPublicOrder);
}

export async function getPortfolio(env: Env, accountId: string): Promise<{
  cashCents: number;
  version: number;
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
  return { cashCents: account.cashCents, version: account.version, positions: positions.results };
}

export async function executeOrder(env: Env, command: OrderCommand): Promise<void> {
  const order = await findOrder(env, command.orderId, command.accountId);
  if (!order || order.status === "FILLED" || order.status === "REJECTED") return;

  const claimed = await env.DB.prepare(
    "UPDATE orders SET status = 'PROCESSING', updated_at = ? WHERE id = ? AND account_id = ? AND status = 'PENDING'"
  ).bind(new Date().toISOString(), order.id, order.accountId).run();
  if (claimed.meta.changes !== 1 && order.status !== "PROCESSING") return;

  let priceCents: number;
  try {
    priceCents = await new AlpacaMarketData(env).latestPriceCents(order.symbol);
  } catch (error) {
    await env.DB.prepare(
      "UPDATE orders SET status = 'PENDING', updated_at = ? WHERE id = ? AND status = 'PROCESSING'"
    ).bind(new Date().toISOString(), order.id).run();
    throw error;
  }

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
      env.DB.prepare("UPDATE accounts SET cash_cents = cash_cents - ?, version = version + 1 WHERE id = ? AND cash_cents >= ?")
        .bind(plan.totalCents, order.accountId, plan.totalCents),
      env.DB.prepare(
        `INSERT INTO positions (account_id, symbol, quantity, average_cost_cents, version)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(account_id, symbol) DO UPDATE SET
           quantity = excluded.quantity,
           average_cost_cents = excluded.average_cost_cents,
           version = positions.version + 1`
      ).bind(order.accountId, order.symbol, plan.nextQuantity, plan.nextAverageCostCents),
      fillOrderStatement(env, order.id, priceCents, now),
      insertTradeStatement(env, tradeId, order, priceCents, now)
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare("UPDATE accounts SET cash_cents = cash_cents + ?, version = version + 1 WHERE id = ?")
        .bind(plan.totalCents, order.accountId),
      env.DB.prepare(
        "UPDATE positions SET quantity = quantity - ?, version = version + 1 WHERE account_id = ? AND symbol = ? AND quantity >= ?"
      ).bind(order.quantity, order.accountId, order.symbol, order.quantity),
      fillOrderStatement(env, order.id, priceCents, now),
      insertTradeStatement(env, tradeId, order, priceCents, now)
    ]);
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

function fillOrderStatement(env: Env, orderId: string, priceCents: number, now: string): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE orders SET status = 'FILLED', filled_price_cents = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING'"
  ).bind(priceCents, now, orderId);
}

function insertTradeStatement(env: Env, tradeId: string, order: OrderRow, priceCents: number, now: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO trades (id, order_id, account_id, symbol, side, quantity, price_cents, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(tradeId, order.id, order.accountId, order.symbol, order.side, order.quantity, priceCents, now);
}

function toPublicOrder(order: OrderRow): PublicOrder {
  const { accountId: _accountId, idempotencyKey: _idempotencyKey, ...safe } = order;
  return safe;
}
