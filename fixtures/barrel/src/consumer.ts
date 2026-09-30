import { normalizePath } from "./lib/index.js";

export function consumer(input: string): string {
  return normalizePath(input);
}
