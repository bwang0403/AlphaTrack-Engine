import { describe, expect, it } from "vitest";
import { ApiError } from "../src/worker/http";
import { parseOrder, parsePeriod, parseSymbol } from "../src/worker/validation";

describe("request validation", () => {
  it("normalizes valid symbols", () => {
    expect(parseSymbol(" brk.b ")).toBe("BRK.B");
  });

  it.each(["", "AAPL,MSFT", "../AAPL", "AAPL USD", "AAPL&action=buy"])("rejects unsafe symbol %s", symbol => {
    expect(() => parseSymbol(symbol)).toThrow(ApiError);
  });

  it("allows only documented periods", () => {
    expect(parsePeriod(null)).toBe("1mo");
    expect(parsePeriod("6MO")).toBe("6mo");
    expect(() => parsePeriod("max")).toThrowError("period is not supported");
  });

  it("accepts a complete whole-share paper order", () => {
    expect(parseOrder({ symbol: "nvda", side: "buy", quantity: 2, idempotencyKey: "order_1234567890abcdef" })).toEqual({
      symbol: "NVDA",
      side: "BUY",
      quantity: 2,
      idempotencyKey: "order_1234567890abcdef"
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", 100001])("rejects malformed quantity %s", quantity => {
    expect(() => parseOrder({ symbol: "NVDA", side: "BUY", quantity, idempotencyKey: "order_1234567890abcdef" })).toThrowError(
      "quantity must be a positive whole number"
    );
  });

  it("rejects client fields that cannot form a valid order boundary", () => {
    expect(() => parseOrder({ symbol: "NVDA", side: "HOLD", quantity: 1, idempotencyKey: "order_1234567890abcdef" })).toThrowError("side must be BUY or SELL");
    expect(() => parseOrder({ symbol: "NVDA", side: "BUY", quantity: 1, idempotencyKey: "short" })).toThrowError("idempotencyKey");
  });
});
