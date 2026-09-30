import { fetchSession } from "./session.js";

export async function handleAsyncRequest(id: string): Promise<string> {
  const session = await fetchSession(id);
  return session;
}
