import { ApiError } from "./http";
import type { OrderSide } from "./types";

export interface LedgerPosition {
  quantity: number;
  averageCostCents: number;
}

export type ExecutionPlan =
  | { accepted: false; reason: "Insufficient buying power" | "Insufficient shares" }
  | {
      accepted: true;
      cashDeltaCents: number;
      nextQuantity: number;
      nextAverageCostCents: number;
      totalCents: number;
    };

export function planExecution(input: {
  side: OrderSide;
  quantity: number;
  priceCents: number;
  cashCents: number;
  position: LedgerPosition | null;
}): ExecutionPlan {
  const totalCents = safeAmount(input.priceCents, input.quantity);
  if (input.side === "BUY") {
    if (input.cashCents < totalCents) return { accepted: false, reason: "Insufficient buying power" };
    const oldQuantity = input.position?.quantity ?? 0;
    const nextQuantity = oldQuantity + input.quantity;
    const nextAverageCostCents = Math.round(
      (((input.position?.averageCostCents ?? 0) * oldQuantity) + totalCents) / nextQuantity
    );
    return { accepted: true, cashDeltaCents: -totalCents, nextQuantity, nextAverageCostCents, totalCents };
  }

  if (!input.position || input.position.quantity < input.quantity) {
    return { accepted: false, reason: "Insufficient shares" };
  }
  return {
    accepted: true,
    cashDeltaCents: totalCents,
    nextQuantity: input.position.quantity - input.quantity,
    nextAverageCostCents: input.position.averageCostCents,
    totalCents
  };
}

function safeAmount(priceCents: number, quantity: number): number {
  const amount = priceCents * quantity;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(amount)) {
    throw new ApiError(422, "ORDER_VALUE_INVALID", "Order value is outside the supported range");
  }
  return amount;
}
