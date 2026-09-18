export type Period = "5d" | "1mo" | "3mo" | "6mo" | "1y";
export type OrderSide = "BUY" | "SELL";
export type OrderStatus = "PENDING" | "PROCESSING" | "FILLED" | "REJECTED";

export interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  asOf: string;
  receivedAt: string;
  provider: "alpaca-iex";
  feed: "iex";
  freshness: "LIVE" | "DELAYED" | "STALE";
  bars: Bar[];
}

export interface OrderCommand {
  orderId: string;
  accountId: string;
}

export interface Env {
  DB: D1Database;
  ORDER_QUEUE: Queue<OrderCommand>;
  ASSETS: Fetcher;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_BASE_URL: string;
  SESSION_PEPPER?: string;
  APP_ENV: string;
}
