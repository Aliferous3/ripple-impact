import { checkout } from "../checkout/checkout.js";
import type { Request } from "../auth/authenticate.js";
import type { Session } from "../auth/session.js";

export function completePayment(request: Request): Session {
  const session = checkout(request);
  return session;
}
