import { ApiError } from "./http";
import type { OrderSide, Period } from "./types";

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const PERIODS = new Set<Period>(["5d", "1mo", "3mo", "6mo", "1y"]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/;

export function parseSymbol(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_SYMBOL", "symbol must be a string");
  }
  const symbol = value.trim().toUpperCase();
  if (!SYMBOL.test(symbol)) {
    throw new ApiError(400, "INVALID_SYMBOL", "symbol format is invalid");
  }
  return symbol;
}

export function parsePeriod(value: string | null): Period {
  const period = (value ?? "1mo").toLowerCase() as Period;
  if (!PERIODS.has(period)) {
    throw new ApiError(400, "INVALID_PERIOD", "period is not supported");
  }
  return period;
}

export function parseOrder(body: Record<string, unknown>): {
  symbol: string;
  side: OrderSide;
  quantity: number;
  idempotencyKey: string;
} {
  const symbol = parseSymbol(body.symbol);
  const side = typeof body.side === "string" ? body.side.toUpperCase() : "";
  if (side !== "BUY" && side !== "SELL") {
    throw new ApiError(400, "INVALID_SIDE", "side must be BUY or SELL");
  }
  if (typeof body.quantity !== "number" || !Number.isSafeInteger(body.quantity) || body.quantity <= 0 || body.quantity > 100000) {
    throw new ApiError(400, "INVALID_QUANTITY", "quantity must be a positive whole number no greater than 100000");
  }
  if (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
    throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "idempotencyKey must contain 16 to 128 safe characters");
  }
  return { symbol, side, quantity: body.quantity, idempotencyKey: body.idempotencyKey };
}
