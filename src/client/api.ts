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

export interface Position {
  symbol: string;
  quantity: number;
  averageCostCents: number;
  version: number;
}

export interface Portfolio {
  cashCents: number;
  version: number;
  positions: Position[];
}

export interface Order {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  status: "PENDING" | "PROCESSING" | "FILLED" | "REJECTED";
  requestedAt: string;
  updatedAt: string;
  filledPriceCents: number | null;
  rejectionReason: string | null;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string };
}

export class ApiClientError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const options = { credentials: "same-origin", ...init } as Parameters<typeof fetch>[1];
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({})) as T & ErrorEnvelope;
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      payload.error?.code ?? "REQUEST_FAILED",
      payload.error?.message ?? `Request failed with HTTP ${response.status}`,
      payload.error?.requestId ?? response.headers.get("x-request-id") ?? undefined
    );
  }
  return payload;
}

export async function ensureSession(): Promise<void> {
  try {
    await request("/api/session");
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 401) throw error;
    await request("/api/session", { method: "POST" });
  }
}

export const api = {
  market: (symbol: string, period: string) => request<MarketSnapshot>(`/api/market/${encodeURIComponent(symbol)}?period=${encodeURIComponent(period)}`),
  portfolio: () => request<Portfolio>("/api/portfolio"),
  orders: () => request<{ orders: Order[] }>("/api/orders"),
  health: () => request<{ status: string; environment: string; timestamp: string }>("/api/health"),
  submitOrder: (body: { symbol: string; side: "BUY" | "SELL"; quantity: number; idempotencyKey: string }) =>
    request<{ order: Order; replayed: boolean }>("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
};
