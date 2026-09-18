import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, api, ensureSession } from "../src/client/api";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("browser API client", () => {
  it("uses the documented market route", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ symbol: "BRK.B" }));
    vi.stubGlobal("fetch", fetcher);
    await api.market("BRK.B", "1mo");
    expect(fetcher).toHaveBeenCalledWith("/api/market/BRK.B?period=1mo", { credentials: "same-origin" });
  });

  it("sends only trusted paper-order inputs", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ order: { id: "order-1" }, replayed: false }, 202));
    vi.stubGlobal("fetch", fetcher);
    await api.submitOrder({ symbol: "NVDA", side: "BUY", quantity: 2, idempotencyKey: "idempotency-key-123456" });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      symbol: "NVDA",
      side: "BUY",
      quantity: 2,
      idempotencyKey: "idempotency-key-123456"
    });
    expect(init.body).not.toContain("price");
    expect(init.body).not.toContain("balance");
    expect(init.body).not.toContain("accountId");
  });

  it("creates a session only after an authentication failure", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: { code: "SESSION_REQUIRED", message: "missing" } }, 401))
      .mockResolvedValueOnce(response({ session: { expiresAt: "future" } }, 201));
    vi.stubGlobal("fetch", fetcher);
    await ensureSession();
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/session", { credentials: "same-origin" });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/session", { credentials: "same-origin", method: "POST" });
  });

  it("preserves structured API error details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: { code: "INVALID_SYMBOL", message: "symbol format is invalid", requestId: "request-1" }
    }, 400)));
    await expect(api.market("bad symbol", "1mo")).rejects.toEqual(
      new ApiClientError(400, "INVALID_SYMBOL", "symbol format is invalid", "request-1")
    );
  });
});
