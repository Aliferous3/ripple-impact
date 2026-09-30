import { renderToken } from "./middle.js";

export function consumer(raw: string): string {
  return renderToken(raw);
}
