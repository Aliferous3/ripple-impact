import { loadSession } from "./session.js";

export function run(fn: (id: string) => string): string {
  return fn("x");
}

export function runSessionLoad(): string {
  return run(loadSession);
}
