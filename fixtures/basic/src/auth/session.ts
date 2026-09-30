export interface Session {
  id: string;
  expiresAt: number;
}

export function refreshSession(sessionId: string): Session {
  return { id: sessionId, expiresAt: Date.now() + 3600_000 };
}
