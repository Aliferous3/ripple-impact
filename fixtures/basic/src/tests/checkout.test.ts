import { checkout } from "../checkout/checkout.js";

export function testCheckout(): void {
  const session = checkout({ sessionId: "s2" });
  if (!session.expiresAt) {
    throw new Error("expected an expiry");
  }
}
