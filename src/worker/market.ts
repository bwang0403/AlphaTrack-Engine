import { ApiError } from "./http";
import type { Bar, Env, MarketSnapshot, Period } from "./types";

const LOOKBACK_DAYS: Record<Period, number> = {
  "5d": 10,
  "1mo": 40,
  "3mo": 110,
  "6mo": 220,
  "1y": 400
};

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
}

interface AlpacaSnapshotResponse {
  latestTrade?: { p: number; t: string };
  prevDailyBar?: { c: number };
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AlpacaMarketData {
  constructor(
    private readonly env: Env,
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init)
  ) {}

  async history(symbol: string, period: Period): Promise<MarketSnapshot> {
    const end = new Date();
    const start = new Date(end.getTime() - LOOKBACK_DAYS[period] * 86_400_000);
    const url = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, this.env.ALPACA_DATA_BASE_URL);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", start.toISOString());
    url.searchParams.set("end", end.toISOString());
    url.searchParams.set("feed", "iex");
    url.searchParams.set("adjustment", "all");
    url.searchParams.set("limit", "1000");
    const [payload, snapshot] = await Promise.all([
      this.request<AlpacaBarsResponse>(url),
      this.snapshot(symbol)
    ]);
    const bars = (payload.bars ?? []).map(normalizeBar);
    if (bars.length < 2) {
      throw new ApiError(404, "MARKET_DATA_NOT_FOUND", `No usable market data was found for ${symbol}`);
    }

    const price = positive(snapshot.latestTrade?.p);
    const previousClose = positive(snapshot.prevDailyBar?.c);
    const asOf = validTimestamp(snapshot.latestTrade?.t);
    const receivedAt = new Date().toISOString();
    const ageMs = Date.now() - new Date(asOf).getTime();
    const freshness = ageMs >= 0 && ageMs <= 60_000 ? "LIVE" : ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000 ? "DELAYED" : "STALE";
    const change = price - previousClose;

    return {
      symbol,
      price,
      change: finite(change),
      changePercent: finite((change / previousClose) * 100),
      asOf,
      receivedAt,
      provider: "alpaca-iex",
      feed: "iex",
      freshness,
      bars
    };
  }

  async latestPriceCents(symbol: string): Promise<number> {
    const snapshot = await this.snapshot(symbol);
    validTimestamp(snapshot.latestTrade?.t);
    return Math.round(positive(snapshot.latestTrade?.p) * 100);
  }

  private async snapshot(symbol: string): Promise<AlpacaSnapshotResponse> {
    const url = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, this.env.ALPACA_DATA_BASE_URL);
    url.searchParams.set("feed", "iex");
    return this.request<AlpacaSnapshotResponse>(url);
  }

  private async request<T>(url: URL): Promise<T> {
    if (!this.env.ALPACA_API_KEY_ID || !this.env.ALPACA_API_SECRET_KEY) {
      throw new ApiError(503, "PROVIDER_NOT_CONFIGURED", "Live market data credentials are not configured");
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          "APCA-API-KEY-ID": this.env.ALPACA_API_KEY_ID,
          "APCA-API-SECRET-KEY": this.env.ALPACA_API_SECRET_KEY,
          "accept": "application/json"
        },
        signal: AbortSignal.timeout(8000)
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "market.provider_unavailable",
        provider: "alpaca-iex",
        cause: error instanceof Error ? error.message : "unknown"
      }));
      throw new ApiError(503, "PROVIDER_UNAVAILABLE", "Market data provider could not be reached");
    }
    if (!response.ok) {
      throw new ApiError(502, "PROVIDER_ERROR", `Market data provider returned HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}

function normalizeBar(bar: AlpacaBar): Bar {
  return {
    timestamp: validTimestamp(bar.t),
    open: positive(bar.o),
    high: positive(bar.h),
    low: positive(bar.l),
    close: positive(bar.c),
    volume: nonnegative(bar.v)
  };
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(502, "INVALID_PROVIDER_DATA", "Market data provider returned a non-finite value");
  }
  return Math.round(value * 10000) / 10000;
}

function positive(value: unknown): number {
  const number = finite(value);
  if (number <= 0) throw new ApiError(502, "INVALID_PROVIDER_DATA", "Market data provider returned a non-positive price");
  return number;
}

function nonnegative(value: unknown): number {
  const number = finite(value);
  if (number < 0) throw new ApiError(502, "INVALID_PROVIDER_DATA", "Market data provider returned a negative volume");
  return number;
}

function validTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ApiError(502, "INVALID_PROVIDER_DATA", "Market data provider returned an invalid timestamp");
  }
  return value;
}
