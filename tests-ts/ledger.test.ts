import { describe, expect, it } from "vitest";
import { planExecution } from "../src/worker/ledger";

describe("paper-trading ledger policy", () => {
  it("debits cash and opens a position using integer cents", () => {
    expect(planExecution({ side: "BUY", quantity: 3, priceCents: 12345, cashCents: 100000, position: null })).toEqual({
      accepted: true,
      cashDeltaCents: -37035,
      nextQuantity: 3,
      nextAverageCostCents: 12345,
      totalCents: 37035
    });
  });

  it("calculates a weighted average cost for additional buys", () => {
    const plan = planExecution({
      side: "BUY",
      quantity: 2,
      priceCents: 15000,
      cashCents: 100000,
      position: { quantity: 2, averageCostCents: 10000 }
    });
    expect(plan).toMatchObject({ accepted: true, nextQuantity: 4, nextAverageCostCents: 12500 });
  });

  it("rejects a buy without sufficient server-side cash", () => {
    expect(planExecution({ side: "BUY", quantity: 2, priceCents: 6000, cashCents: 10000, position: null })).toEqual({
      accepted: false,
      reason: "Insufficient buying power"
    });
  });

  it("credits cash and preserves cost basis on a partial sale", () => {
    expect(planExecution({
      side: "SELL",
      quantity: 2,
      priceCents: 12000,
      cashCents: 5000,
      position: { quantity: 5, averageCostCents: 10000 }
    })).toEqual({
      accepted: true,
      cashDeltaCents: 24000,
      nextQuantity: 3,
      nextAverageCostCents: 10000,
      totalCents: 24000
    });
  });

  it("rejects overselling and selling an absent position", () => {
    expect(planExecution({ side: "SELL", quantity: 6, priceCents: 12000, cashCents: 0, position: { quantity: 5, averageCostCents: 10000 } })).toEqual({
      accepted: false,
      reason: "Insufficient shares"
    });
    expect(planExecution({ side: "SELL", quantity: 1, priceCents: 12000, cashCents: 0, position: null })).toEqual({
      accepted: false,
      reason: "Insufficient shares"
    });
  });

  it("rejects unsafe monetary arithmetic", () => {
    expect(() => planExecution({ side: "BUY", quantity: Number.MAX_SAFE_INTEGER, priceCents: 2, cashCents: Number.MAX_SAFE_INTEGER, position: null })).toThrowError(
      "Order value is outside the supported range"
    );
  });
});
