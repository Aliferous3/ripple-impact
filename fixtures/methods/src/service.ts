import { Session, type Refresher } from "./session.js";

export function handleRequest(): number {
  const session = new Session();
  return session.refresh();
}

// Calls through the interface type: statically resolves to Refresher#refresh,
// but at runtime it may dispatch to Session#refresh.
export function handleTyped(refresher: Refresher): number {
  return refresher.refresh();
}
