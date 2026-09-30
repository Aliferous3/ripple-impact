import { refreshSession, type Session } from "./session.js";

export interface Request {
  sessionId: string;
}

export function authenticateRequest(request: Request): Session {
  const session = refreshSession(request.sessionId);
  return session;
}
