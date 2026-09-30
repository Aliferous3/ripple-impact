import { authenticateRequest, type Request } from "../auth/authenticate.js";
import type { Session } from "../auth/session.js";

export function checkout(request: Request): Session {
  const session = authenticateRequest(request);
  return session;
}
