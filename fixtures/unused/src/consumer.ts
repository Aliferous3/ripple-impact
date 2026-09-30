import { expensiveHelper } from "./helper.js";

export function unrelatedConsumer(n: number): number {
  return n + 1;
}

export function helperIsReferenced(): (n: number) => number {
  return expensiveHelper;
}
