import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/worker/http";
import { AlpacaMarketData } from "../src/worker/market";
import type { Env } from "../src/worker/types";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    ALPACA_DATA_BASE_URL: "https://data.alpaca.markets",
    ALPACA_API_KEY_ID: "test-key",
    ALPACA_API_SECRET_KEY: "test-secret",
    SESSION_PEPPER: "test-pepper",
    APP_ENV: "test",
    DB: {} as D1Database,
    ORDER_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ...overrides
  };
}

function providerResponse(bars: unknown[]): Response {
  return new Response(JSON.stringify({ bars }), { status: 200, headers: { "content-type": "application/json" } });
}

function snapshotResponse(price = 105, previousClose = 102): Response {
  return new Response(JSON.stringify({
    latestTrade: { p: price, t: "2026-09-16T20:00:00Z" },
    prevDailyBar: { c: previousClose }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function successfulFetcher(bars: unknown[], price = 105, previousClose = 102) {
  return vi.fn().mockImplementation((input: URL) =>
    input.pathname.endsWith("/snapshot") ? Promise.resolve(snapshotResponse(price, previousClose)) : Promise.resolve(providerResponse(bars))
  );
}

describe("Alpaca market-data adapter", () => {
  it("fails closed when credentials are absent", async () => {
    const fetcher = vi.fn();
    const provider = new AlpacaMarketData(environment({ ALPACA_API_KEY_ID: undefined }), fetcher);
    await expect(provider.history("NVDA", "1mo")).rejects.toMatchObject({ status: 503, code: "PROVIDER_NOT_CONFIGURED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes provider bars and exposes provenance", async () => {
    const fetcher = successfulFetcher([
      { t: "2026-09-15T20:00:00Z", o: 100, h: 104, l: 99, c: 102, v: 1000 },
      { t: "2026-09-16T20:00:00Z", o: 102, h: 107, l: 101, c: 105, v: 1200 }
    ]);
    const snapshot = await new AlpacaMarketData(environment(), fetcher).history("NVDA", "5d");
    expect(snapshot).toMatchObject({ symbol: "NVDA", price: 105, change: 3, provider: "alpaca-iex", feed: "iex" });
    expect(snapshot.bars).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toMatch(/NaN|Infinity/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls as [URL, RequestInit][]) {
      expect(url.searchParams.get("feed")).toBe("iex");
      expect((init.headers as Record<string, string>)["APCA-API-KEY-ID"]).toBe("test-key");
    }
  });

  it("rejects non-finite provider values instead of emitting invalid JSON", async () => {
    const fetcher = successfulFetcher([
      { t: "2026-09-15T20:00:00Z", o: 100, h: 104, l: 99, c: 102, v: 1000 },
      { t: "2026-09-16T20:00:00Z", o: 102, h: 107, l: 101, c: Number.NaN, v: 1200 }
    ]);
    await expect(new AlpacaMarketData(environment(), fetcher).history("NVDA", "5d")).rejects.toBeInstanceOf(ApiError);
  });

  it("does not fabricate data for empty provider results", async () => {
    const fetcher = successfulFetcher([]);
    await expect(new AlpacaMarketData(environment(), fetcher).history("NVDA", "5d")).rejects.toMatchObject({ status: 404, code: "MARKET_DATA_NOT_FOUND" });
  });

  it("rejects invalid latest-trade data", async () => {
    for (const price of [Number.NaN, 0, -1]) {
      const fetcher = successfulFetcher([
        { t: "2026-09-15T20:00:00Z", o: 100, h: 104, l: 99, c: 102, v: 1000 },
        { t: "2026-09-16T20:00:00Z", o: 102, h: 107, l: 101, c: 105, v: 1200 }
      ], price);
      await expect(new AlpacaMarketData(environment(), fetcher).history("NVDA", "5d")).rejects.toMatchObject({ code: "INVALID_PROVIDER_DATA" });
    }
  });

  it("maps upstream and network failures to explicit service errors", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("denied", { status: 429 }));
    await expect(new AlpacaMarketData(environment(), upstream).history("NVDA", "5d")).rejects.toMatchObject({ status: 502, code: "PROVIDER_ERROR" });
    const offline = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(new AlpacaMarketData(environment(), offline).history("NVDA", "5d")).rejects.toMatchObject({ status: 503, code: "PROVIDER_UNAVAILABLE" });
  });
});
