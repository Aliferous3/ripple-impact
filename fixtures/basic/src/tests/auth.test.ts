import { authenticateRequest } from "../auth/authenticate.js";

export function testAuthenticateRequest(): void {
  const session = authenticateRequest({ sessionId: "s1" });
  if (session.id !== "s1") {
    throw new Error("expected session id to be preserved");
  }
}
